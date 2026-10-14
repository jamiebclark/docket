// Pure: which titles a standing series' next plan should avoid.

export const AVOID_RUNS = 3;
export const AVOID_TITLES_MAX = 20;

interface PlanWithAngles {
  angles: { title: string }[];
}

/** Titles of the most recent runs' plans, newest first, de-duplicated case-insensitively,
 *  capped at AVOID_TITLES_MAX. */
export function avoidTitles(plans: readonly PlanWithAngles[]): string[] {
  const seen = new Set<string>();
  const titles: string[] = [];
  for (const plan of plans) {
    for (const angle of plan.angles) {
      const key = angle.title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      titles.push(angle.title);
      if (titles.length >= AVOID_TITLES_MAX) return titles;
    }
  }
  return titles;
}
