import { afterAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { forProject } from "../../src/server/dal/scope";
import { bootstrapFirstUser } from "../../src/server/dal/install";
import { runCrossProject } from "../../src/server/db/cross-project";
import * as invitations from "../../src/server/services/invitations";
import * as members from "../../src/server/services/members";
import { fakeSession } from "../helpers/auth";
import { closeDb, createThrowawayDb, testDb } from "../helpers/db";
import { createProjectWithMembers } from "../helpers/factories";

afterAll(async () => {
  await closeDb();
});

const PASSWORD = "plaintext-canary-password-1";
const SETUP_PASSWORD = "setup-canary-password-2";

describe("SC-009: no plaintext secrets at rest or in logs", () => {
  it("never stores or logs tokens, passwords or the encryption key", async () => {
    const logged: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      }),
    );
    const secrets: string[] = [PASSWORD, SETUP_PASSWORD, process.env.CREDENTIALS_ENCRYPTION_KEY!, process.env.BETTER_AUTH_SECRET!];
    const tmp = await createThrowawayDb();
    try {
      // Setup flow (isolated database).
      await bootstrapFirstUser({ name: "Setup", email: "setup@example.test", password: SETUP_PASSWORD }, tmp.db);

      // Invitation, regenerate, sign-up and member flows.
      const ctx = await createProjectWithMembers();
      const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
      const first = await invitations.create(scope, { email: `canary-${Date.now()}@example.test`, role: "editor" });
      if (first.delivery.kind !== "manual_link") throw new Error("expected a manual link");
      const firstToken = new URL(first.delivery.url).searchParams.get("token")!;
      const next = await invitations.regenerate(scope, { invitationId: first.invitationId });
      if (next.delivery.kind !== "manual_link") throw new Error("expected a manual link");
      const token = new URL(next.delivery.url).searchParams.get("token")!;
      secrets.push(firstToken, token);
      const { userId } = await invitations.signUp({ token, name: "Canary", password: PASSWORD });
      const owner = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
      await members.changeRole(owner, { userId, role: "admin" });
      await members.remove(owner, { userId });

      // Scan every table (both databases) as text.
      const scan = async (db: ReturnType<typeof testDb>) => {
        const tables = await db.execute<{ table_name: string }>(
          sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
        );
        const hits: string[] = [];
        for (const { table_name } of tables.rows) {
          const dump = await db.execute<{ r: string }>(sql.raw(`select t::text as r from "${table_name}" t`));
          for (const row of dump.rows) for (const s of secrets) if (row.r.includes(s)) hits.push(`${table_name} contains a secret`);
        }
        return hits;
      };
      const hits = [
        ...(await runCrossProject("test: scan all tables for plaintext", () => scan(testDb()))),
        ...(await runCrossProject("test: scan all tables for plaintext", () => scan(tmp.db))),
      ];
      expect(hits).toEqual([]);

      const logText = logged.join("\n");
      for (const s of secrets) expect(logText.includes(s)).toBe(false);
    } finally {
      spies.forEach((s) => s.mockRestore());
      await tmp.drop();
    }
  });
});
