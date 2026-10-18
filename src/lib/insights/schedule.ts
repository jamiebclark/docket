const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Pure, total, no clock and no database (research.md §5). Bands are half-open on their upper end;
 * a candidate on or after `publishedAt + 28d` is suppressed to `null` rather than scheduled for a
 * poll that will land on an already-frozen target.
 */
export function nextPostPollAt(input: { publishedAt: Date; lastCapturedAt: Date | null; now: Date; minIntervalMs: number }): Date | null {
  const publishedAtMs = input.publishedAt.getTime();
  const nowMs = input.now.getTime();
  const lastCapturedAtMs = input.lastCapturedAt?.getTime() ?? null;
  const ageMs = nowMs - publishedAtMs;
  const freezeAtMs = publishedAtMs + 28 * DAY_MS;

  if (ageMs >= 28 * DAY_MS) {
    return lastCapturedAtMs === null ? new Date(nowMs) : null;
  }

  let candidateMs: number;
  if (ageMs < 24 * HOUR_MS) {
    candidateMs = lastCapturedAtMs !== null ? lastCapturedAtMs + HOUR_MS : publishedAtMs + HOUR_MS;
  } else if (ageMs < 7 * DAY_MS) {
    const floor = publishedAtMs + 24 * HOUR_MS;
    candidateMs = Math.max(lastCapturedAtMs !== null ? lastCapturedAtMs + DAY_MS : floor, floor);
  } else {
    const floor = publishedAtMs + 7 * DAY_MS;
    candidateMs = Math.max(lastCapturedAtMs !== null ? lastCapturedAtMs + 7 * DAY_MS : floor, floor);
  }

  if (candidateMs >= freezeAtMs) return null;
  if (lastCapturedAtMs !== null) candidateMs = Math.max(candidateMs, lastCapturedAtMs + input.minIntervalMs);
  return new Date(candidateMs);
}

export type PostPollDecision = { kind: "due"; at: Date } | { kind: "frozen"; reason: "settled" | "expired" };

/**
 * Pure, total, no clock, no database. Delegates to `nextPostPollAt` for a non-ephemeral subject
 * (`chosenPostType` null, or no declaration matches it) — byte-identical to 080 (FR-043).
 */
export function postPollDecision(input: {
  publishedAt: Date;
  lastCapturedAt: Date | null;
  now: Date;
  minIntervalMs: number;
  chosenPostType: string | null;
  ephemeralPostTypes?: readonly { postType: string; lifetimeMs: number }[];
}): PostPollDecision {
  const match = input.chosenPostType === null
    ? undefined
    : input.ephemeralPostTypes?.find((t) => t.postType === input.chosenPostType);

  if (!match) {
    const next = nextPostPollAt(input);
    return next === null ? { kind: "frozen", reason: "settled" } : { kind: "due", at: next };
  }

  const publishedAtMs = input.publishedAt.getTime();
  const nowMs = input.now.getTime();
  const lastCapturedAtMs = input.lastCapturedAt?.getTime() ?? null;
  const expiresAtMs = publishedAtMs + match.lifetimeMs;

  if (nowMs >= expiresAtMs) return { kind: "frozen", reason: "expired" };

  let candidateMs = (lastCapturedAtMs ?? publishedAtMs) + HOUR_MS;
  if (lastCapturedAtMs !== null) candidateMs = Math.max(candidateMs, lastCapturedAtMs + input.minIntervalMs);

  if (candidateMs >= expiresAtMs) return { kind: "frozen", reason: "expired" };
  return { kind: "due", at: new Date(candidateMs) };
}

/** An account never freezes (FR-029): always due, never `null`. */
export function nextAccountPollAt(input: { lastCapturedAt: Date | null; now: Date; intervalMs: number; minIntervalMs: number }): Date {
  if (input.lastCapturedAt === null) return new Date(input.now.getTime());
  const lastCapturedAtMs = input.lastCapturedAt.getTime();
  return new Date(Math.max(lastCapturedAtMs + input.intervalMs, lastCapturedAtMs + input.minIntervalMs));
}
