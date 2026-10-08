import { describe, expect, it } from "vitest";
import { findProvider } from "../../../src/providers/registry";
import type { MediaRow } from "../../../src/server/dal/media";
import { fitOf } from "../../../src/server/services/media-fit";

const threads = findProvider("threads")!;

const video = (over: Partial<MediaRow> = {}): MediaRow =>
  ({
    id: "v",
    kind: "video",
    processingState: "ready",
    processingError: null,
    mimeType: "video/mp4",
    width: 1080,
    height: 1920,
    byteSize: 5_000_000,
    altText: "",
    durationMs: 20_000,
    frameRate: 30,
    videoCodec: "h264",
    audioCodec: "aac",
    container: "mp4",
    ...over,
  }) as MediaRow;

describe("Threads video fit badge (FR-019)", () => {
  it("fits a video inside every limit", () => {
    expect(fitOf(video(), threads)).toMatchObject({ providerKey: "threads", state: "fits", details: [], steps: [], convertedTo: null });
  });

  it("refuses a 120 fps video in 'This video' wording", () => {
    const fit = fitOf(video({ frameRate: 120 }), threads);
    expect(fit.state).toBe("refused");
    expect(fit.details).toHaveLength(1);
    expect(fit.details[0]).toMatch(/^This video is 120 fps; the limit is 60 fps/);
  });

  it("never produces converted, whatever the video", () => {
    const assets = [video(), video({ frameRate: 120 }), video({ durationMs: 400_000 }), video({ container: "mov" }), video({ videoCodec: "vp9" })];
    for (const asset of assets) {
      const fit = fitOf(asset, threads);
      expect(fit.state).not.toBe("converted");
      expect(fit.steps).toEqual([]);
      expect(fit.convertedTo).toBeNull();
    }
  });
});
