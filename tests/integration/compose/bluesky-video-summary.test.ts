import { afterAll, describe, expect, it } from "vitest";
import { BLUESKY_VIDEO_NOTES } from "../../../src/providers/bluesky/capabilities";
import * as accounts from "../../../src/server/services/accounts";
import * as posts from "../../../src/server/services/posts";
import { fitOf, fitPlatforms } from "../../../src/server/services/media-fit";
import { closeDb } from "../../helpers/db";
import { createVideoAsset } from "../../helpers/factories";
import { postsEnv } from "../../helpers/posts-env";

afterAll(closeDb);

async function setup() {
  const env = await postsEnv();
  const account = await accounts.saveConnectedAccount(env.scope, {
    providerKey: "bluesky",
    externalAccountId: `did:plc:${Math.random().toString(36).slice(2, 10)}`,
    displayName: "@me.bsky.social",
    settings: {},
  });
  return { env, account };
}

describe("composer check for one video and a Bluesky account (FR-018)", () => {
  it("returns Bluesky's video limits, the two notes and no post type choice", async () => {
    const { env, account } = await setup();
    const v = await createVideoAsset(env.project.id, { width: 1080, height: 1920 });
    const res = await posts.checkComposition(env.scope, { baseText: "Hello", mediaIds: [v.id], targets: [{ accountId: account.id }] });
    const t = res.targets[0]!;
    expect(t.postType).toBe("video");
    expect(t.postTypeChoice).toBeNull();
    expect(t.canSchedule).toBe(true);
    const video = t.requirements!.video;
    expect(video).toMatchObject({ maxVideos: 1, withImages: false, silentAllowed: true, postType: null });
    expect(video.maxBytes?.label).toBe("300 MB");
    expect(video.duration.max?.label).toBe("3 minutes");
    expect(video.containers.map((c) => c.label)).toEqual(["MP4"]);
    expect(video.videoCodecs.map((c) => c.label)).toEqual(["H.264"]);
    expect(video.audioCodecs.map((c) => c.label)).toEqual(["AAC"]);
    expect(video.notes).toEqual([...BLUESKY_VIDEO_NOTES]);
  });

  it("cuts a 5-minute video to 3:00 instead of refusing it", async () => {
    const { env, account } = await setup();
    const v = await createVideoAsset(env.project.id, { durationSeconds: 300 });
    const res = await posts.checkComposition(env.scope, { baseText: "Hello", mediaIds: [v.id], targets: [{ accountId: account.id }] });
    const t = res.targets[0]!;
    expect(t.canSchedule).toBe(true);
    expect(t.issues.some((i) => i.severity === "info" && i.message.includes("cut to the first 3:00"))).toBe(true);
  });
});

describe("fit badges for a Bluesky account (FR-019)", () => {
  it("badges a fitting, an adapted and a refused video from the declaration", async () => {
    const { env, account } = await setup();
    const [provider] = await fitPlatforms(env.scope, { accountIds: [account.id] });
    expect(provider!.key).toBe("bluesky");
    const fits = await createVideoAsset(env.project.id, { durationSeconds: 40 });
    const long = await createVideoAsset(env.project.id, { durationSeconds: 300 });
    const vp9 = await createVideoAsset(env.project.id, { videoCodec: "vp9", durationSeconds: 40 });
    expect(fitOf(fits, provider!).state).toBe("fits");
    const adapted = fitOf(long, provider!);
    expect(adapted.state).toBe("adapted");
    expect(adapted.steps).toEqual(["cut to 3:00"]);
    expect(fitOf(vp9, provider!).state).toBe("adapted");
  });
});
