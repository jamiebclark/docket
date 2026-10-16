// The one statement of the eligibility rule: which attention events reach a person, by kind and by
// platform. Pure, no I/O, never throws — what the SQL builders and `email-delivery` both compile
// against (data-model.md §3, FR-003, FR-014).
import { ATTENTION_MEMBER_OUTCOMES, CONNECT_FAILED } from "./attention";

export const OFF_SEQ = 9223372036854775807n; // bigint max; "off" (Q3)
export type SwitchAxis = "kind" | "platform";
export const ATTENTION_KINDS = ["failed", "ambiguous", "needs_reauth", "connect_failed", "engagement"] as const;

export interface PreferenceRow {
  axis: SwitchAxis;
  switchKey: string;
  onFromSeq: bigint | null;
}

/** Thresholds for one person in one project. A switch allows an event iff `seq > threshold`. */
export interface ProjectPreferences {
  kinds: ReadonlyMap<string, bigint>; // outcome -> threshold; absent = 0n; off = OFF_SEQ
  platforms: ReadonlyMap<string, bigint>; // provider key -> same
}

/** A row with `onFromSeq: null` becomes `OFF_SEQ`; an unknown axis is ignored rather than throwing. */
export function preferencesOf(rows: readonly PreferenceRow[]): ProjectPreferences {
  const kinds = new Map<string, bigint>();
  const platforms = new Map<string, bigint>();
  for (const row of rows) {
    const threshold = row.onFromSeq === null ? OFF_SEQ : row.onFromSeq;
    if (row.axis === "kind") kinds.set(row.switchKey, threshold);
    else if (row.axis === "platform") platforms.set(row.switchKey, threshold);
  }
  return { kinds, platforms };
}

/** `0n` when absent (N27). */
export function thresholdOf(map: ReadonlyMap<string, bigint>, key: string): bigint {
  return map.get(key) ?? 0n;
}

export function kindOn(p: ProjectPreferences, outcome: string): boolean {
  return thresholdOf(p.kinds, outcome) < OFF_SEQ;
}

/** The N33 roll-up and the only answer to "are notifications for this project off". */
export function anyKindOn(p: ProjectPreferences): boolean {
  return ATTENTION_KINDS.some((outcome) => kindOn(p, outcome));
}

/** The lowest threshold among the platforms an event records; `0n` for none recorded (N30). */
export function platformFloorOf(p: ProjectPreferences, keys: readonly string[]): bigint {
  if (keys.length === 0) return 0n;
  let floor: bigint | null = null;
  for (const key of keys) {
    const threshold = thresholdOf(p.platforms, key);
    if (floor === null || threshold < floor) floor = threshold;
  }
  return floor ?? 0n;
}

/** FR-003, whole: the floor, the kind axis and the platform axis, ANDed (N28). */
export function mayNotify(
  p: ProjectPreferences,
  event: { outcome: string; providerKeys: readonly string[]; seq: bigint },
  floor: bigint,
): boolean {
  return event.seq > floor && event.seq > thresholdOf(p.kinds, event.outcome) && event.seq > platformFloorOf(p, event.providerKeys);
}

/** What the SQL builder consumes, and the only thing it consumes (Q4, Q5, Q6). */
export interface EligibilityPlan {
  /** One per group of on member-outcomes sharing a position. Empty when all three are off. */
  memberGroups: { outcomes: readonly string[]; minSeq: bigint }[];
  /** Null when `connect_failed` is off. */
  connectFailed: { minSeq: bigint } | null;
  /** Null when the person has no platform switch for this project — then no clause is emitted. */
  platforms: { key: string; threshold: bigint }[] | null;
}

export function compileEligibility(p: ProjectPreferences): EligibilityPlan {
  const groups = new Map<string, string[]>();
  for (const outcome of ATTENTION_MEMBER_OUTCOMES) {
    const threshold = thresholdOf(p.kinds, outcome);
    if (threshold >= OFF_SEQ) continue;
    const groupKey = threshold.toString();
    const outcomes = groups.get(groupKey);
    if (outcomes) outcomes.push(outcome);
    else groups.set(groupKey, [outcome]);
  }
  const memberGroups = [...groups.entries()].map(([minSeq, outcomes]) => ({ outcomes, minSeq: BigInt(minSeq) }));
  const connectThreshold = thresholdOf(p.kinds, CONNECT_FAILED);
  const connectFailed = connectThreshold < OFF_SEQ ? { minSeq: connectThreshold } : null;
  const platforms = p.platforms.size === 0 ? null : [...p.platforms.entries()].map(([key, threshold]) => ({ key, threshold }));
  return { memberGroups, connectFailed, platforms };
}

/**
 * The platforms offered in the UI (N32, FR-019): registered, and either the project has an account
 * for it or the person has an off switch for it. A switch for an unregistered or disabled platform
 * still counts in `ProjectPreferences`; it is simply absent from this list.
 */
export function offeredPlatforms(
  p: ProjectPreferences,
  projectPlatformKeys: readonly string[],
  registered: readonly { key: string; name: string }[],
): { key: string; name: string; on: boolean }[] {
  const projectKeys = new Set(projectPlatformKeys);
  return registered
    .filter((r) => projectKeys.has(r.key) || thresholdOf(p.platforms, r.key) >= OFF_SEQ)
    .map((r) => ({ key: r.key, name: r.name, on: thresholdOf(p.platforms, r.key) < OFF_SEQ }));
}

/** The switch list "Turn all on" submits: the off kinds plus the off offered platforms (Q9, Q12). */
export function switchesToTurnAllOn(
  p: ProjectPreferences,
  offered: readonly { key: string; on: boolean }[],
): { axis: SwitchAxis; key: string }[] {
  const kinds = ATTENTION_KINDS.filter((outcome) => !kindOn(p, outcome)).map((key) => ({ axis: "kind" as const, key }));
  const platforms = offered.filter((o) => !o.on).map((o) => ({ axis: "platform" as const, key: o.key }));
  return [...kinds, ...platforms];
}

/** The switch list "Turn all off" submits: the four kinds (Q9, Q12). */
export function switchesToTurnAllOff(): { axis: SwitchAxis; key: string }[] {
  return ATTENTION_KINDS.map((key) => ({ axis: "kind" as const, key }));
}
