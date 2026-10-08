import { describe, expect, it } from "vitest";
import { mediaConstraintsOf } from "../../providers/media";
import { listProviders } from "../../providers/registry";
import type { MediaRow } from "../dal/media";
import { fitOf } from "./media-fit";
import { planFor } from "./media-variants";

const JPEG = "image/jpeg";
const row = (mimeType: string, width: number | null, height: number | null, byteSize = 200_000): MediaRow =>
  ({ id: "x", mimeType, width, height, byteSize, altText: "" }) as MediaRow;

const FIXED: Record<string, MediaRow> = {
  portrait: row(JPEG, 1080, 1350),
  webp: row("image/webp", 1080, 1350),
  panorama: row("image/png", 3000, 1000),
  small: row(JPEG, 200, 200),
  oversize: row(JPEG, 4000, 4000, 40_000_000),
  tall: row(JPEG, 1000, 20_000),
  undimensioned: row(JPEG, null, null),
};
const by = (key: string) => listProviders().find((p) => p.key === key)!;

describe("fitOf", () => {
  it("agrees with the planner for every provider and image (SC-003)", () => {
    for (const p of listProviders()) {
      for (const [name, asset] of Object.entries(FIXED)) {
        const fit = fitOf(asset, p);
        expect(fit.providerKey).toBe(p.key);
        expect(fit.providerName).toBe(p.displayName);
        if (asset.width === null) {
          // No dimensions: nothing to plan from, so the badge is whatever the shared validator says.
          expect(name).toBe("undimensioned");
          expect(["fits", "refused"]).toContain(fit.state);
          continue;
        }
        const plan = planFor(asset, mediaConstraintsOf(p.capabilities), 0, p.displayName, "This image");
        expect(fit.state, `${p.key} ${name}`).toBe({ original: "fits", derive: "converted", refuse: "refused" }[plan.kind]);
        if (plan.kind === "derive") {
          expect(fit.steps).toEqual(plan.steps);
          expect(fit.details).toEqual(plan.notes.map((n) => n.message));
        } else if (plan.kind === "refuse") {
          expect(fit.steps).toEqual([]);
          expect(fit.details).toEqual(plan.issues.map((i) => i.message));
        } else {
          expect(fit.steps).toEqual([]);
          expect(fit.details).toEqual([]);
        }
      }
    }
  });

  it("fits a 1080×1350 JPEG on Instagram and Facebook", () => {
    expect(fitOf(FIXED.portrait!, by("instagram")).state).toBe("fits");
    expect(fitOf(FIXED.portrait!, by("facebook")).state).toBe("fits");
  });

  it("converts a WebP for Instagram and Facebook, and it fits X", () => {
    for (const k of ["instagram", "facebook"]) {
      const fit = fitOf(FIXED.webp!, by(k));
      expect(fit.state).toBe("converted");
      expect(fit.steps).toContain("convert");
      expect(fit.convertedTo).toBe("JPEG");
    }
    expect(fitOf(FIXED.webp!, by("x")).state).toBe("fits");
  });

  it("refuses a 3:1 panorama for Instagram", () => {
    const fit = fitOf(FIXED.panorama!, by("instagram"));
    expect(fit.state).toBe("refused");
    expect(fit.details[0]).toMatch(/^This image is too wide for Instagram/);
  });

  it("refuses a 200 px image for Instagram as too small", () => {
    const fit = fitOf(FIXED.small!, by("instagram"));
    expect(fit.state).toBe("refused");
    expect(fit.details[0]).toMatch(/^This image is 200×200; Instagram needs at least/);
  });
});

describe("fitOf for video", () => {
  const video = (over: Partial<MediaRow> = {}): MediaRow =>
    ({
      id: "v",
      kind: "video",
      processingState: "ready",
      processingError: null,
      mimeType: "video/mp4",
      width: 1280,
      height: 720,
      byteSize: 5_000_000,
      altText: "",
      durationMs: 20_000,
      frameRate: 30,
      videoCodec: "h264",
      audioCodec: "aac",
      container: "mp4",
      ...over,
    }) as MediaRow;

  it("fits the mock for a short H.264 clip", () => {
    expect(fitOf(video(), by("mock"))).toMatchObject({ state: "fits", details: [], steps: [], convertedTo: null });
  });
  it("refuses a long video on the mock, with the sentence in 'This video' wording", () => {
    const fit = fitOf(video({ durationMs: 222_000 }), by("mock"));
    expect(fit).toMatchObject({ state: "refused", details: ["This video is 3:42 long; the limit is 1 minute."] });
  });
  it("refuses every provider that does not accept video", () => {
    for (const p of listProviders().filter((x) => x.capabilities.video.maxVideos === 0)) {
      expect(fitOf(video(), p), p.key).toMatchObject({ state: "refused", details: ["This account does not accept video yet."] });
    }
  });
  it("fits Instagram as a Feed video, and refuses with the rewritten sentence, never converting", () => {
    expect(fitOf(video(), by("instagram"))).toMatchObject({ state: "fits", details: [], steps: [], convertedTo: null });
    const fit = fitOf(video({ durationMs: 960_000 }), by("instagram"));
    expect(fit.state).toBe("refused");
    expect(fit.details).toEqual([
      "This video is 16 minutes long; the limit is 15 minutes for an Instagram Feed video. Docket does not crop, trim or convert video yet.",
    ]);
    expect(fitOf(video({ frameRate: 15 }), by("instagram")).details[0]).toMatch(/^This video is 15 fps; the minimum is 23 fps for an Instagram Feed video/);
  });
  it("fits Facebook as a Page video, even a long one, and is never converted", () => {
    for (const asset of [video(), video({ durationMs: 999_000 }), video({ container: "mov" })]) {
      expect(fitOf(asset, by("facebook"))).toMatchObject({ state: "fits", details: [], steps: [], convertedTo: null });
    }
  });
  it("is never converted", () => {
    for (const p of listProviders()) {
      for (const asset of [video(), video({ durationMs: 999_000 }), video({ container: "mov" })]) {
        expect(fitOf(asset, p).state, p.key).not.toBe("converted");
      }
    }
  });
});
