// lib/insights/floor: the comparisons' sample-size floor (contracts/comparisons.md §1). Two
// constants, not configuration — a knob here would let an operator turn the honesty off.
export const RANK_MIN = 8;
export const PROVISIONAL_MIN = 4;

export type Verdict = "ranked" | "provisional" | "suppressed";

export function verdictFor(sampleSize: number): Verdict {
  if (sampleSize >= RANK_MIN) return "ranked";
  if (sampleSize >= PROVISIONAL_MIN) return "provisional";
  return "suppressed";
}
