export type Milestone = 0 | 25 | 50 | 75 | 100;
const MILESTONES: readonly Milestone[] = [0, 25, 50, 75, 100];

/**
 * The milestones passed when progress moves from `prevPct` to `pct`. Pass the highest percentage already seen
 * (start at -1), so a Retry that resumes below it announces nothing twice.
 */
export function milestonesCrossed(prevPct: number, pct: number): Milestone[] {
  return MILESTONES.filter((m) => prevPct < m && m <= pct);
}

/** `floor(sent / total × 100)`, never above 100. */
export function percentOf(sent: number, total: number): number {
  return total > 0 ? Math.min(100, Math.floor((sent / total) * 100)) : 0;
}
