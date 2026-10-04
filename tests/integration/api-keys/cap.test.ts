import { afterAll, describe, expect, it } from "vitest";
import { ConflictError, ForbiddenError } from "../../../src/server/dal/errors";
import { createApiKey, listApiKeys, revokeApiKey } from "../../../src/server/services/api-keys";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});

const input = (name: string) => ({ name, permissions: ["read"], rateLimitPerMinute: 60, expiry: "never" });

describe("the 25 active key cap", () => {
  it("refuses the 26th key, and a revoked key frees a place", async () => {
    const env = await postsEnv();
    const made = [];
    for (let i = 0; i < 25; i++) made.push(await createApiKey(env.scope, input(`k${i}`)));
    const err = await createApiKey(env.scope, input("k25")).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toBe("A project can have at most 25 active keys. Revoke one first.");
    await revokeApiKey(env.scope, made[0]!.key.id);
    await expect(createApiKey(env.scope, input("k26"))).resolves.toBeTruthy();
  });

  it("lets only one of two concurrent creates at 24 succeed", async () => {
    const env = await postsEnv();
    for (let i = 0; i < 24; i++) await createApiKey(env.scope, input(`k${i}`));
    const results = await Promise.allSettled([createApiKey(env.scope, input("a")), createApiKey(env.scope, input("b"))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictError);
    expect(await listApiKeys(env.scope)).toHaveLength(25);
  });

  it("refuses an editor, and allows an admin", async () => {
    const env = await postsEnv();
    const editor = await env.as(env.editor);
    await expect(createApiKey(editor, input("x"))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listApiKeys(editor)).rejects.toBeInstanceOf(ForbiddenError);
    const admin = await env.as(env.admin);
    await expect(createApiKey(admin, input("by-admin"))).resolves.toBeTruthy();
  });

  it("rejects invalid input with a field error", async () => {
    const env = await postsEnv();
    await expect(createApiKey(env.scope, { name: "", permissions: [], rateLimitPerMinute: 5000, expiry: "7" })).rejects.toThrow();
  });
});
