import { describe, expect, it } from "vitest";
import { xStepFor } from "./steps";
import type { XState, XStateImage } from "./state";

const image = (over: Partial<XStateImage> = {}): XStateImage => ({
  mediaId: "111",
  expiresAt: 9_999_999_999_999,
  processing: "done",
  checks: 0,
  alt: false,
  described: false,
  ...over,
});
const state = (mediaCount: number, images: XStateImage[]): XState => ({ v: 1, mediaCount, images });
const step = (s: unknown, mediaCount: number) => xStepFor(s, {}, { text: "hi", mediaCount });
const UP1 = { name: "upload_image_1", mayPublish: false };

describe("xStepFor", () => {
  it("a text-only post is one publishing step, whatever the state", () => {
    expect(step(null, 0)).toEqual({ name: "create_post", mayPublish: true });
    expect(step(state(2, [image()]), 0)).toEqual({ name: "create_post", mayPublish: true });
    expect(step("garbage", 0)).toEqual({ name: "create_post", mayPublish: true });
  });

  it("starts with the first upload when there is no readable state", () => {
    expect(step(null, 2)).toEqual(UP1);
    expect(step(undefined, 2)).toEqual(UP1);
    expect(step({ v: 2 }, 2)).toEqual(UP1);
    expect(step("nope", 1)).toEqual(UP1);
  });

  it("restarts when the image count changed or the state holds too many images", () => {
    expect(step(state(1, [image()]), 2)).toEqual(UP1);
    expect(step({ v: 1, mediaCount: 1, images: [image(), image()] }, 1)).toEqual(UP1);
  });

  it("polls an image that is still processing", () => {
    expect(step(state(2, [image({ processing: "pending" })]), 2)).toEqual({ name: "check_image_1", mayPublish: false });
    expect(step(state(2, [image(), image({ processing: "pending" })]), 2)).toEqual({ name: "check_image_2", mayPublish: false });
  });

  it("describes an image whose alt text has not been sent", () => {
    expect(step(state(1, [image({ alt: true })]), 1)).toEqual({ name: "describe_image_1", mayPublish: false });
    expect(step(state(1, [image({ alt: true, described: true })]), 1)).toEqual({ name: "create_post", mayPublish: true });
  });

  it("uploads the next image, then creates the post", () => {
    expect(step(state(3, [image()]), 3)).toEqual({ name: "upload_image_2", mayPublish: false });
    expect(step(state(3, [image(), image()]), 3)).toEqual({ name: "upload_image_3", mayPublish: false });
    expect(step(state(2, [image(), image()]), 2)).toEqual({ name: "create_post", mayPublish: true });
  });

  it("is total on a bad mediaCount", () => {
    for (const bad of [Number.NaN, -3, Number.POSITIVE_INFINITY, undefined as unknown as number]) {
      expect(step(null, bad)).toEqual({ name: "create_post", mayPublish: true });
    }
    expect(step(null, 1.9)).toEqual(UP1);
  });
});
