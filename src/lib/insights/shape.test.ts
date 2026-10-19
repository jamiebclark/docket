import { describe, expect, it } from "vitest";
import type { MetricShape } from "../../providers/types";
import { isPlottable, shapeNote } from "./shape";

describe("isPlottable", () => {
  it("is true for cumulative", () => {
    expect(isPlottable({ kind: "cumulative" })).toBe(true);
  });

  it("is true for windowed", () => {
    expect(isPlottable({ kind: "windowed", windowMs: 86_400_000 })).toBe(true);
  });

  it("is false for unknown", () => {
    expect(isPlottable({ kind: "unknown", reason: "no period stated" })).toBe(false);
  });
});

describe("shapeNote", () => {
  it("is null for cumulative", () => {
    expect(shapeNote({ kind: "cumulative" })).toBeNull();
  });

  it("is null for windowed", () => {
    expect(shapeNote({ kind: "windowed", windowMs: null })).toBeNull();
  });

  it("is the reason for unknown", () => {
    const shape: MetricShape = { kind: "unknown", reason: "no period stated" };
    expect(shapeNote(shape)).toBe("no period stated");
  });
});
