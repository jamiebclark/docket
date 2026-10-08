import { describe, expect, it } from "vitest";
import { initialState, type InstagramState } from "./state";
import { planOf } from "./steps";
import { instagramStepFor } from "./steps";

const c = (mediaCount: number) => ({ text: "x", mediaCount });
const st = (mediaCount: number, patch: Partial<InstagramState> = {}): InstagramState => ({ ...initialState(mediaCount), ...patch });
const step = (name: string, mayPublish = false) => ({ name, mayPublish });
const create = (name: string, units: number, retryUnits = 1) => ({ name, mayPublish: false, allowance: { units, retryUnits } });

describe("instagramStepFor", () => {
  it("single image: create_container → check_status → check_quota → publish", () => {
    expect(instagramStepFor(null, c(1))).toEqual(create("create_container", 1));
    expect(instagramStepFor(st(1, { container: "c1", createdAt: "2026-01-01T00:00:00Z" }), c(1))).toEqual(step("check_status"));
    expect(instagramStepFor(st(1, { container: "c1", ready: true }), c(1))).toEqual(step("check_quota"));
    expect(instagramStepFor(st(1, { container: "c1", ready: true, quotaChecked: true }), c(1))).toEqual(step("publish", true));
  });

  it("carousel: one item container per image, then the carousel container", () => {
    expect(instagramStepFor(null, c(3))).toEqual(create("create_item_1", 4));
    expect(instagramStepFor(st(3, { items: ["a"] }), c(3))).toEqual(create("create_item_2", 0));
    expect(instagramStepFor(st(3, { items: ["a", "b", "c"] }), c(3))).toEqual(create("create_carousel", 0));
    expect(instagramStepFor(st(3, { items: ["a", "b", "c"], container: "k" }), c(3))).toEqual(step("check_status"));
  });

  it("only publish may publish", () => {
    for (const n of [1, 2, 10]) {
      expect(instagramStepFor(null, c(n)).mayPublish).toBe(false);
    }
  });

  it("restarts from the first create step on invalid state", () => {
    for (const bad of [{}, "x", 5, { v: 2 }, st(3, { items: ["a"] }), st(1, { ready: true }), st(1, { container: "c", quotaChecked: true })]) {
      expect(instagramStepFor(bad, c(1)).name).toBe("create_container");
    }
    expect(instagramStepFor(st(3, { items: ["a"] }), c(2)).name).toBe("create_item_2");
    expect(instagramStepFor(st(1, { ready: true }), c(1)).name).toBe("create_container");
  });

  it("is invalid with no images or more than 10, and total on odd counts", () => {
    expect(instagramStepFor(null, c(0)).name).toBe("invalid");
    expect(instagramStepFor(null, c(11)).name).toBe("invalid");
    expect(instagramStepFor(null, c(Number.NaN)).name).toBe("invalid");
    expect(instagramStepFor(null, c(10)).name).toBe("create_item_1");
  });

  it("recreation restarts and keeps the count", () => {
    expect(instagramStepFor(st(1, { recreations: 1 }), c(1)).name).toBe("create_container");
    expect(instagramStepFor(st(3, { recreations: 2 }), c(3)).name).toBe("create_item_1");
  });
});

const v = (kinds: ("image" | "video")[], postType?: "video" | "reel") => ({ text: "x", mediaCount: kinds.length, kinds, postType });

describe("video plans", () => {
  it("derives the plan from kinds and post type", () => {
    expect(planOf(c(1))).toEqual({ mediaType: "IMAGE" });
    expect(planOf(v(["video"], "video"))).toEqual({ mediaType: "REELS", shareToFeed: true });
    expect(planOf(v(["video"], "reel"))).toEqual({ mediaType: "REELS", shareToFeed: false });
    expect(planOf(v(["image", "video", "image"]))).toEqual({ mediaType: "CAROUSEL", kinds: ["image", "video", "image"] });
    expect(planOf(c(0))).toBeNull();
    expect(planOf(c(11))).toBeNull();
  });

  it("a single video: create_container → check_status → check_quota → publish", () => {
    const plan = { mediaType: "REELS" as const, shareToFeed: true };
    expect(instagramStepFor(null, v(["video"], "video"))).toEqual(create("create_container", 1));
    expect(instagramStepFor(initialState(plan), v(["video"], "video"))).toEqual(create("create_container", 1));
    expect(instagramStepFor({ ...initialState(plan), container: "r", createdAt: "2026-01-01T00:00:00Z" }, v(["video"], "video")).name).toBe("check_status");
    expect(instagramStepFor({ ...initialState(plan), container: "r", ready: true, quotaChecked: true }, v(["video"], "video"))).toEqual(step("publish", true));
  });

  it("switching Feed video to Reel restarts at the first create step", () => {
    const feed = { ...initialState({ mediaType: "REELS", shareToFeed: true }), container: "r", ready: true };
    expect(instagramStepFor(feed, v(["video"], "video")).name).toBe("check_quota");
    expect(instagramStepFor(feed, v(["video"], "reel")).name).toBe("create_container");
  });

  it("a state for another kind or count restarts; v1 image states stay valid", () => {
    const image = st(1, { container: "c", ready: true });
    expect(instagramStepFor(image, c(1)).name).toBe("check_quota");
    expect(instagramStepFor(image, v(["video"], "video")).name).toBe("create_container");
    const mixed = { ...initialState({ mediaType: "CAROUSEL", kinds: ["image", "video"] }), items: ["a"], itemProgress: [{ createdAt: "t", checks: 0, ready: true }] };
    expect(instagramStepFor(mixed, v(["image", "video"])).name).toBe("create_item_2");
    expect(instagramStepFor(mixed, v(["video", "image"])).name).toBe("create_item_1");
    expect(instagramStepFor(mixed, c(2)).name).toBe("create_item_1");
  });

  it("a mixed carousel polls unready video items before create_carousel", () => {
    const base = initialState({ mediaType: "CAROUSEL", kinds: ["video", "image"] });
    const done = { ...base, items: ["a", "b"], itemProgress: [{ createdAt: "t", checks: 1, ready: false }, { createdAt: "t", checks: 0, ready: true }] };
    expect(instagramStepFor(done, v(["video", "image"])).name).toBe("check_item_1");
    const ready = { ...done, itemProgress: done.itemProgress.map((p) => ({ ...p, ready: true })) };
    expect(instagramStepFor(ready, v(["video", "image"]))).toEqual(create("create_carousel", 0));
  });

  it("is total on garbage", () => {
    for (const bad of [{}, "x", 5, [], { v: 1, mediaType: "REELS" }]) {
      expect(instagramStepFor(bad, v(["video"], "reel")).name).toBe("create_container");
    }
  });
});
