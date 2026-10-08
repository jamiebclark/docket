import { describe, expect, it } from "vitest";
import { blueskyStateSchema } from "./settings";
import { FAST_PHASE_MS, fitState, nextReadAt, partRange, videoUploadSchema } from "./video-state";

const blob = { $type: "blob" as const, ref: { $link: "cid" }, mimeType: "video/mp4" as const, size: 10 };
const at = "2026-10-08T12:00:00.000Z";
const upload = { jobId: "j", url: "https://m/x", sizeBytes: 12_000_000, partSizeBytes: 5_000_000, partCount: 3, expiresAt: at, pdsHost: "pds.test" };

describe("videoUploadSchema", () => {
  it("accepts a state per phase", () => {
    expect(videoUploadSchema.safeParse({ phase: "limits" }).success).toBe(true);
    expect(videoUploadSchema.safeParse({ phase: "start", pdsHost: "pds.test" }).success).toBe(true);
    expect(videoUploadSchema.safeParse({ phase: "parts", ...upload, partsSent: 2 }).success).toBe(true);
    expect(videoUploadSchema.safeParse({ phase: "finish", ...upload, partsSent: 3 }).success).toBe(true);
    expect(videoUploadSchema.safeParse({ phase: "job", pollJobId: "j", finishedAt: at, reads: 2 }).success).toBe(true);
    expect(videoUploadSchema.safeParse({ phase: "ready", blob }).success).toBe(true);
  });
  it("defaults restarts and statusAuth", () => {
    expect(videoUploadSchema.parse({ phase: "limits" })).toMatchObject({ restarts: 0, statusAuth: "service" });
  });
  it("rejects a state that breaks its phase's invariants", () => {
    for (const bad of [
      { phase: "start" },
      { phase: "parts", ...upload, partsSent: 3 },
      { phase: "parts", pdsHost: "pds.test" },
      { phase: "parts", ...upload, partsSent: 0, partCount: 2 },
      { phase: "finish", ...upload, partsSent: 1 },
      { phase: "job", pollJobId: "j" },
      { phase: "ready" },
      { phase: "limits", restarts: 3 },
      { phase: "job", pollJobId: "j", finishedAt: at, reads: 17 },
      { phase: "start", pdsHost: "Bad Host!" },
    ]) expect(videoUploadSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
  it("never has a place for a token", () => {
    const parsed = videoUploadSchema.parse({ phase: "limits", token: "secret" } as never);
    expect(JSON.stringify(parsed)).not.toContain("secret");
  });
});

describe("blueskyStateSchema", () => {
  it("parses a state saved before video existed", () => {
    expect(blueskyStateSchema.parse({ v: 1, blobs: [] })).toEqual({ v: 1, blobs: [] });
    expect(blueskyStateSchema.parse({ v: 1 }).video).toBeUndefined();
  });
  it("carries the video member", () => {
    expect(blueskyStateSchema.parse({ v: 1, video: { phase: "limits" } }).video?.phase).toBe("limits");
    expect(blueskyStateSchema.safeParse({ v: 1, video: { phase: "ready" } }).success).toBe(false);
  });
});

describe("fitState (P18)", () => {
  const withVideo = { v: 1 as const, blobs: [], video: { phase: "limits" as const, restarts: 0, statusAuth: "service" as const } };
  it("keeps a state that fits", () => {
    expect(fitState(withVideo, { isVideo: true })).toBe(withVideo);
    const images = { v: 1 as const, blobs: [blob] };
    expect(fitState(images, { isVideo: false })).toBe(images);
  });
  it("drops a video upload under images and image blobs under a video", () => {
    expect(fitState(withVideo, { isVideo: false })).toEqual({ v: 1, blobs: [] });
    expect(fitState({ v: 1 as const, blobs: [blob] }, { isVideo: true })).toEqual({ v: 1, blobs: [] });
  });
});

describe("partRange (P7)", () => {
  it("covers the file with a short last part", () => {
    expect(partRange(1, 5_000_000, 12_000_000)).toEqual({ first: 0, last: 4_999_999 });
    expect(partRange(2, 5_000_000, 12_000_000)).toEqual({ first: 5_000_000, last: 9_999_999 });
    expect(partRange(3, 5_000_000, 12_000_000)).toEqual({ first: 10_000_000, last: 11_999_999 });
  });
  it("handles an exact multiple and a one-part video", () => {
    expect(partRange(2, 5, 10)).toEqual({ first: 5, last: 9 });
    expect(partRange(1, 20_000_000, 9_000_000)).toEqual({ first: 0, last: 8_999_999 });
  });
});

describe("nextReadAt (P12)", () => {
  const finished = new Date("2026-10-08T12:00:00Z");
  const plus = (ms: number) => new Date(finished.getTime() + ms);
  it("reads every minute for the first 10 minutes", () => {
    expect(nextReadAt(plus(30_000), finished)).toEqual(plus(90_000));
    expect(nextReadAt(plus(FAST_PHASE_MS - 1), finished)).toEqual(plus(FAST_PHASE_MS - 1 + 60_000));
  });
  it("then every 5 minutes", () => {
    expect(nextReadAt(plus(FAST_PHASE_MS), finished)).toEqual(plus(FAST_PHASE_MS + 300_000));
    expect(nextReadAt(plus(900_000), finished)).toEqual(plus(1_200_000));
  });
});
