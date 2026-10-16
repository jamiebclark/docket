import { afterAll, describe, expect, it } from "vitest";
import * as posts from "../../../src/server/services/posts";
import { closeDb } from "../../helpers/db";
import { createImageAssets, createVideoAsset } from "../../helpers/factories";
import { postsEnv } from "../../helpers/posts-env";
import { createMockAccount } from "../../helpers/scheduling";

afterAll(closeDb);

async function setup() {
  const env = await postsEnv();
  const instagram = await createMockAccount(env.project.id, {}, { providerKey: "instagram" });
  const facebook = await createMockAccount(env.project.id, {}, { providerKey: "facebook" });
  const mock = await createMockAccount(env.project.id, {});
  const video = () => createVideoAsset(env.project.id, { width: 1080, height: 1920 });
  const image = () => createImageAssets(env.project.id, 1).then(([a]) => a!);
  const check = async (accountId: string, mediaIds: string[], postType?: "image" | "video" | "reel" | "story" | null, postId?: string) => {
    const res = await posts.checkComposition(env.scope, {
      ...(postId ? { postId } : {}),
      baseText: "Hello",
      mediaIds,
      targets: [{ accountId, ...(postType !== undefined ? { postType } : {}) }],
    });
    return res.targets[0]!;
  };
  return { env, instagram, facebook, mock, video, image, check };
}

