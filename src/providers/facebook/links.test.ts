import { describe, expect, it } from "vitest";
import { firstUrl } from "./links";

describe("firstUrl", () => {
  it("returns null with no URL", () => {
    expect(firstUrl("just words")).toBeNull();
    expect(firstUrl("")).toBeNull();
  });
  it("finds one URL", () => {
    expect(firstUrl("read https://example.com/a?b=1 now")).toBe("https://example.com/a?b=1");
  });
  it("first of several wins", () => {
    expect(firstUrl("http://a.test/x and https://b.test/y")).toBe("http://a.test/x");
  });
  it.each([
    ["see https://example.com/x.", "https://example.com/x"],
    ["(https://example.com/x)", "https://example.com/x"],
    ["https://example.com/x, then", "https://example.com/x"],
  ])("trims trailing punctuation: %s", (text, expected) => {
    expect(firstUrl(text)).toBe(expected);
  });
  it("ignores www. without a scheme", () => {
    expect(firstUrl("go to www.example.com")).toBeNull();
  });
  it("handles a URL in angle brackets", () => {
    expect(firstUrl("see <https://example.com/x> ok")).toBe("https://example.com/x");
  });
});
