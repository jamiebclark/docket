import { afterAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { forProject } from "../../src/server/dal/scope";
import { bootstrapFirstUser } from "../../src/server/dal/install";
import { runCrossProject } from "../../src/server/db/cross-project";
import * as invitations from "../../src/server/services/invitations";
import * as members from "../../src/server/services/members";
import * as accounts from "../../src/server/services/accounts";
import * as posts from "../../src/server/services/posts";
import * as slots from "../../src/server/services/slots";
import { mockProvider } from "../../src/providers/mock";
import { runTick } from "../../src/server/scheduler";
import { atTime } from "../helpers/clock";
import { parkAllDueTargets } from "../helpers/scheduling";
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

describe("SC-012: no stored credentials in attempts, errors, summaries or listings", () => {
  const BEFORE = new Date("2026-10-01T12:00:00Z");
  const SLOT = new Date("2026-10-05T09:00:00Z");

  it("redacts a secret that a provider echoes in a thrown message, an error and a summary", async () => {
    await parkAllDueTargets();
    const logged: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      }),
    );
    const ctx = await createProjectWithMembers();
    const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
    const leaked: string[] = [];
    const modes = ["throw", "retryable_error", "fatal_error", "ambiguous"] as const;
    const advance = vi.spyOn(mockProvider, "advance");
    try {
      const targetIds: string[] = [];
      const postIds: string[] = [];
      for (const mode of modes) {
        const account = await accounts.connectMock(scope, { displayName: `Leaky ${mode}`, simulateCredentialExpiryHours: 48 });
        await slots.addSlot(scope, { accountId: account.id, weekday: 1, localTime: "09:00" });
        advance.mockImplementationOnce(async (c) => {
          const secret = (c.account.credentials as { token: string }).token;
          leaked.push(secret);
          const message = `request failed with Bearer ${secret}`;
          if (mode === "throw") throw new Error(message);
          return {
            kind: mode,
            error: message,
            summary: { request: { note: message }, response: { body: message, token: secret } },
          };
        });
        const draft = await posts.createDraft(scope, { baseText: `Leak ${mode}`, targets: [{ accountId: account.id }] });
        await atTime(BEFORE, () => posts.addToQueue(scope, draft.post.id, {}));
        postIds.push(draft.post.id);
        targetIds.push(draft.targets[0]!.id);
        // One at a time so each mocked call lands on its own account.
        const tick = await atTime(SLOT, () => runTick({ config: { refreshMaxAccounts: 0 } }));
        expect(JSON.stringify(tick)).not.toContain(leaked.at(-1)!);
      }
      expect(leaked).toHaveLength(modes.length);

      const surfaces: string[] = [JSON.stringify(await accounts.listAccounts(scope))];
      for (const [i, postId] of postIds.entries()) {
        surfaces.push(JSON.stringify(await posts.getPost(scope, postId)));
        surfaces.push(JSON.stringify(await posts.listAttempts(scope, targetIds[i]!)));
      }
      surfaces.push(logged.join("\n"));
      const stored = await runCrossProject("test: scan stored rows for credentials", async () => {
        const db = testDb();
        const out: string[] = [];
        for (const table of ["post_targets", "publish_attempts", "social_accounts"]) {
          const dump = await db.execute<{ r: string }>(sql.raw(`select t::text as r from "${table}" t`));
          out.push(...dump.rows.map((row) => row.r));
        }
        return out;
      });
      surfaces.push(...stored);
      for (const secret of leaked) for (const text of surfaces) expect(text.includes(secret)).toBe(false);
    } finally {
      advance.mockRestore();
      spies.forEach((s) => s.mockRestore());
    }
  });
});
