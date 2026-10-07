import { afterAll, describe, expect, it } from "vitest";
import { NotFoundError } from "../../../src/server/dal/errors";
import * as accounts from "../../../src/server/services/accounts";
import * as posts from "../../../src/server/services/posts";
import * as slots from "../../../src/server/services/slots";
import { setStorageForTests } from "../../../src/server/storage";
import { atTime } from "../../helpers/clock";
import { createVideoAsset } from "../../helpers/factories";
import { closeDb } from "../../helpers/db";
import { png } from "../../helpers/images";
import { blueskyLikeProvider, instagramLikeProvider, registerTestProvider } from "../../helpers/provider-fixtures";
import { postsEnv } from "../../helpers/posts-env";
import { createMemoryStorage } from "../../helpers/storage";

registerTestProvider(instagramLikeProvider);
registerTestProvider(blueskyLikeProvider);
registerTestProvider({
  ...blueskyLikeProvider,
  key: "capped-like",
  displayName: "Capped (test)",
  capabilities: { ...blueskyLikeProvider.capabilities, text: { ...blueskyLikeProvider.capabilities.text, maxLength: 5000, maxHashtags: 30, maxMentions: 20 } },
});
registerTestProvider({
  ...blueskyLikeProvider,
  key: "no-video-like",
  displayName: "No video (test)",
  capabilities: { ...blueskyLikeProvider.capabilities, video: { maxVideos: 0 }, postTypes: ["text", "image", "carousel"] },
});
const NOW = new Date("2026-10-01T12:00:00Z");

afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});

async function setup() {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const env = await postsEnv();
  async function account(providerKey: string) {
    const a = await accounts.saveConnectedAccount(env.scope, {
      providerKey,
      externalAccountId: `${providerKey}-${Math.random().toString(36).slice(2, 8)}`,
      displayName: providerKey,
      settings: {},
    });
    await slots.addSlot(env.scope, { accountId: a.id, weekday: 1, localTime: "09:00" });
    return a;
  }
  async function asset(width: number, height: number) {
    const body = await png(width, height);
    const key = `projects/${env.project.id}/media/${Math.random().toString(36).slice(2)}/original.png`;
    await storage.put(key, body, "image/png");
    return env.scope.media.insert({
      storageKey: key,
      publicUrl: storage.publicUrl(key),
      mimeType: "image/png",
      byteSize: body.length,
      width,
      height,
      altText: "alt",
    });
  }
  return { env, storage, account, asset };
}

describe("compose check with media adaptation", () => {
  it("refuses an out-of-range aspect on one target while another target of the same post queues", async () => {
    const t = await setup();
    const insta = await t.account("instagram-like");
    const bsky = await t.account("bluesky-like");
    const wide = await t.asset(2000, 800);
    const draft = await posts.createDraft(t.env.scope, {
      baseText: "hi",
      mediaIds: [wide.id],
      targets: [{ accountId: insta.id }, { accountId: bsky.id }],
    });
    const res = await atTime(NOW, () => posts.addToQueue(t.env.scope, draft.post.id));
    const byAccount = new Map(res.map((r) => [r.accountId, r]));
    expect(byAccount.get(insta.id)).toMatchObject({ ok: false, code: "validation" });
    expect((byAccount.get(insta.id) as { issues: { code: string }[] }).issues.map((i) => i.code)).toContain("aspect_ratio_out_of_range");
    expect(byAccount.get(bsky.id)).toMatchObject({ ok: true });
  });

  it("makes the variant before the transaction and queues with an info note", async () => {
    const t = await setup();
    const insta = await t.account("instagram-like");
    const a = await t.asset(1000, 1000);
    const draft = await posts.createDraft(t.env.scope, { baseText: "hi", mediaIds: [a.id], targets: [{ accountId: insta.id }] });
    const preview = await atTime(NOW, () => posts.previewQueue(t.env.scope, draft.post.id));
    expect(preview[0]).toMatchObject({ ok: true });
    expect((preview[0] as { issues: { code: string; severity: string }[] }).issues).toEqual([
      expect.objectContaining({ code: "media_will_convert", severity: "info" }),
    ]);
    const res = await atTime(NOW, () => posts.addToQueue(t.env.scope, draft.post.id));
    expect(res[0]).toMatchObject({ ok: true });
    expect(await t.env.scope.media.listVariants(a.id)).toHaveLength(1);
  });

  it("a variant failure is a per-target failure, not an exception", async () => {
    const t = await setup();
    const insta = await t.account("instagram-like");
    const bsky = await t.account("bluesky-like");
    const a = await t.asset(1000, 1000);
    // Remove the original so generation fails for the Instagram-like target only (Bluesky accepts PNG as is).
    await t.storage.delete(a.storageKey);
    const draft = await posts.createDraft(t.env.scope, {
      baseText: "hi",
      mediaIds: [a.id],
      targets: [{ accountId: insta.id }, { accountId: bsky.id }],
    });
    const res = await atTime(NOW, () => posts.addToQueue(t.env.scope, draft.post.id));
    const byAccount = new Map(res.map((r) => [r.accountId, r]));
    expect(byAccount.get(insta.id)).toMatchObject({ ok: false, code: "validation" });
    expect((byAccount.get(insta.id) as { issues: { code: string }[] }).issues.map((i) => i.code)).toContain("variant_failed");
    expect(byAccount.get(bsky.id)).toMatchObject({ ok: true });
  });

  it("an edit that swaps media on a scheduled target prepares the new variant", async () => {
    const t = await setup();
    const insta = await t.account("instagram-like");
    const first = await t.asset(1000, 1000);
    const second = await t.asset(1200, 1200);
    const draft = await posts.createDraft(t.env.scope, { baseText: "hi", mediaIds: [first.id], targets: [{ accountId: insta.id }] });
    await atTime(NOW, () => posts.addToQueue(t.env.scope, draft.post.id));
    await atTime(NOW, () => posts.updatePost(t.env.scope, draft.post.id, { mediaIds: [second.id] }));
    expect(await t.env.scope.media.listVariants(second.id)).toHaveLength(1);
  });
});

