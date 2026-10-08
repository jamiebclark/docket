import { describe, expect, it } from "vitest";
import { initialState, instagramStateSchema, videoCheckDelayMs } from "./state";

describe("videoCheckDelayMs", () => {
  it("checks every minute up to 5:00, then every 5 minutes", () => {
    expect(videoCheckDelayMs(0)).toBe(60_000);
    expect(videoCheckDelayMs(4 * 60_000 + 59_000)).toBe(60_000);
    expect(videoCheckDelayMs(5 * 60_000)).toBe(300_000);
    expect(videoCheckDelayMs(59 * 60_000)).toBe(300_000);
  });
});

describe("instagramStateSchema", () => {
  it("accepts the shape saved before 019", () => {
    const old = { v: 1, mediaType: "CAROUSEL", items: ["a"], container: null, createdAt: null, checks: 0, ready: false, quotaChecked: false, recreations: 0 };
    expect(instagramStateSchema.safeParse(old).success).toBe(true);
  });

  it("accepts the new fields", () => {
    const s = initialState({ mediaType: "REELS", shareToFeed: false });
    expect(instagramStateSchema.parse(s)).toMatchObject({ mediaType: "REELS", shareToFeed: false });
    const c = initialState({ mediaType: "CAROUSEL", kinds: ["image", "video"] });
    expect(instagramStateSchema.parse(c)).toMatchObject({ kinds: ["image", "video"], itemProgress: [] });
  });

  it("handles garbage totally", () => {
    for (const bad of [null, undefined, 5, "x", [], {}, { v: 2 }, { v: 1, mediaType: "VIDEO" }]) {
      expect(instagramStateSchema.safeParse(bad).success).toBe(false);
    }
  });
});
