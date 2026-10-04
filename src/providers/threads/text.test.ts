import { describe, expect, it } from "vitest";
import { countThreadsText, threadsCountingRule } from "./text";

describe("threadsCountingRule", () => {
  it("is named and has a unit", () => {
    expect(threadsCountingRule).toMatchObject({ kind: "custom", name: "threads", unit: "characters" });
  });
  it.each([
    ["😀", 4],
    ["👍🏽", 8],
    ["👨‍👩‍👧‍👦", 25],
    ["🇫🇷", 8],
    ["1️⃣", 7],
    ["é", 1],
    ["é", 2],
    ["日", 1],
    ["☺", 3],
    ["☺️", 6],
    ["©", 2],
    ["", 0],
    ["a".repeat(496) + "😀", 500],
    ["a".repeat(497) + "😀", 501],
  ])("counts %j as %i", (text, expected) => {
    expect(countThreadsText(text)).toBe(expected);
  });
});