describe("checkComposition", () => {
  it("checks unsaved state per target, independently, without writing", async () => {
    const t = await setup();
    const insta = await t.account("instagram-like");
    const bsky = await t.account("bluesky-like");
    const wide = await t.asset(2000, 800);
    const before = await t.env.scope.posts.list({ limit: 100, offset: 0 });
    const res = await posts.checkComposition(t.env.scope, {
      baseText: "hi",
      mediaIds: [wide.id],
      targets: [{ accountId: insta.id }, { accountId: bsky.id }],
    });
    const byAccount = new Map(res.targets.map((r) => [r.accountId, r]));
    expect(byAccount.get(insta.id)).toMatchObject({ canSchedule: false, postType: "image" });
    expect(byAccount.get(insta.id)!.issues.map((i) => i.code)).toContain("aspect_ratio_out_of_range");
    expect(byAccount.get(bsky.id)).toMatchObject({ canSchedule: true, count: 2 });
    expect(await t.env.scope.posts.list({ limit: 100, offset: 0 })).toEqual(before);
    expect(await t.env.scope.media.listVariants(wide.id)).toHaveLength(0);
  });

  it("notes a planned conversion as info without a stored variant", async () => {
    const t = await setup();
    const insta = await t.account("instagram-like");
    const a = await t.asset(1000, 1000);
    const res = await posts.checkComposition(t.env.scope, { baseText: "hi", mediaIds: [a.id], targets: [{ accountId: insta.id }] });
    expect(res.targets[0]!.issues).toEqual([expect.objectContaining({ code: "media_will_convert", severity: "info" })]);
    expect(res.targets[0]!.canSchedule).toBe(true);
  });

  it("blocks a caption over the hashtag or mention cap, and lets one at the cap through", async () => {
    const t = await setup();
    const capped = await t.account("capped-like");
    const run = async (baseText: string) => (await posts.checkComposition(t.env.scope, { baseText, mediaIds: [], targets: [{ accountId: capped.id }] })).targets[0]!;
    const tags = (n: number) => Array.from({ length: n }, (_, i) => `#tag${i}`).join(" ");
    const mentions = (n: number) => Array.from({ length: n }, (_, i) => `@user${i}`).join(" ");
    const over = await run(tags(31));
    expect(over.canSchedule).toBe(false);
    expect(over.issues).toContainEqual(expect.objectContaining({ code: "too_many_hashtags", count: 31, limit: 30 }));
    const atCap = await run(`${tags(30)} ${mentions(20)}`);
    expect(atCap.canSchedule).toBe(true);
    expect(atCap.issues.map((i) => i.code)).not.toContain("too_many_hashtags");
    expect(atCap.issues.map((i) => i.code)).not.toContain("too_many_mentions");
    expect((await run(mentions(21))).issues).toContainEqual(expect.objectContaining({ code: "too_many_mentions", count: 21, limit: 20 }));
  });

  it("treats unknown accounts and media as not found", async () => {
    const t = await setup();
    const bsky = await t.account("bluesky-like");
    const nope = "00000000-0000-4000-8000-000000000000";
    await expect(posts.checkComposition(t.env.scope, { baseText: "x", targets: [{ accountId: nope }] })).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      posts.checkComposition(t.env.scope, { baseText: "x", mediaIds: [nope], targets: [{ accountId: bsky.id }] }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("reports reviewBlocked and editable for a saved post", async () => {
    const t = await setup();
    const bsky = await t.account("bluesky-like");
    const draft = await posts.createDraft(t.env.scope, { baseText: "hi", targets: [{ accountId: bsky.id }] });
    const input = { postId: draft.post.id, baseText: "hi", targets: [{ accountId: bsky.id }] };
    expect(await posts.checkComposition(t.env.scope, input)).toMatchObject({ editable: true, reviewBlocked: false });
    await posts.setReviewState(t.env.scope, draft.post.id, "needs_review");
    expect(await posts.checkComposition(t.env.scope, input)).toMatchObject({ reviewBlocked: true });
    await posts.setReviewState(t.env.scope, draft.post.id, "draft");
    await atTime(NOW, () => posts.addToQueue(t.env.scope, draft.post.id));
    const target = (await t.env.scope.targets.listForPost(draft.post.id))[0]!;
    await t.env.scope.targets.update(target.id, { status: "publishing" });
    expect(await posts.checkComposition(t.env.scope, input)).toMatchObject({ editable: false });
  });
});

describe("checkComposition with video", () => {
  const check = (t: Awaited<ReturnType<typeof setup>>, accountId: string, mediaIds: string[]) =>
    posts.checkComposition(t.env.scope, { baseText: "hi", mediaIds, targets: [{ accountId }] }).then((r) => r.targets[0]!);

  it("blocks while a video processes and clears when the row turns ready (US3 AS5)", async () => {
    const t = await setup();
    const mock = await t.account("mock");
    const v = await createVideoAsset(t.env.project.id, { state: "processing" });
    const blocked = await check(t, mock.id, [v.id]);
    expect(blocked.canSchedule).toBe(false);
    expect(blocked.issues).toContainEqual(expect.objectContaining({ code: "media_processing", field: "media.0" }));

    const ready = await createVideoAsset(t.env.project.id, { state: "ready" });
    const cleared = await check(t, mock.id, [ready.id]);
    expect(cleared.canSchedule).toBe(true);
    expect(cleared.issues.map((i) => i.code)).not.toContain("media_processing");
  });

  it("blocks a long video on the mock and on an account that takes no video (US3 AS4)", async () => {
    const t = await setup();
    const mock = await t.account("mock");
    const none = await t.account("no-video-like");
    const long = await createVideoAsset(t.env.project.id, { durationSeconds: 222 });
    const onMock = await check(t, mock.id, [long.id]);
    expect(onMock.canSchedule).toBe(false);
    expect(onMock.issues).toContainEqual(
      expect.objectContaining({ code: "video_too_long", message: "Video 1 is 3:42 long; the limit is 1 minute." }),
    );
    const onNone = await check(t, none.id, [long.id]);
    expect(onNone.canSchedule).toBe(false);
    expect(onNone.issues.map((i) => i.code)).toContain("video_not_accepted");
    expect(onNone.issues.map((i) => i.code)).not.toContain("unsupported_post_type");
  });

  it("shows a failed video's reason and accepts a clip inside the limits", async () => {
    const t = await setup();
    const mock = await t.account("mock");
    const failed = await createVideoAsset(t.env.project.id, { state: "failed", error: "Docket could not read this video." });
    expect((await check(t, mock.id, [failed.id])).issues).toContainEqual(
      expect.objectContaining({ code: "media_failed", message: "Video 1 failed: Docket could not read this video. Remove it to continue." }),
    );
    const ok = await createVideoAsset(t.env.project.id);
    expect(await check(t, mock.id, [ok.id])).toMatchObject({ canSchedule: true, postType: "video" });
  });
});
