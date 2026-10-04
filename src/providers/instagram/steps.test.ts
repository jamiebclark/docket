import { describe, expect, it } from "vitest";
import { initialState, type InstagramState } from "./state";
import { instagramStepFor } from "./steps";

const c = (mediaCount: number) => ({ text: "x", mediaCount });
const st = (mediaCount: number, patch: Partial<InstagramState> = {}): InstagramState => ({ ...initialState(mediaCount), ...patch });
const step = (name: string, mayPublish = false) => ({ name, mayPublish });

describe("instagramStepFor", () => {
  it("single image: create_container → check_status → check_quota → publish", () => {
    expect(instagramStepFor(null, c(1))).toEqual(step("create_container"));
    expect(instagramStepFor(st(1, { container: "c1", createdAt: "2026-01-01T00:00:00Z" }), c(1))).toEqual(step("check_status"));
    expect(instagramStepFor(st(1, { container: "c1", ready: true }), c(1))).toEqual(step("check_quota"));
    expect(instagramStepFor(st(1, { container: "c1", ready: true, quotaChecked: true }), c(1))).toEqual(step("publish", true));
  });

  it("carousel: one item container per image, then the carousel container", () => {
    expect(instagramStepFor(null, c(3))).toEqual(step("create_item_1"));
    expect(instagramStepFor(st(3, { items: ["a"] }), c(3))).toEqual(step("create_item_2"));
    expect(instagramStepFor(st(3, { items: ["a", "b", "c"] }), c(3))).toEqual(step("create_carousel"));
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
