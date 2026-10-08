import { describe, expect, it } from "vitest";
import { DEFAULT_VIDEO_EDIT } from "../lib/video/edit";
import { clockLabel, nearRatioLabel, ratioLabel, videoBytesLabel, videoStepWords } from "./video-labels";
import { planVideo } from "./video-plan";

describe("ratioLabel", () => {
  it("keeps the a:b form for small exact fractions", () => {
    expect(ratioLabel(9 / 16)).toBe("9:16");
    expect(ratioLabel(16 / 9)).toBe("16:9");
    expect(ratioLabel(10)).toBe("10:1");
  });
  it("uses 1:n for tiny ratios whose inverse is whole", () => {
    expect(ratioLabel(0.01)).toBe("1:100");
    expect(ratioLabel(1 / 1000)).toBe("1:1000");
    expect(`${ratioLabel(0.01)} – ${ratioLabel(10)}`).toBe("1:100 – 10:1");
  });
  it("falls back to r:1 otherwise", () => {
    expect(ratioLabel(1.91)).toBe("1.91:1");
    expect(ratioLabel(0.013)).toBe("0.01:1");
  });
});

describe("videoBytesLabel", () => {
  it("uses decimal gigabytes from 1 GB up and megabytes below", () => {
    expect(videoBytesLabel(1e9)).toBe("1 GB");
    expect(videoBytesLabel(1.05e9)).toBe("1.05 GB");
    expect(videoBytesLabel(300e6)).toBe("300 MB");
    expect(videoBytesLabel(50e6)).toBe("50 MB");
  });
});

describe("clockLabel", () => {
  it("writes minutes and seconds, and hours past an hour", () => {
    expect(clockLabel(90_000)).toBe("1:30");
    expect(clockLabel(900_000)).toBe("15:00");
    expect(clockLabel(5_000)).toBe("0:05");
    expect(clockLabel(3_900_000)).toBe("1:05:00");
  });
});

describe("nearRatioLabel", () => {
  it("names a crop's rounded shape", () => {
    expect(nearRatioLabel(608 / 1080)).toBe("9:16");
    expect(nearRatioLabel(16 / 9)).toBe("16:9");
    expect(nearRatioLabel(0.8)).toBe("4:5");
  });
});

describe("videoStepWords", () => {
  const facts = { container: "mp4" as const, durationSeconds: 600, frameRate: 120, videoCodec: "h264", audioCodec: "aac", factsVersion: 2 as const };
  const src = { width: 1920, height: 1080, bytes: 1_000_000, facts };
  const limits = { maxVideos: 1, maxDurationSeconds: 90, minAspectRatio: 0.556, maxAspectRatio: 0.569, recommendedAspectRatio: 9 / 16, maxFrameRate: 60 };
  const words = (over = {}) => {
    const p = planVideo(src, limits, { ...DEFAULT_VIDEO_EDIT, ...over }, { index: 0, platform: "X" });
    if (p.kind !== "derive") throw new Error(p.kind);
    return videoStepWords(p);
  };
  it("gives one short phrase per step", () => {
    expect(words()).toEqual(["cut to 1:30", "padded to 9:16 with a blurred copy", "frame rate changed to 60 fps"]);
    expect(words({ fit: "crop" })[1]).toBe("cropped to 9:16");
    expect(words({ fit: "pad_color", padColor: "#ffffff" })[1]).toBe("padded to 9:16 with #ffffff bars");
  });
  it("shows the range for a trim", () => {
    expect(words({ trimStartMs: 135_000, trimEndMs: 200_000 })[0]).toBe("cut to 2:15–3:20");
  });
  it("words resize, re-encode and rewrap", () => {
    const plan = (s: object, l: object) => {
      const p = planVideo({ ...src, ...s }, { maxVideos: 1, ...l }, DEFAULT_VIDEO_EDIT, { index: 0, platform: "X" });
      if (p.kind !== "derive") throw new Error(p.kind);
      return videoStepWords(p);
    };
    expect(plan({ width: 3840, height: 2160 }, { maxWidth: 1920 })).toEqual(["resized to 1920×1080"]);
    expect(plan({ facts: { ...facts, videoCodec: "vp9" } }, { videoCodecs: ["h264"] })).toEqual(["re-encoded"]);
    expect(plan({}, { indexAtFront: true })).toEqual(["rewrapped"]);
  });
});
