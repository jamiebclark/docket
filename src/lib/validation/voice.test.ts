import { describe, expect, it } from "vitest";
import { voiceContentSchema, voiceNameSchema } from "./voice";

const parse = (v: unknown) => voiceContentSchema.safeParse(v);

describe("voiceContentSchema", () => {
  it("fills defaults for an empty object", () => {
    expect(parse({})).toMatchObject({
      success: true,
      data: { v: 1, voiceAndTone: "", examplePosts: [], preferredLinks: [], preferredHashtags: [], platformGuidance: {} },
    });
  });

  it("trims strings and enforces the 2,000 limit", () => {
    expect(parse({ voiceAndTone: "  warm  " }).data?.voiceAndTone).toBe("warm");
    expect(parse({ audience: "x".repeat(2001) }).success).toBe(false);
    expect(parse({ avoid: "x".repeat(2000) }).success).toBe(true);
  });

  it("drops empty examples and limits to 10 of up to 3,000 characters", () => {
    expect(parse({ examplePosts: ["a", "  ", "b"] }).data?.examplePosts).toEqual(["a", "b"]);
    expect(parse({ examplePosts: Array.from({ length: 11 }, () => "x") }).success).toBe(false);
    expect(parse({ examplePosts: ["x".repeat(3001)] }).success).toBe(false);
  });

  it("links need http(s) URLs, at most 20", () => {
    expect(parse({ preferredLinks: [{ url: "https://a.test/x", label: "A" }] }).success).toBe(true);
    expect(parse({ preferredLinks: [{ url: "ftp://a.test", label: "" }] }).success).toBe(false);
    expect(parse({ preferredLinks: [{ url: "not a url", label: "" }] }).success).toBe(false);
    expect(parse({ preferredLinks: [{ url: "https://a.test/" + "x".repeat(500), label: "" }] }).success).toBe(false);
    expect(parse({ preferredLinks: Array.from({ length: 21 }, () => ({ url: "https://a.test", label: "" })) }).success).toBe(false);
  });

  it("normalises and de-duplicates hashtags ignoring case", () => {
    expect(parse({ preferredHashtags: ["#Cats", "cats", " dogs ", "#", ""] }).data?.preferredHashtags).toEqual(["Cats", "dogs"]);
    expect(parse({ preferredHashtags: ["bad tag"] }).success).toBe(false);
    expect(parse({ preferredHashtags: Array.from({ length: 31 }, (_, i) => `t${i}`) }).success).toBe(false);
    expect(parse({ preferredHashtags: ["x".repeat(101)] }).success).toBe(false);
  });

  it("limits platform guidance to registered provider keys and drops empty entries", () => {
    expect(parse({ platformGuidance: { bluesky: "short", threads: "  " } }).data?.platformGuidance).toEqual({ bluesky: "short" });
    expect(parse({ platformGuidance: { myspace: "hi" } }).success).toBe(false);
  });
});

describe("voiceNameSchema", () => {
  it("is 1 to 80 trimmed characters", () => {
    expect(voiceNameSchema.safeParse("  ").success).toBe(false);
    expect(voiceNameSchema.safeParse("x".repeat(81)).success).toBe(false);
    expect(voiceNameSchema.parse(" Brand ")).toBe("Brand");
  });
});
