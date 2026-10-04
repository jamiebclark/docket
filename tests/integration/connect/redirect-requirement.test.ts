import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { connectAttempts } from "../../../src/server/db/schema";
import { ForbiddenError } from "../../../src/server/dal/errors";
import * as connect from "../../../src/server/services/connect";
import { closeDb, testDb } from "../../helpers/db";
import { registerThrowaway, sessionFor, strictGroup, unregisterThrowaway } from "../../helpers/connect-group";
import { postsEnv } from "../../helpers/posts-env";

beforeAll(registerThrowaway);
afterAll(async () => {
  unregisterThrowaway();
  await closeDb();
});

const REASON = strictGroup.redirectRequirement!.reason;

describe("callback-address requirement (G10)", () => {
  it("is unavailable under the http://localhost test address, with reason and doc", async () => {
    const env = await postsEnv();
    const groups = await connect.listConnectGroups(env.scope);
    expect(groups.find((g) => g.key === "throwaway-strict")).toMatchObject({
      configured: true,
      available: false,
      unavailable: { reason: REASON, doc: "docs/strict.md#https" },
    });
    expect(groups.find((g) => g.key === "throwaway")).toMatchObject({ available: true, unavailable: null });
  });

  it("is available when the address qualifies", async () => {
    const env = await postsEnv();
    const saved = strictGroup.redirectRequirement;
    strictGroup.redirectRequirement = { ...saved!, https: false, publicHost: false };
    try {
      const g = (await connect.listConnectGroups(env.scope)).find((x) => x.key === "throwaway-strict");
      expect(g).toMatchObject({ available: true, unavailable: null });
    } finally {
      strictGroup.redirectRequirement = saved;
    }
  });

  it("refuses a direct start server-side with no attempt row and no redirect URL", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    const before = await testDb().select().from(connectAttempts).where(eq(connectAttempts.projectId, env.project.id));
    const err = await connect.startOAuthConnect(env.scope, { groupKey: "throwaway-strict" }, session).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as Error).message).toBe(REASON);
    const after = await testDb().select().from(connectAttempts).where(eq(connectAttempts.projectId, env.project.id));
    expect(after.length).toBe(before.length);
  });

  it("refuses every role on an unavailable group: editors and non-managers for authority, owners and admins for the address", async () => {
    const env = await postsEnv();
    for (const user of [env.owner, env.admin, env.editor]) {
      const session = await sessionFor(user.id);
      const err = await connect.startOAuthConnect(await env.as(user), { groupKey: "throwaway-strict" }, session).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenError);
    }
  });

  it("still refuses an editor", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.editor.id);
    await expect(connect.startOAuthConnect(await env.as(env.editor), { groupKey: "throwaway-strict" }, session)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("leaves paste unchecked by the requirement", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    const r = await connect.pasteConnectToken(env.scope, { groupKey: "throwaway-strict", token: "T".repeat(20) }, session);
    // The group's exchange finds no accounts; the point is that the requirement did not refuse it.
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).not.toContain(REASON);
    expect(JSON.stringify(r)).toContain("No accounts were found");
  });
});
