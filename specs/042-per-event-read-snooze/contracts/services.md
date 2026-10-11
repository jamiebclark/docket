# Contract: DAL and services

Signatures only; the SQL behind them is in [data-model.md §4](../data-model.md#4-statements-that-change) and
the reasoning in [research.md](../research.md). Nothing here imports the database client outside
`src/server/dal/`, and no caller outside `src/server/services/` touches the DAL.

## 1. `src/lib/notifications/snooze.ts` (new, pure)

```ts
/** The three fixed choices (N17). The order is the order they are offered in. */
export const SNOOZE_CHOICES = ["hour", "tomorrow", "next_week"] as const;
export type SnoozeChoice = (typeof SNOOZE_CHOICES)[number];

/** The control labels: "1 hour", "Tomorrow morning", "Next week". */
export const SNOOZE_LABEL: Record<SnoozeChoice, string>;

/** 09:00 — the start of a working day (the spec's wording choice, named once). */
export const MORNING_HOUR = 9;

export function parseSnoozeChoice(value: unknown): SnoozeChoice | null;

/**
 * The absolute instant the event comes back, resolved once, now (N17, FR-009).
 * - "hour": exactly one hour after `now`.
 * - "tomorrow": MORNING_HOUR on the next calendar day in `timeZone`.
 * - "next_week": MORNING_HOUR on the next Monday strictly after today in `timeZone`.
 * The two wall-clock choices go through `toZonedDateTime(timeZone, { disambiguation: "compatible" })`:
 * a wall time that does not exist (spring forward) moves to just after the gap; an ambiguous one
 * (autumn back) takes the earlier offset — the rule Docket already uses for posting slots (research D2).
 * Truncated to whole milliseconds. Always strictly after `now`; throws if it ever is not.
 */
export function resolveSnooze(choice: SnoozeChoice, now: Date, timeZone: string): Date;
```

## 2. `src/lib/notifications/attention.ts`

```ts
/** A person may hold at most this many sparse marks per project — twice UNREAD_CAP, so 200 (N16.3). */
export const EVENT_MARK_CAP = UNREAD_CAP * 2;
```

Everything else in the module is unchanged.

## 3. `src/server/dal/notifications.ts`

```ts
/** What a row action did. `atCap` and `notFound` wrote nothing. */
export type MarkOutcome =
  | { kind: "changed"; floorMoved: boolean }
  | { kind: "unchanged" }      // the floor is already at or past the event (M10)
  | { kind: "not_found" }      // no such attention event for this person in this project (N23)
  | { kind: "at_cap" }         // EVENT_MARK_CAP reached for this project (FR-007)
  | { kind: "not_member" };

export interface WriteOutcome {
  outcome: "changed" | "unchanged" | "not_member";
  /** Pruned marks whose instant was finite and still in the future — what the confirmation names (FR-013). */
  snoozesCleared: number;
}

export interface NotificationsRepo {
  get(): Promise<NotificationStateRow | null>;

  /** Attention events above the floor with no mark still in the future, `muted = false` only, capped. */
  unreadCount(cap?: number): Promise<number>;

  createAtCurrentPosition(): Promise<void>;

  /**
   * Unchanged order (R3), two additions: when the floor rises it prunes every mark at or below the new
   * floor in the same transaction (FR-005), and it reports how many live snoozes that cleared (FR-013).
   */
  write(change: { markRead: boolean; muted?: boolean }): Promise<WriteOutcome>;

  /**
   * One row action, in R3's transaction (M12). `countsAgainAt: "never"` is "Mark read"; a Date is a snooze.
   * Resolves the event inside this project with the attention predicate, refuses at or below the floor and
   * at the cap, upserts the mark, then pulls the floor up as far as the oldest uncovered event allows and
   * prunes (M7). Throws NotificationsBusyError on a lock timeout, having written nothing.
   */
  markEvent(input: { eventId: string; countsAgainAt: Date | "never" }): Promise<MarkOutcome>;

  /** How many marks this person holds for this project (cap surfacing). */
  markCount(): Promise<number>;
}

export interface NotificationsSetReader {
  countUnread(cap?: number): Promise<number>;
  projectsWithUnread(): Promise<string[]>;
  /** Marks per project for this person, for `actionsAvailable` (FR-020). Projects with none are absent. */
  markCounts(): Promise<Map<string, number>>;
  /** The soonest live snooze over the given (notifications-on) projects, or null (FR-021, M17). */
  nextChangeAt(): Promise<Date | null>;
  /** The caller's attention event with this id, in one of the given projects, or null (N23, M11). */
  resolveAttentionEvent(eventId: string): Promise<{ projectId: string; seq: bigint } | null>;
}
```

`NotificationsBusyError`, `setNotificationsLockTimeoutForTests` and
`setNotificationsAfterLockHookForTests` keep their meaning; the after-lock hook now also lets a test
interleave a writer with a row action (US3-AS4, AS5).

## 4. `src/server/dal/activity.ts`

```ts
/** A panel row plus this person's mark state for it (M16). */
export type AttentionRecord = ActivityRecord & {
  /** A mark whose instant is still in the future: having excluded live snoozes, this means "read" (N20). */
  hiddenByMark: boolean;
};

createActivityReader(db, allowedProjectIds, opts).listAttention(q: {
  projectIds: readonly string[];
  userId: string;
  limit: number;
}): Promise<AttentionRecord[]>;
```

Currently snoozed events are excluded inside each branch, so `limit` rows are returned after the exclusion.
`ActivityRecord`, `list` and `summary` are unchanged, and nothing else in Activity — its kinds, outcomes,
messages, filters, ordering, row links or public API — changes (spec Out of Scope).

## 5. `src/server/dal/my-projects.ts` — `ProjectSetScope.notifications`

```ts
readonly notifications: {
  countUnread(): Promise<number>;
  recent(limit: number): Promise<AttentionRecord[]>;
  projectsWithUnread(): Promise<string[]>;
  write(projectId: string, change: { markRead: boolean; muted?: boolean }): Promise<WriteOutcome>;

  /** Over the notifications-on projects (FR-021). */
  nextChangeAt(): Promise<Date | null>;
  /** Over every project in the set, muted or not (FR-020). */
  markCounts(): Promise<Map<string, number>>;
  /** Which of the caller's projects owns this attention event; null is the only answer for anything else. */
  resolveAttentionEvent(eventId: string): Promise<{ projectId: string; seq: bigint } | null>;
  /** One row action. A projectId outside the set throws NotFoundError before any SQL, as `write` does. */
  markEvent(projectId: string, input: { eventId: string; countsAgainAt: Date | "never" }): Promise<MarkOutcome>;
};
```

Every one of these runs inside `runForProjectSet({ reason: "activity: my projects", projectIds }, …)`, so the
harness checks each project pin against the caller's resolved set, and `check(projectId)` still throws
`NotFoundError` before any SQL for an id outside it (US7-AS3).

## 6. `src/server/services/notifications/index.ts`

```ts
/** + nextChangeAt. An empty set is { 0, "", "No unread problems", null }. */
export function unreadSummary(set: ProjectSetScope): Promise<UnreadSummary>;

/** Snoozed events excluded, `isNew` from the mark, `actionsAvailable` per project (FR-018, FR-020). */
export function recentPanel(set: ProjectSetScope, now: Date): Promise<NotificationPanel>;

/** + snoozesCleared, summed over the projects it marked, for the confirmation (FR-013). */
export function markAllRead(set: ProjectSetScope): Promise<{ marked: number; busy: string[]; snoozesCleared: number }>;

/** Unchanged signature; the pruning happens inside `write` (N19, US3-AS3). */
export function markProblemsView(set: ProjectSetScope, scope: ProblemsViewScope): Promise<void>;

export interface RowActionResult {
  eventId: string;
  projectName: string;
  /** The instant it comes back, for a snooze; null for "Mark read". */
  until: Date | null;
  /** The project's zone, for the confirmation's wording (FR-016). */
  timeZone: string;
  /** The caller's summary after the change, so the bell updates without a second round trip. */
  unread: UnreadSummary;
  /** True when the floor is already at or past the event: nothing was written, nothing is announced (M10). */
  noop: boolean;
}

/**
 * "Mark read" on one problem. Validates `{ eventId }` with Zod, resolves the project inside the caller's
 * set, writes the mark, then recomputes the summary.
 * Throws NotFoundError for an unknown, foreign or non-attention id (one answer for all three, N23),
 * NotificationMarkCapError at the cap, NotificationsBusyError on a busy lock, ForbiddenError for a
 * non-member actor (an API key or a job runner, FR-025).
 */
export function markEventRead(set: ProjectSetScope, input: unknown): Promise<RowActionResult>;

/**
 * "Snooze" on one problem. Validates `{ eventId, choice }`, resolves the project (and so its time zone),
 * resolves the choice to an absolute instant with `resolveSnooze` (N17) and writes it. Same errors.
 */
export function snoozeEvent(set: ProjectSetScope, input: unknown): Promise<RowActionResult>;
```

```ts
/** The project holds EVENT_MARK_CAP marks for this person: nothing was written (FR-007). */
export class NotificationMarkCapError extends Error {
  name = "NotificationMarkCapError";
}
```

`projectUnread` (the callout), `setNotificationsBySlug`, `setMyProjectNotifications`, `myProjectStates` and
`myStateForProject` keep their signatures. `projectUnread` needs **no change at all**: it calls
`unreadCount`, which now honours the marks, so individually-read and snoozed problems leave the callout and
it is still hidden at zero and when muted (FR-019, US5-AS2, AS3).

`NotificationMarkCapError` is not added to `failFromError`'s map: the two server actions catch it by class
and map it to the `at_cap` row-error code, exactly as `setNotifications` already does for
`NotificationsBusyError` (M18).

## 7. `src/server/services/notifications/panel.ts`

```ts
export function toNotificationItem(
  record: AttentionRecord,
  seenSeqByProject: ReadonlyMap<string, bigint>,
  markCounts: ReadonlyMap<string, number>,
): NotificationItem;
```

`isNew = seq > seen && !record.hiddenByMark`; `actionsAvailable = (markCounts.get(projectId) ?? 0) <
EVENT_MARK_CAP`. A project with no reading-position row is still never "new", as today.

## 8. Server actions — `src/app/notifications/actions.ts`

```ts
export interface RowDone {
  eventId: string;
  outcome: "read" | "snoozed" | "unchanged";
  /** ISO 8601 UTC, for a snooze. */
  snoozedUntil: string | null;
  /** The sentence to announce politely; "" for `unchanged` (N12, FR-017). */
  announcement: string;
  unread: UnreadSummary;
}

export function markEventRead(prev: ActionResult<RowDone> | null, formData: FormData): Promise<ActionResult<RowDone>>;
export function snoozeEvent(prev: ActionResult<RowDone> | null, formData: FormData): Promise<ActionResult<RowDone>>;
```

- Fields read: `eventId` (uuid, Zod), `choice` (snooze only, one of the three keys) and `returnTo`.
- `safeReturnTo` still accepts **only** `/notifications`; anything else is ignored (R13).
- With `returnTo` (the no-JavaScript path) the action redirects to `/notifications` with a confirmation
  parameter; without it, it returns the `ActionResult` so the panel updates in place (FR-016, FR-017, M18).
- No session ⇒ `redirect("/login?next=/notifications")`, as the existing actions do. An API-key or
  job-runner actor is refused by the service (`ForbiddenError`), since a server action only ever has a
  session (FR-025, US7-AS4).
- `markAllRead` keeps its signature and gains `snoozesCleared` inside its `data`, so both the panel and the
  page can say that snoozed problems were cleared too (US3-AS2).

## 9. Redirect parameters on `/notifications` (no JavaScript)

| Parameter | Set by | Renders |
|---|---|---|
| `?read=1` | `markEventRead` | success `Alert`: "Marked as read." plus the new count |
| `?snoozed=<projectSlug>&until=<iso>` | `snoozeEvent` | success `Alert`: "Snoozed until Mon, Oct 12, 9:00 AM EDT." in that project's zone, resolved from the caller's own set; a slug outside the set renders the generic "Snoozed." |
| `?rowError=busy\|not_found\|at_cap\|invalid` | either | danger `Alert` from `rowErrorText` ([ui.md §4](./ui.md#4-wording)) |
| `?marked=1[&busy=…][&snoozes=<n>]` | `markAllRead` | existing confirmation, plus the cleared-snoozes sentence when `n > 0` |

`until` is parsed as an instant and re-formatted through `formatLocal`; it is never echoed as text.
An unparsable value falls back to the generic "Snoozed."
