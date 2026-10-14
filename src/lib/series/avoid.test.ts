import { describe, expect, it } from "vitest";
import { AVOID_TITLES_MAX, avoidTitles } from "./avoid";

describe("avoidTitles", () => {
  it("orders titles newest-run-first", () => {
    const result = avoidTitles([
      { angles: [{ title: "Newer" }] },
      { angles: [{ title: "Older" }] },
    ]);
    expect(result).toEqual(["Newer", "Older"]);
  });

  it("de-duplicates case-insensitively, keeping the first occurrence", () => {
    const result = avoidTitles([
      { angles: [{ title: "Hello World" }] },
      { angles: [{ title: "hello world" }, { title: "Other" }] },
    ]);
    expect(result).toEqual(["Hello World", "Other"]);
  });

  it("caps at AVOID_TITLES_MAX", () => {
    const angles = Array.from({ length: AVOID_TITLES_MAX + 5 }, (_, i) => ({ title: `Title ${i}` }));
    const result = avoidTitles([{ angles }]);
    expect(result).toHaveLength(AVOID_TITLES_MAX);
  });

  it("returns an empty array for empty input", () => {
    expect(avoidTitles([])).toEqual([]);
  });
});
