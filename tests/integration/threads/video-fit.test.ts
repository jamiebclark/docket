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
    videoBitrate: 4_000_000,
    audioBitrate: 128_000,
    audioSampleRate: 44_100,
    audioChannels: 2,
    indexAtFront: true,
    factsVersion: 2,
    ...over,
  }) as MediaRow;

describe("Threads video fit badge (FR-019)", () => {
  it("fits a video inside every limit", () => {
    expect(fitOf(video(), threads)).toMatchObject({ providerKey: "threads", state: "fits", details: [], steps: [], convertedTo: null });
  });

  it("adapts a 120 fps video by lowering the frame rate (024: no longer refused)", () => {
    const fit = fitOf(video({ frameRate: 120 }), threads);
    expect(fit.state).toBe("adapted");
    expect(fit.convertedTo).toBeNull();
  });

  it("never produces converted, whatever the video", () => {
    const assets = [video(), video({ frameRate: 120 }), video({ durationMs: 400_000 }), video({ container: "mov" }), video({ videoCodec: "vp9" })];
    for (const asset of assets) {
      const fit = fitOf(asset, threads);
      expect(fit.state).not.toBe("converted");
      expect(fit.convertedTo).toBeNull();
    }
  });
});
