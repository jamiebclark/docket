import { describe, expect, it } from "vitest";
import { facebookStateSchema } from "./settings";
import { CHECK_FIRST_MS, CHECK_SLOW_MS, checkDelayMs, validReelState } from "./state";

const reel = {
  v: 1,
  kind: "reel",
  videoId: "12345",
  uploadUrl: "https://rupload.facebook.com/video-upload/12345",
  startedAt: "2026-10-05T09:00:00.000Z",
  uploadedAt: null,
  uploadComplete: false,
  uploadChecks: 0,
  finishedAt: null,
  publishChecks: 0,
};
const T = "2026-10-05T09:01:00.000Z";

describe("facebookStateSchema", () => {
  it("still parses the v1 photo state", () => {
    expect(facebookStateSchema.safeParse({ v: 1, photoIds: ["a", "b"] }).success).toBe(true);
  });
  it("parses a Reel state and refuses a mix of both", () => {
    expect(facebookStateSchema.safeParse(reel).success).toBe(true);
    expect(facebookStateSchema.safeParse({ ...reel, photoIds: [] }).success).toBe(false);
    expect(facebookStateSchema.safeParse({ v: 1, photoIds: [], kind: "reel" }).success).toBe(false);
  });
  it("refuses a non-numeric video id and a missing field", () => {
    expect(facebookStateSchema.safeParse({ ...reel, videoId: "../x" }).success).toBe(false);
    const { uploadChecks: _drop, ...rest } = reel;
    expect(facebookStateSchema.safeParse(rest).success).toBe(false);
  });
});

describe("validReelState", () => {
  it("accepts each stage", () => {
    expect(validReelState(reel)).toEqual(reel);
    expect(validReelState({ ...reel, uploadedAt: T, uploadChecks: 2 })).not.toBeNull();
    expect(validReelState({ ...reel, uploadedAt: T, uploadComplete: true })).not.toBeNull();
    expect(validReelState({ ...reel, uploadedAt: T, uploadComplete: true, finishedAt: T, publishChecks: 3 })).not.toBeNull();
  });
  it("refuses states that break an invariant", () => {
    expect(validReelState({ ...reel, uploadComplete: true })).toBeNull();
    expect(validReelState({ ...reel, uploadedAt: T, finishedAt: T })).toBeNull();
    expect(validReelState({ ...reel, publishChecks: 1 })).toBeNull();
  });
  it("refuses photo state, junk and null", () => {
    for (const bad of [{ v: 1, photoIds: [] }, null, undefined, "x", 5, {}]) expect(validReelState(bad)).toBeNull();
  });
});

describe("checkDelayMs", () => {
  it("checks at 1, 2, 3, 4, 5, 10, 15 minutes", () => {
    let age = 0;
    const at: number[] = [];
    for (let i = 0; i < 7; i++) {
      age += checkDelayMs(age);
      at.push(age / 60_000);
    }
    expect(at).toEqual([1, 2, 3, 4, 5, 10, 15]);
    expect(checkDelayMs(0)).toBe(CHECK_FIRST_MS);
    expect(checkDelayMs(300_000)).toBe(CHECK_SLOW_MS);
  });
});
