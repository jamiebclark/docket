import { describe, expect, it } from "vitest";
import { DEFAULT_VIDEO_EDIT, VideoEditError, assertEditFits, isDefaultEdit, videoEditSchema } from "./edit";

const parse = (over: object) => videoEditSchema.safeParse({ ...DEFAULT_VIDEO_EDIT, ...over });

describe("videoEditSchema", () => {
  it("accepts the default edit", () => {
    expect(parse({}).success).toBe(true);
    expect(isDefaultEdit(DEFAULT_VIDEO_EDIT)).toBe(true);
  });
  it("accepts tenth-of-second precision and refuses finer", () => {
    expect(parse({ trimStartMs: 1500, trimEndMs: 9300 }).success).toBe(true);
    expect(parse({ trimStartMs: 1550 }).success).toBe(false);
    expect(parse({ trimStartMs: 0, trimEndMs: 5050 }).success).toBe(false);
  });
  it("refuses an end before the start or under a second after it", () => {
    for (const trimEndMs of [2000, 4000, 4999]) {
      const r = parse({ trimStartMs: 5000, trimEndMs });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0]!.path).toEqual(["trimEndMs"]);
    }
    expect(parse({ trimStartMs: 5000, trimEndMs: 6000 }).success).toBe(true);
  });
  it("refuses negatives, a bad colour and an out-of-range focal point", () => {
    expect(parse({ trimStartMs: -100 }).success).toBe(false);
    expect(parse({ padColor: "red" }).success).toBe(false);
    expect(parse({ focalX: 1.1 }).success).toBe(false);
    expect(parse({ focalY: -0.1 }).success).toBe(false);
  });
  it("lower-cases the colour", () => {
    const r = parse({ padColor: "#ABCDEF" });
    expect(r.success && r.data.padColor).toBe("#abcdef");
  });
});

describe("assertEditFits", () => {
  const edit = (over: object) => ({ ...DEFAULT_VIDEO_EDIT, ...over });
  it("passes an edit inside the video", () => {
    expect(assertEditFits(edit({ trimStartMs: 1000, trimEndMs: 5000 }), 10_000)).toMatchObject({ trimEndMs: 5000 });
  });
  it("normalises an end equal to the duration to null", () => {
    expect(assertEditFits(edit({ trimEndMs: 10_000 }), 10_000).trimEndMs).toBeNull();
  });
  it("refuses an end outside the video", () => {
    expect(() => assertEditFits(edit({ trimEndMs: 10_100 }), 10_000)).toThrow(VideoEditError);
    try {
      assertEditFits(edit({ trimEndMs: 10_100 }), 10_000);
    } catch (e) {
      expect((e as VideoEditError).field).toBe("trimEndMs");
    }
  });
  it("refuses a start with under a second left", () => {
    expect(() => assertEditFits(edit({ trimStartMs: 9_100 }), 10_000)).toThrow(/start/);
  });
  it("refuses a kept part under one second", () => {
    expect(() => assertEditFits(edit({ trimStartMs: 2000, trimEndMs: 2900 }), 10_000)).toThrow(/1 second/);
  });
  it("allows exactly one second", () => {
    expect(() => assertEditFits(edit({ trimStartMs: 2000, trimEndMs: 3000 }), 10_000)).not.toThrow();
  });
});
