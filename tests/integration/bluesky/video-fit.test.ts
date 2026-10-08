import { afterAll, afterEach, describe, expect, it } from "vitest";
import { blueskyProvider } from "../../../src/providers/bluesky";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import * as posts from "../../../src/server/services/posts";
import { fitOf } from "../../../src/server/services/media-fit";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createVideoAsset } from "../../helpers/factories";
import { createMediaAsset, createSlots } from "../../helpers/scheduling";
import { blueskyVideoSetup } from "../../helpers/bluesky-video";

type Setup = Awaited<ReturnType<typeof blueskyVideoSetup>>;
let current: Setup | undefined;
afterEach(() => current?.unstub());
afterAll(closeDb);

const BEFORE = new Date("2026-10-01T12:00:00Z");
const SMALL = 1_000_000;

describe("how Bluesky's declaration shapes a video (badges)", () => {
  it("adapts a 5-minute HEVC MOV: cut to 3:00 and re-encoded", async () => {
    current = await blueskyVideoSetup({ sizeBytes: SMALL });
    const asset = await createVideoAsset(current.env.project.id, { container: "mov", videoCodec: "hevc", durationSeconds: 300 });
    const fit = fitOf(asset, blueskyProvider);
    expect(fit.state).toBe("adapted");
    expect(fit.steps.join(" ")).toMatch(/cut/);
    expect(fit.steps).toEqual(["cut to 3:00"]);
  });

  it("rewraps a 40 s H.264/AAC MOV without re-encoding", async () => {
    current = await blueskyVideoSetup({ sizeBytes: SMALL });
    const asset = await createVideoAsset(current.env.project.id, { container: "mov", durationSeconds: 40 });
    const fit = fitOf(asset, blueskyProvider);
    expect(fit.state).toBe("adapted");
    expect(fit.steps.join(" ")).not.toMatch(/cut|re-?encod/i);
  });

  it("fits a 40 s H.264/AAC MP4 as is", async () => {
    current = await blueskyVideoSetup({ sizeBytes: SMALL });
    const asset = await createVideoAsset(current.env.project.id, { durationSeconds: 40 });
    expect(fitOf(asset, blueskyProvider)).toMatchObject({ state: "fits", steps: [], details: [] });
  });
});

describe("two videos, or a video with an image, are refused with no request to Bluesky", () => {
  const cases = [
    ["two videos", "Bluesky takes one video per post; this post has 2."],
    ["a video and an image", "Bluesky takes one video per post with no images alongside it."],
  ] as const;

  for (const [title, message] of cases) {
    it(`${title}: composer check, scheduling gate and publish-time re-check`, async () => {
      current = await blueskyVideoSetup({ sizeBytes: SMALL, alt: "a dog" });
      const s = current;
      const second =
        title === "two videos"
          ? await createVideoAsset(s.env.project.id, { durationSeconds: 20 })
          : await createMediaAsset(s.env.project.id, { mimeType: "image/jpeg" });
      await s.storage.put(second.storageKey, Buffer.alloc(1024), second.mimeType);
      const mediaIds = [s.asset.id, second.id];
      const account = s.target.socialAccountId;
      await createSlots(s.env.project.id, account, [{ weekday: 1, localTime: "09:00" }]);

      const check = await posts.checkComposition(s.env.scope, { baseText: "hi", mediaIds, targets: [{ accountId: account }] });
      expect(check.targets[0]!.canSchedule).toBe(false);
      expect(check.targets[0]!.issues.map((i) => i.message)).toContain(message);

      const draft = await posts.createDraft(s.env.scope, { baseText: "hi", mediaIds, targets: [{ accountId: account }] });
      const queued = await atTime(BEFORE, () => posts.addToQueue(s.env.scope, draft.post.id, {}));
      expect(queued[0]).toMatchObject({ ok: false, code: "validation" });

      await s.repos.posts.setMedia(s.post.id, mediaIds);
      const before = s.pds.requests.length;
      await s.tick();
      const after = await forSchedulerProject(s.env.project.id).targets.get(s.target.id);
      expect(after).toMatchObject({ status: "failed", externalId: null });
      const attempts = await forSchedulerProject(s.env.project.id).attempts.listForTarget(s.target.id);
      expect(attempts.map((a) => [a.step, a.outcome])).toEqual([["engine-validate", "fatal_error"]]);
      expect(after!.lastError).toContain(message);
      expect(s.pds.requests.length).toBe(before);
    });
  }
});
