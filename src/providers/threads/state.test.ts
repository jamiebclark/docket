import { describe, expect, it } from "vitest";
import { initialState, planOf, threadsStateSchema, videoCheckDelayMs } from "./state";

const base = { v: 1, items: [], container: null, createdAt: null, checks: 0, ready: false, quotaChecked: false, recreations: 0 };
const at = "2026-01-01T00:00:00.000Z";

describe("threadsStateSchema", () => {
  it("parses every pre-023 shape", () => {
    for (const mediaType of ["TEXT", "IMAGE", "CAROUSEL"]) expect(threadsStateSchema.safeParse({ ...base, mediaType }).success).toBe(true);
    expect(threadsStateSchema.safeParse({ ...base, mediaType: "CAROUSEL", items: ["1", "2"], container: "9", createdAt: at, ready: true, quotaChecked: true, recreations: 2 }).success).toBe(true);
    for (const n of [0, 1, 2, 20]) expect(threadsStateSchema.safeParse(initialState(n)).success).toBe(true);
  });

  it("accepts VIDEO, kinds and itemProgress and bounds them", () => {
    expect(threadsStateSchema.safeParse({ ...base, mediaType: "VIDEO" }).success).toBe(true);
    const progress = { createdAt: at, checks: 0, ready: false };
    const ok = { ...base, mediaType: "CAROUSEL", kinds: ["image", "video"], itemProgress: [progress] };
    expect(threadsStateSchema.safeParse(ok).success).toBe(true);
    expect(threadsStateSchema.safeParse({ ...ok, kinds: ["video"] }).success).toBe(false);
    expect(threadsStateSchema.safeParse({ ...ok, kinds: Array(21).fill("video") }).success).toBe(false);
    expect(threadsStateSchema.safeParse({ ...ok, kinds: ["image", "gif"] }).success).toBe(false);
    expect(threadsStateSchema.safeParse({ ...ok, itemProgress: Array(21).fill(progress) }).success).toBe(false);
    expect(threadsStateSchema.safeParse({ ...ok, itemProgress: [{ ...progress, checks: -1 }] }).success).toBe(false);
  });
});

describe("planOf and initialState", () => {
  it("derives the plan from the count and kinds", () => {
    expect(planOf(0)?.mediaType).toBe("TEXT");
    expect(planOf(1, ["video"])?.mediaType).toBe("VIDEO");
    expect(planOf(1, ["image"])?.mediaType).toBe("IMAGE");
    expect(planOf(1)?.mediaType).toBe("IMAGE");
    expect(planOf(3, ["image", "video", "image"])?.kinds).toEqual(["image", "video", "image"]);
    expect(planOf(3, ["image", "image", "image"])?.kinds).toBeUndefined();
    expect(planOf(3, ["video"])?.kinds).toBeUndefined();
    expect(planOf(21)).toBeNull();
    expect(planOf(Number.NaN)).toBeNull();
  });

  it("starts a video carousel with kinds and empty progress", () => {
    const s = initialState(planOf(2, ["video", "video"])!);
    expect(s).toMatchObject({ mediaType: "CAROUSEL", kinds: ["video", "video"], itemProgress: [] });
    expect(initialState(2).kinds).toBeUndefined();
  });
});

describe("videoCheckDelayMs", () => {
  it("is 60 s under 5 minutes and 5 minutes from then on", () => {
    expect(videoCheckDelayMs(0)).toBe(60_000);
    expect(videoCheckDelayMs(299_999)).toBe(60_000);
    expect(videoCheckDelayMs(300_000)).toBe(300_000);
  });
});