describe("per-target post type choice", () => {
  it("defaults one video on Instagram to Feed video, and reel gives the Reel summary", async () => {
    const t = await setup();
    const v = await t.video();
    const dflt = await t.check(t.instagram.id, [v.id]);
    expect(dflt.postType).toBe("video");
    expect(dflt.postTypeChoice).toMatchObject({ selected: "video", default: "video" });
    expect(dflt.postTypeChoice!.options.map((o) => o.type)).toEqual(["video", "reel", "story"]);

    const reel = await t.check(t.instagram.id, [v.id], "reel");
    expect(reel.postType).toBe("reel");
    expect(reel.postTypeChoice).toMatchObject({ selected: "reel" });
    expect(reel.requirements?.video.postType?.value).toBe("reel");
    expect(reel.requirements?.video.postType?.label).not.toBe(dflt.requirements?.video.postType?.label);
  });

  it("defaults one video on Facebook to Page video, and reel gives the Reel summary", async () => {
    const t = await setup();
    const v = await t.video();
    const dflt = await t.check(t.facebook.id, [v.id]);
    expect(dflt.postType).toBe("video");
    expect(dflt.postTypeChoice).toMatchObject({ selected: "video", default: "video" });
    expect(dflt.postTypeChoice!.options.map((o) => o.label)).toEqual(["Page video", "Reel"]);
    expect(dflt.requirements?.video.postType?.label).toBe("Page video");
    expect(dflt.requirements?.video.notes).toHaveLength(1);

    const reel = await t.check(t.facebook.id, [v.id], "reel");
    expect(reel.postType).toBe("reel");
    expect(reel.requirements?.video.postType).toMatchObject({ value: "reel", label: "Reel" });
    expect(reel.requirements?.video.videoCodecs).toEqual(["H.264", "HEVC", "VP9", "AV1"].map((label) => expect.objectContaining({ label })));
    expect(reel.requirements?.video.notes).toHaveLength(3);
  });

  it("keeps the choice per target beside Instagram", async () => {
    const t = await setup();
    const v = await t.video();
    const res = await posts.checkComposition(t.env.scope, {
      baseText: "Hello",
      mediaIds: [v.id],
      targets: [
        { accountId: t.facebook.id, postType: "reel" },
        { accountId: t.instagram.id, postType: "video" },
      ],
    });
    expect(res.targets.map((x) => x.postType)).toEqual(["reel", "video"]);
  });

  it("gives one image a choice of Feed post or Story, defaulting to image", async () => {
    const t = await setup();
    const img = await t.image();
    const dflt = await t.check(t.instagram.id, [img.id]);
    expect(dflt.postType).toBe("image");
    expect(dflt.postTypeChoice).toMatchObject({ selected: "image", default: "image" });
    expect(dflt.postTypeChoice!.options.map((o) => o.type)).toEqual(["image", "story"]);

    const story = await t.check(t.instagram.id, [img.id], "story");
    expect(story.postType).toBe("story");
    expect(story.postTypeChoice).toMatchObject({ selected: "story" });
  });

  it("gives no choice for two videos or video plus image, and the carousel summary", async () => {
    const t = await setup();
    const [a, b] = [await t.video(), await t.video()];
    const two = await t.check(t.instagram.id, [a.id, b.id], "reel");
    expect(two.postTypeChoice).toBeNull();
    expect(two.postType).toBe("carousel");
    expect(two.requirements?.video.postType?.value).toBe("carousel");
  });

  it("gives a mock account no choice", async () => {
    const t = await setup();
    const v = await t.video();
    expect((await t.check(t.mock.id, [v.id])).postTypeChoice).toBeNull();
  });

  it("refuses a value the provider does not offer", async () => {
    const t = await setup();
    const v = await t.video();
    await expect(
      posts.checkComposition(t.env.scope, { baseText: "x", mediaIds: [v.id], targets: [{ accountId: t.instagram.id, postType: "carousel" }] }),
    ).rejects.toThrow(/image, story, video, reel/);
    await expect(
      posts.checkComposition(t.env.scope, { baseText: "x", mediaIds: [v.id], targets: [{ accountId: t.mock.id, postType: "reel" }] }),
    ).rejects.toThrow(/offers no post type choice/);
  });

  it("keeps reel across save and reopen, and through a carousel and back (FR-008)", async () => {
    const t = await setup();
    const [a, b] = [await t.video(), await t.video()];
    const draft = await posts.createDraft(t.env.scope, {
      baseText: "Hello",
      mediaIds: [a.id],
      targets: [{ accountId: t.instagram.id, postType: "reel" }],
    });
    const reopened = await posts.getPost(t.env.scope, draft.post.id);
    expect(reopened.targets[0]!.chosenPostType).toBe("reel");

    // Stored value is used when the check input carries no choice.
    const stored = await t.check(t.instagram.id, [a.id], undefined, draft.post.id);
    expect(stored.postTypeChoice).toMatchObject({ selected: "reel" });

    const carousel = await t.check(t.instagram.id, [a.id, b.id], undefined, draft.post.id);
    expect(carousel.postTypeChoice).toBeNull();
    expect((await posts.getPost(t.env.scope, draft.post.id)).targets[0]!.chosenPostType).toBe("reel");
    expect((await t.check(t.instagram.id, [a.id], undefined, draft.post.id)).postTypeChoice).toMatchObject({ selected: "reel" });
  });

  it("a second image added to a story target publishes as a carousel, while the stored choice stays story (FR-024)", async () => {
    const t = await setup();
    const [a, b] = [await t.image(), await t.image()];
    const draft = await posts.createDraft(t.env.scope, {
      baseText: "Hello",
      mediaIds: [a.id],
      targets: [{ accountId: t.instagram.id, postType: "story" }],
    });
    const reopened = await posts.getPost(t.env.scope, draft.post.id);
    expect(reopened.targets[0]!.chosenPostType).toBe("story");

    const single = await t.check(t.instagram.id, [a.id], undefined, draft.post.id);
    expect(single.postType).toBe("story");

    const carousel = await t.check(t.instagram.id, [a.id, b.id], undefined, draft.post.id);
    expect(carousel.postType).toBe("carousel");
    expect(carousel.postTypeChoice).toBeNull();
    expect((await posts.getPost(t.env.scope, draft.post.id)).targets[0]!.chosenPostType).toBe("story");
  });
});
