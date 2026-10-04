import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { InvalidApiKeyError, NotFoundError } from "../../../src/server/dal/errors";
import { forApiKey } from "../../../src/server/dal/scope";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { membershipAuditLog } from "../../../src/server/db/schema";
import { listApiKeys, revokeApiKey } from "../../../src/server/services/api-keys";
import { api, createKey } from "../../helpers/api";
import { closeDb, testDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});

const revokeRows = (projectId: string) =>
  runCrossProject("test: audit rows", async () =>
    (await testDb().select().from(membershipAuditLog).where(eq(membershipAuditLog.projectId, projectId))).filter(
      (r) => r.action === "api_key_revoke",
    ),
  );

describe("revoking a key", () => {
  it("stops the very next request, and a second revoke changes nothing", async () => {
    const env = await postsEnv();
    const key = await createKey(env.scope, ["read"]);
    expect((await api("GET", "/accounts", { key: key.secret })).status).toBe(200);

    expect(await revokeApiKey(env.scope, key.id)).toEqual({ revoked: true });
    const after = await api("GET", "/accounts", { key: key.secret });
    expect(after.status).toBe(401);
    expect(after.json.error.code).toBe("invalid_api_key");

    const again = await revokeApiKey(env.scope, key.id);
    expect(again).toEqual({ revoked: false, message: "This key was already revoked." });
    expect(await revokeRows(env.project.id)).toHaveLength(1);

    const listed = (await listApiKeys(env.scope)).find((k) => k.id === key.id)!;
    expect(listed.status).toBe("revoked");
    expect(listed.revokedBy).toBeTruthy();
  });

  it("writes one audit row for 20 parallel revokes", async () => {
    const env = await postsEnv();
    const key = await createKey(env.scope, ["read"]);
    const results = await Promise.all(Array.from({ length: 20 }, () => revokeApiKey(env.scope, key.id)));
    expect(results.filter((r) => r.revoked)).toHaveLength(1);
    expect(await revokeRows(env.project.id)).toHaveLength(1);
  });

  it("commits nothing for a request revoked before its transaction commits", async () => {
    const env = await postsEnv();
    const key = await createKey(env.scope, ["read", "write_posts"]);
    const { scope } = await forApiKey(key.secret); // authenticated, then the key is revoked mid-request
    await revokeApiKey(env.scope, key.id);
    const err = await scope
      .transaction(async (tx) => {
        await tx.audit.insert({ action: "role_change", actorUserId: null, details: { marker: "in-flight" } });
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(InvalidApiKeyError);
    const rows = await runCrossProject("test: audit rows", () =>
      testDb().select().from(membershipAuditLog).where(eq(membershipAuditLog.projectId, env.project.id)),
    );
    expect(rows.some((r) => (r.details as { marker?: string }).marker === "in-flight")).toBe(false);
  });

  it("answers an unknown or malformed key id with not found, and cannot reach another project's key", async () => {
    const a = await postsEnv();
    const b = await postsEnv();
    const other = await createKey(b.scope, ["read"]);
    await expect(revokeApiKey(a.scope, other.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(revokeApiKey(a.scope, "not-a-uuid")).rejects.toBeInstanceOf(NotFoundError);
    expect((await api("GET", "/accounts", { key: other.secret })).status).toBe(200);
  });
});
