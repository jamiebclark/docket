import { describe, expect, it } from "vitest";
import { countCodePoints, countGraphemes, countText, countUtf8Bytes } from "./text";

const cases: [string, string, number, number, number][] = [
  ["ASCII", "hello", 5, 5, 5],
  ["ZWJ family emoji", "👨‍👩‍👧‍👦", 1, 7, 25],
  ["combining mark (precomposed)", "é", 1, 1, 2],
  ["combining mark (decomposed)", "é", 1, 2, 3],
  ["CJK", "日本語", 3, 3, 9],
  ["flag emoji", "🇬🇧", 1, 2, 8],
  ["empty string", "", 0, 0, 0],
];

describe("text counting", () => {
  it.each(cases)("%s", (_name, text, graphemes, codePoints, bytes) => {
    expect(countGraphemes(text)).toBe(graphemes);
    expect(countCodePoints(text)).toBe(codePoints);
    expect(countUtf8Bytes(text)).toBe(bytes);
    expect(countText(text, "graphemes")).toBe(graphemes);
    expect(countText(text, "code_points")).toBe(codePoints);
    expect(countText(text, "utf8_bytes")).toBe(bytes);
  });
});
