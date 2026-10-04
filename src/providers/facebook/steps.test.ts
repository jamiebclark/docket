import { describe, expect, it } from "vitest";
import { facebookStepFor } from "./steps";

const c = (mediaCount: number) => ({ text: "x", mediaCount });
const ids = (n: number) => ({ v: 1, photoIds: Array.from({ length: n }, (_, i) => `p${i}`) });

describe("facebookStepFor", () => {
  it("text → publish_feed", () => {
    expect(facebookStepFor(null, c(0))).toEqual({ name: "publish_feed", mayPublish: true });
  });
  it("one image → publish_photo", () => {
    expect(facebookStepFor(null, c(1))).toEqual({ name: "publish_photo", mayPublish: true });
  });
  it("N images → N non-publishing uploads then publish_feed", () => {
    expect(facebookStepFor(null, c(3))).toEqual({ name: "upload_photo_1", mayPublish: false });
    expect(facebookStepFor(ids(1), c(3))).toEqual({ name: "upload_photo_2", mayPublish: false });
    expect(facebookStepFor(ids(2), c(3))).toEqual({ name: "upload_photo_3", mayPublish: false });
    expect(facebookStepFor(ids(3), c(3))).toEqual({ name: "publish_feed", mayPublish: true });
  });
  it("is total on malformed state or counts", () => {
    for (const bad of [{}, "x", 5, { v: 2, photoIds: [] }, { v: 1, photoIds: [1] }, { v: 1 }]) {
      expect(facebookStepFor(bad, c(3))).toEqual({ name: "invalid", mayPublish: false });
    }
    expect(facebookStepFor(ids(4), c(3)).name).toBe("invalid");
    expect(facebookStepFor(null, c(11)).name).toBe("invalid");
    expect(facebookStepFor(null, c(Number.NaN))).toEqual({ name: "publish_feed", mayPublish: true });
  });
  it("state holds only photo ids", () => {
    expect(Object.keys(ids(2)).sort()).toEqual(["photoIds", "v"]);
  });
});
