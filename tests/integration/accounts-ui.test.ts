import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { socialAccounts } from "../../src/server/db/schema/accounts";
import { ConflictError, ForbiddenError } from "../../src/server/dal/errors";
import * as accounts from "../../src/server/services/accounts";
import * as posts from "../../src/server/services/posts";
import * as slots from "../../src/server/services/slots";
import { closeDb, testDb } from "../helpers/db";
import { postsEnv } from "../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});

async function flag(projectId: string, id: string, status: "active" | "needs_reauth", lastError: string | null) {
  await testDb().update(socialAccounts).set({ status, lastError }).where(and(eq(socialAccounts.projectId, projectId), eq(socialAccounts.id, id)));
}

describe("reconnectMock", () => {
  it("restores a needs_reauth mock account to connected and clears the error", async () => {
    const env = await postsEnv();
    const a = await env.account({}, false);
    await flag(env.project.id, a.id, "needs_reauth", "Token refresh failed");
    const r = await accounts.reconnectMock(env.scope, a.id);
    expect(r).toMatchObject({ id: a.id, status: "active", lastError: null });
    expect(await accounts.listAccounts(env.scope)).toHaveLength(1);
  });

  it("is forbidden to editors", async () => {
    const env = await postsEnv();
    const a = await env.account({}, false);
    await expect(accounts.reconnectMock(await env.as(env.editor), a.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("accountRemovalImpact and listAccountsNeedingReauth", () => {
  it("counts distinct unpublished posts", async () => {
    const env = await postsEnv();
    const a = await env.account();
    expect(await accounts.accountRemovalImpact(env.scope, a.id)).toEqual({ unpublishedPosts: 0 });
    await posts.createDraft(env.scope, { baseText: "one", targets: [{ accountId: a.id }] });
    await posts.createDraft(env.scope, { baseText: "two", targets: [{ accountId: a.id }] });
    expect(await accounts.accountRemovalImpact(env.scope, a.id)).toEqual({ unpublishedPosts: 2 });
    expect(await accounts.accountRemovalImpact(await env.as(env.editor), a.id)).toEqual({ unpublishedPosts: 2 });
  });

  it("lists only accounts needing reauth, without secrets", async () => {
    const env = await postsEnv();
    const ok = await env.account();
    const bad = await env.account();
    await flag(env.project.id, bad.id, "needs_reauth", "expired");
    const list = await accounts.listAccountsNeedingReauth(await env.as(env.editor));
    expect(list.map((x) => x.id)).toEqual([bad.id]);
    expect(list[0]).toEqual({ id: bad.id, displayName: bad.displayName, providerName: expect.any(String) });
    expect(list.map((x) => x.id)).not.toContain(ok.id);
    expect(JSON.stringify(await accounts.listAccounts(env.scope))).not.toMatch(/credentialsEncrypted|"token"/);
  });
});

describe("slots", () => {
  it("adds, refuses duplicates, pauses and deletes; editors are forbidden", async () => {
    const env = await postsEnv();
    const a = await env.account({}, false);
    const s = await slots.addSlot(env.scope, { accountId: a.id, weekday: 2, localTime: "10:30" });
    await expect(slots.addSlot(env.scope, { accountId: a.id, weekday: 2, localTime: "10:30" })).rejects.toBeInstanceOf(ConflictError);
    await slots.setSlotPaused(env.scope, s.id, true);
    expect((await slots.listSlots(env.scope, a.id))[0]).toMatchObject({ paused: true });
    const editor = await env.as(env.editor);
    await expect(slots.setSlotPaused(editor, s.id, false)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(slots.deleteSlot(editor, s.id)).rejects.toBeInstanceOf(ForbiddenError);
    await slots.deleteSlot(env.scope, s.id);
    expect(await slots.listSlots(env.scope, a.id)).toEqual([]);
  });
});
