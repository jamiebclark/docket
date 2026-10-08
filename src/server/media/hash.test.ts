import { describe, expect, it } from "vitest";
import type { VideoRecipe } from "../../providers/video-plan";
import { videoRecipeKey } from "./hash";

const recipe: VideoRecipe = {
  mode: "encode",
  container: "mp4",
  startMs: 0,
  keptMs: 90_000,
  frame: { kind: "pad", canvasW: 1080, canvasH: 1920, frameW: 1080, frameH: 606, x: 0, y: 656, fill: "blur" },
  width: 1080,
  height: 1920,
  frameRate: null,
  video: { maxBitrate: 25_000_000, maxBytes: 300_000_000, minWidth: 540, minHeight: 960 },
  audio: { sampleRate: 48_000, channels: 2, bitrate: 128_000 },
  indexAtFront: true,
};

describe("videoRecipeKey", () => {
  it("is 64 hex characters", () => {
    expect(videoRecipeKey("full", recipe)).toMatch(/^[0-9a-f]{64}$/);
  });
  it("is stable across field order", () => {
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(recipe).reverse()))) as VideoRecipe;
    reordered.video = { minHeight: 960, minWidth: 540, maxBytes: 300_000_000, maxBitrate: 25_000_000 };
    expect(videoRecipeKey("full", reordered)).toBe(videoRecipeKey("full", recipe));
  });
  it("differs between full and preview", () => {
    expect(videoRecipeKey("full", recipe)).not.toBe(videoRecipeKey("preview", recipe));
  });
  it("changes with any number in the recipe", () => {
    expect(videoRecipeKey("full", { ...recipe, keptMs: 89_900 })).not.toBe(videoRecipeKey("full", recipe));
    expect(videoRecipeKey("full", { ...recipe, frame: { kind: "none" } })).not.toBe(videoRecipeKey("full", recipe));
  });
  it("changes with the pipeline version", async () => {
    const before = videoRecipeKey("full", recipe);
    const { vi } = await import("vitest");
    vi.resetModules();
    vi.doMock("../../providers/video-plan", () => ({ VIDEO_PIPELINE_VERSION: 2 }));
    const { videoRecipeKey: bumped } = await import("./hash");
    expect(bumped("full", recipe)).not.toBe(before);
    vi.doUnmock("../../providers/video-plan");
    vi.resetModules();
  });
});
