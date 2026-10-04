import { createHash } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { apiKeys, membershipAuditLog } from "../../../src/server/db/schema";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { createApiKey, listApiKeys } from "../../../src/server/services/api-keys";
import { recentActivity } from "../../../src/server/services/members";
import { api } from "../../helpers/api";
import { closeDb, testDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});

describe("show-once (FR-006, SC-005)", () => {
  it("returns the secret once; it authenticates; nothing else ever holds it", async () => {
    const logged: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      }),
    );
    try {
      const env = await postsEnv();
      const created = await createApiKey(env.scope, {
        name: "n8n",
        permissions: ["read", "write_posts"],
        rateLimitPerMinute: 60,
        expiry: "never",
      });
      const { secret, key } = created;
      expect(secret).toMatch(/^dkt_[A-Za-z0-9_-]{43}$/);
      expect(key.display).toBe(`dkt_…${secret.slice(-4)}`);
      expect(JSON.stringify(key)).not.toContain(secret);

      expect((await api("GET", "/accounts", { key: secret })).status).toBe(200);

      const list = await listApiKeys(env.scope);
      expect(JSON.stringify(list)).not.toContain(secret);
      expect(list.find((k) => k.id === key.id)?.display).toBe(key.display);
      const activity = await recentActivity(env.scope, 50);
      expect(JSON.stringify(activity)).not.toContain(secret);
      expect(activity.some((a) => a.action === "api_key_create")).toBe(true);

      const hash = createHash("sha256").update(secret, "utf8").digest("hex");
      const hits = await runCrossProject("test: scan all tables for the key", async () => {
        const db = testDb();
        const tables = await db.execute<{ table_name: string }>(
          sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
        );
        const found: { plain: string[]; hash: string[] } = { plain: [], hash: [] };
        for (const { table_name } of tables.rows) {
          const dump = await db.execute<{ r: string }>(sql.raw(`select t::text as r from "${table_name}" t`));
          for (const row of dump.rows) {
            if (row.r.includes(secret)) found.plain.push(table_name);
            if (row.r.includes(hash)) found.hash.push(table_name);
          }
        }
        return found;
      });
      expect(hits.plain).toEqual([]);
      expect(hits.hash).toEqual(["api_keys"]);

      const [row] = await runCrossProject("test: read the stored key", () =>
        testDb().select().from(apiKeys).where(and(eq(apiKeys.projectId, env.project.id), eq(apiKeys.id, key.id))),
      );
      expect(row!.keyHash).toBe(hash);
      expect(row!.last4).toBe(secret.slice(-4));
      const audit = await runCrossProject("test: audit rows", () =>
        testDb().select().from(membershipAuditLog).where(eq(membershipAuditLog.projectId, env.project.id)),
      );
      expect(JSON.stringify(audit)).not.toContain(secret);

      expect(logged.join("\n")).not.toContain(secret);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it("generates a different key every time", async () => {
    const env = await postsEnv();
    const input = { name: "k", permissions: ["read"], rateLimitPerMinute: 60, expiry: "never" };
    const a = await createApiKey(env.scope, input);
    const b = await createApiKey(env.scope, input);
    expect(a.secret).not.toBe(b.secret);
  });
});
