// lib/insights/shape: what a metric's shape means downstream (G38, contracts/metric-shape.md §3).
// Pure, total, no clock and no database.
import type { MetricShape } from "../../providers/types";

/** False for `unknown`: absent from every trend, comparison and derived figure (FR-004). */
export function isPlottable(shape: MetricShape): boolean {
  return shape.kind !== "unknown";
}

/** The sentence shown where an `unknown` key's series would be. Null for every other shape. */
export function shapeNote(shape: MetricShape): string | null {
  return shape.kind === "unknown" ? shape.reason : null;
}
