import { describe, expect, it } from "vitest";
import { postUrl, xAccountNotes, xSettingsSchema } from "./settings";

describe("xSettingsSchema", () => {
  it("strips unknown keys and accepts empty settings", () => {
    expect(xSettingsSchema.parse({ username: "docket", name: "Docket", extra: 1 })).toEqual({ username: "docket", name: "Docket" });
    expect(xSettingsSchema.parse({})).toEqual({});
  });
});

describe("xAccountNotes", () => {
  it("shows the display name when present, plain text", () => {
    expect(xAccountNotes({ settings: { name: "Docket HQ" }, credentialsExpireAt: null })).toEqual(["X name: Docket HQ"]);
  });
  it("shows nothing without a name", () => {
    expect(xAccountNotes({ settings: {}, credentialsExpireAt: null })).toEqual([]);
    expect(xAccountNotes({ settings: { name: "" }, credentialsExpireAt: null })).toEqual([]);
  });
});

describe("postUrl", () => {
  it("uses the username when valid", () => {
    expect(postUrl({ username: "dockettest" }, "123")).toBe("https://x.com/dockettest/status/123");
  });
  it("falls back to /i/status/ for a missing or unusable username", () => {
    expect(postUrl({}, "123")).toBe("https://x.com/i/status/123");
    expect(postUrl({ username: "bad/../name" }, "123")).toBe("https://x.com/i/status/123");
    expect(postUrl({ username: "waytoolongusername1" }, "123")).toBe("https://x.com/i/status/123");
  });
});
