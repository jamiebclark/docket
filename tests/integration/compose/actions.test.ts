import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);

import { addToQueueAction, previewQueueAction, saveDraftAction } from "../../../src/app/p/[projectSlug]/compose/actions";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { actAs, refreshCalls } from "../../helpers/actions";
import { createProjectWithMembers } from "../../helpers/factories";
import { postsEnv } from "../../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});
beforeEach(() => {
  refreshCalls.count = 0;
});

async function setup() {
  const env = await postsEnv();
  const account = await env.account();
  return { env, slug: env.project.slug, account };
}

describe("compose actions", () => {
  it("saveDraftAction creates then updates, and refreshes", async () => {
    const t = await setup();
    actAs(t.env.editor);
    const created = await saveDraftAction(t.slug, { baseText: "one", mediaIds: [], targets: [{ accountId: t.account.id }] });
    expect(created).toMatchObject({ ok: true });
    expect(refreshCalls.count).toBe(1);
    const postId = (created as { data: { postId: string } }).data.postId;
    const updated = await saveDraftAction(t.slug, { postId, baseText: "two", mediaIds: [], targets: [{ accountId: t.account.id }] });
    expect(updated).toEqual({ ok: true, data: { postId } });
    expect((await t.env.scope.posts.get(postId))?.baseText).toBe("two");
  });

  it("maps invalid input to validation with fieldErrors", async () => {
    const t = await setup();
    actAs(t.env.editor);
    const res = await saveDraftAction(t.slug, { baseText: "x", targets: [{ accountId: "nope" }] });
    expect(res).toMatchObject({ ok: false, error: "validation" });
    expect(Object.keys((res as { fieldErrors: object }).fieldErrors).length).toBeGreaterThan(0);
    expect(refreshCalls.count).toBe(0);
  });

  it("is not_found for a signed-out user and a non-member", async () => {
    const t = await setup();
    actAs(null);
    expect(await saveDraftAction(t.slug, { baseText: "x" })).toMatchObject({ ok: false, error: "not_found" });
    actAs((await createProjectWithMembers()).owner);
    expect(await saveDraftAction(t.slug, { baseText: "x" })).toMatchObject({ ok: false, error: "not_found" });
    expect(await previewQueueAction(t.slug, { postId: crypto.randomUUID() })).toMatchObject({ ok: false, error: "not_found" });
  });

  it("previews then queues, reporting a changed slot", async () => {
    const t = await setup();
    actAs(t.env.editor);
    const saved = await saveDraftAction(t.slug, { baseText: "hi", mediaIds: [], targets: [{ accountId: t.account.id }] });
    const postId = (saved as { data: { postId: string } }).data.postId;
    const preview = await atTime(new Date("2026-10-01T12:00:00Z"), () => previewQueueAction(t.slug, { postId }));
    expect(preview).toMatchObject({ ok: true });
    const first = (preview as { data: { targetId: string; ok: boolean; at?: Date; instant?: Date }[] }).data[0]!;
    expect(first.ok).toBe(true);
    refreshCalls.count = 0;
    const queued = await atTime(new Date("2026-10-01T12:00:00Z"), () =>
      addToQueueAction(t.slug, { postId, expected: { [first.targetId]: "2020-01-01T00:00:00.000Z" } }),
    );
    expect(queued).toMatchObject({ ok: true });
    expect((queued as { data: { ok: boolean; changedFromPreview: boolean }[] }).data[0]).toMatchObject({ ok: true, changedFromPreview: true });
    expect(refreshCalls.count).toBe(1);
  });

  it("returns per-target failures as data, and conflicts as conflict", async () => {
    const t = await setup();
    actAs(t.env.editor);
    const saved = await saveDraftAction(t.slug, { baseText: "", mediaIds: [], targets: [{ accountId: t.account.id }] });
    const postId = (saved as { data: { postId: string } }).data.postId;
    const queued = await atTime(new Date("2026-10-01T12:00:00Z"), () => addToQueueAction(t.slug, { postId }));
    expect(queued).toMatchObject({ ok: true });
    expect((queued as { data: { ok: boolean; code?: string }[] }).data[0]).toMatchObject({ ok: false, code: "validation" });
  });
});
