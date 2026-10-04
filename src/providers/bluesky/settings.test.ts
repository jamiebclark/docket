import { describe, expect, it } from "vitest";
import { DEFAULT_PDS_URL, blueskySettingsSchema, normaliseHandle, normalisePdsUrl } from "./settings";

describe("normaliseHandle", () => {
  it("strips @, trims and lower-cases", () => {
    expect(normaliseHandle("  @Alice.Bsky.Social ")).toBe("alice.bsky.social");
    expect(normaliseHandle("@")).toBe("");
  });
});

describe("normalisePdsUrl", () => {
  it("defaults when blank", () => {
    expect(normalisePdsUrl(undefined)).toBe(DEFAULT_PDS_URL);
    expect(normalisePdsUrl("  ")).toBe(DEFAULT_PDS_URL);
  });
  it("accepts https origins and ignores a trailing slash", () => {
    expect(normalisePdsUrl("https://pds.example.com/")).toBe("https://pds.example.com");
    expect(normalisePdsUrl("https://pds.example.com:8443")).toBe("https://pds.example.com:8443");
  });
  it.each([
    "http://pds.example.com",
    "https://user:pw@pds.example.com",
    "https://pds.example.com/xrpc",
    "https://pds.example.com/?a=1",
    "https://pds.example.com/#x",
    "https://pds.example.com?",
    "not a url",
    "ftp://pds.example.com",
  ])("rejects %s", (value) => {
    expect(normalisePdsUrl(value)).toBeNull();
  });
});

describe("blueskySettingsSchema", () => {
  it("defaults pdsUrl", () => {
    expect(blueskySettingsSchema.parse({})).toEqual({ pdsUrl: DEFAULT_PDS_URL });
  });
});
