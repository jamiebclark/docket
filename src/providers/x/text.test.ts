import { describe, expect, it } from "vitest";
import { countXText, hasLinkOrEmoji, xCountingRule } from "./text";

const cases: [string, string, number][] = [
  ["empty", "", 0],
  ["ascii 280", "a".repeat(280), 280],
  ["ascii 281", "a".repeat(281), 281],
  ["decomposed é counts once after NFC", "é", 1],
  ["precomposed é", "é", 1],
  ["Cyrillic", "д", 1],
  ["CJK", "日", 2],
  ["CJK sentence", "日本語", 6],
  ["U+10FF", "ჿ", 1],
  ["U+1100", "ᄀ", 2],
  ["U+2000", " ", 1],
  ["U+200E", "‎", 2],
  ["U+2010", "‐", 1],
  ["U+2018", "‘", 1],
  ["U+2027", "‧", 2],
  ["U+2032", "′", 1],
  ["U+2037", "‷", 1],
  ["U+2038", "‸", 2],
  ["ZWJ family emoji", "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}", 2],
  ["flag emoji", "\u{1F1EC}\u{1F1E7}", 2],
  ["keycap emoji", "1️⃣", 2],
  ["skin-tone emoji", "\u{1F44D}\u{1F3FD}", 2],
  ["plain emoji", "\u{1F600}", 2],
  ["two emoji", "\u{1F600}\u{1F600}", 4],
  ["long URL is 23", "https://example.com/a/very/long/path", 23],
  ["http URL with query", "http://example.com/x?y=1&z=2", 23],
  ["scheme-less domain", "example.com", 23],
  ["www with path, query and fragment", "www.example.org/path?q=1#f", 23],
  ["multi-label country domain", "bbc.co.uk", 23],
  ["trailing dot is not part of the link", "see example.com.", 4 + 23 + 1],
  ["trailing comma and bracket", "(see https://example.com/a),", 5 + 23 + 2],
  ["file.txt is not a URL", "file.txt", 8],
  ["version number is not a URL", "v1.2", 4],
  ["email is not a URL", "me@example.com", 14],
  ["mixed text, link and emoji", "hi \u{1F600} https://example.com/x ok", 3 + 2 + 1 + 23 + 3],
  ["two links", "a.com b.com", 46 + 1],
  ["uppercase domain", "EXAMPLE.COM", 23],
];

describe("countXText (x-weighted)", () => {
  it.each(cases)("%s", (_name, text, expected) => {
    expect(countXText(text)).toBe(expected);
  });

  it("has at least 30 corpus cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });

  it("is total on non-strings", () => {
    expect(countXText(undefined as unknown as string)).toBe(0);
  });

  it("is exposed as the custom rule x-weighted", () => {
    expect(xCountingRule).toMatchObject({ kind: "custom", name: "x-weighted", unit: "characters" });
    expect(xCountingRule.count("abc")).toBe(3);
  });
});

describe("hasLinkOrEmoji", () => {
  it("sees links and emoji only", () => {
    expect(hasLinkOrEmoji("plain words")).toBe(false);
    expect(hasLinkOrEmoji("go to example.com")).toBe(true);
    expect(hasLinkOrEmoji("nice \u{1F600}")).toBe(true);
    expect(hasLinkOrEmoji("file.txt")).toBe(false);
  });
});

describe("countXText stays linear on adversarial input", () => {
  it("counts a link followed by thousands of closing brackets quickly", () => {
    const text = "https://e.com/" + ")".repeat(19986);
    const started = performance.now();
    expect(countXText(text)).toBe(23 + 19986);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("counts a long hyphenated run quickly", () => {
    const text = "a-".repeat(10000);
    const started = performance.now();
    expect(countXText(text)).toBe(20000);
    expect(hasLinkOrEmoji(text)).toBe(false);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it.each([
    ["dotted hyphen chains", (Array(32).fill("a").join("-") + ".").repeat(313).slice(0, 20000)],
    ["short dotted labels", "a-a.".repeat(5000)],
  ])("counts %s with no TLD quickly", (_, text) => {
    expect(text).toHaveLength(20000);
    let started = performance.now();
    expect(countXText(text)).toBe(20000);
    expect(performance.now() - started).toBeLessThan(250);
    started = performance.now();
    expect(hasLinkOrEmoji(text)).toBe(false);
    expect(performance.now() - started).toBeLessThan(250);
  });
});
