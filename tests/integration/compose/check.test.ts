import { afterAll, describe, expect, it } from "vitest";
import * as accounts from "../../../src/server/services/accounts";
import * as posts from "../../../src/server/services/posts";
import * as slots from "../../../src/server/services/slots";
import { setStorageForTests } from "../../../src/server/storage";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { png } from "../../helpers/images";
import { blueskyLikeProvider, instagramLikeProvider, registerTestProvider } from "../../helpers/provider-fixtures";
import { postsEnv } from "../../helpers/posts-env";
import { createMemoryStorage } from "../../helpers/storage";

registerTestProvider(instagramLikeProvider);
registerTestProvider(blueskyLikeProvider);
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
