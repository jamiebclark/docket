# Phase 1 — Data model: notification preferences

Entities, invariants, the migration, and the exact shape of every statement that changes. Decision
numbers in parentheses: `N` = spec decisions, `Q` = plan decisions ([research.md](./research.md)),
`R`/`M` = shipped decisions from 022 and 056 in `docs/decisions.md`.

---

## 1. The table

```ts
// src/server/db/schema/notifications.ts
/**
 * One row per switch a person has touched, for one project. A switch is an attention kind (N1) or a
 * platform (a provider key). Absent means the switch is on with no position of its own (N27).
 * `on_from_seq`: NULL = off; a value = on, and only events with seq > it may notify through this
 * switch (N35). A row is never deleted to turn a switch on — it is rewritten with a position (Q2).
 */
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    projectId: uuid("project_id").notNull(),
    userId: uuid("user_id").notNull(),
    axis: text("axis").notNull(),               // 'kind' | 'platform'
    switchKey: text("switch_key").notNull(),    // an attention outcome, or a provider key
    onFromSeq: bigint("on_from_seq", { mode: "bigint" }),  // nullable: NULL = off
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (t) => [
    primaryKey({ name: "notification_preferences_pkey", columns: [t.projectId, t.userId, t.axis, t.switchKey] }),
    foreignKey({
      name: "notification_preferences_member_fk",
      columns: [t.projectId, t.userId],
      foreignColumns: [member.organizationId, member.userId],
    }).onDelete("cascade"),
    check("notification_preferences_axis", sql`${t.axis} IN ('kind', 'platform')`),
    check("notification_preferences_seq_nonneg", sql`${t.onFromSeq} IS NULL OR ${t.onFromSeq} >= 0`),
    check("notification_preferences_kind_key", sql`${t.axis} <> 'kind' OR ${t.switchKey} IN ('failed', 'ambiguous', 'needs_reauth', 'connect_failed')`),
    check("notification_preferences_key_format", sql`${t.switchKey} ~ '^[a-z0-9_-]{1,40}$'`),
  ],
);
```

- **No extra index.** Every read is "this person's switches for this project", a primary-key prefix
  scan on `(project_id, user_id)`.
- **No `ON UPDATE` clause on the FK** and no cascade from `activity_events`: a preference names a kind
  or a platform, never an event (N31).
- **`axis` is a `CHECK`, not a pg enum.** Two values that will not grow; a new enum type would be a
  migration liability for no gain. The kind list is a `CHECK` because it is already the N1 vocabulary
  frozen in `src/lib/activity/outcomes.ts` and in the log's own `activity_outcome` enum; the platform
  list is deliberately *not* constrained to the registry — platforms are plug-ins (constitution V) and
  a stored switch must outlive a provider being disabled (FR-019).
- **Registered in `src/server/db/project-owned.ts`** as
  `{ table: "notification_preferences", scopeColumn: "project_id" }`, so the project-scope harness
  fails any statement that touches it without pinning a project (constitution III, FR-022).

### Changed: `notification_states`

`muted boolean NOT NULL DEFAULT false` is **dropped** (N26, FR-001). Everything else —
`(project_id, user_id)`, `seen_seq`, `seen_at`, the member FK, the non-negative check — is untouched.
No row's `seen_seq` or `seen_at` changes in this entry, by migration or by a switch write (Q11).

### Unchanged: `notification_event_marks`, `activity_events`

No column, constraint or index changes on either. In particular `activity_events` keeps
`CHECK (cardinality(provider_keys) >= 1)` (Q22) and its two R4 partial indexes are still the only
notification-serving indexes on the log.

---

## 2. Invariants

| # | Invariant | Enforced by |
|---|---|---|
| **I1** | Absence of a row means the switch is on, with no position of its own. | Nothing to enforce — it is the absence. Every reader defaults to "on, threshold 0" (Q4). |
| **I2** | `on_from_seq IS NULL` ⟺ the switch is off. | The three-state column (Q2); one `coalesce(…, OFF_SEQ)` in every predicate (Q3). |
| **I3** | A switch-on never deletes the row; it writes a position. | `setSwitches` only ever upserts (Q2, Q8). A test asserts no `DELETE` on this table exists outside the cascade. |
| **I4** | A position only moves forward. | `GREATEST(existing, excluded)` on conflict, plus `newestAttentionSeq` being monotonic (Q10). |
| **I5** | An on-write only touches switches that are currently off. | `setSwitches` filters by the loaded state inside the locked transaction (Q9). |
| **I6** | An off-write marks nothing read and prunes nothing. | `setSwitches` takes neither branch for `on: false` (FR-007, Q11). |
| **I7** | No switch write touches `seen_seq` or `seen_at`. | `setSwitches` never names `notification_states` (Q11). |
| **I8** | A mark can only exist for an event that is still eligible, or below the floor (where it is pruned anyway). | The on-write prune (FR-008) plus 056's floor prune. Keeps N16's bound. |
| **I9** | The roll-up "notifications for this project are off" is never stored. | There is no column for it; `anyKindOn(prefs)` is the only answer (N26, N33). |
| **I10** | Every statement that reads the table pins one `project_id` (or runs inside the project-set section over the caller's own ids). | The project-owned registry + `tests/helpers/scope-check.ts` (FR-022). |

---

## 3. The compiled rule

`src/lib/notifications/eligibility.ts` — pure, the one statement of FR-003, and what `email-delivery`
will import unchanged (FR-014, Q4).

```ts
export const OFF_SEQ = 9223372036854775807n;              // bigint max; "off" (Q3)
export type SwitchAxis = "kind" | "platform";
export const ATTENTION_KINDS = ["failed", "ambiguous", "needs_reauth", "connect_failed"] as const;

export interface PreferenceRow { axis: SwitchAxis; switchKey: string; onFromSeq: bigint | null }

/** Thresholds for one person in one project. A switch allows an event iff `seq > threshold`. */
export interface ProjectPreferences {
  kinds: ReadonlyMap<string, bigint>;      // outcome -> threshold; absent = 0n; off = OFF_SEQ
  platforms: ReadonlyMap<string, bigint>;  // provider key -> same
}

export function preferencesOf(rows: readonly PreferenceRow[]): ProjectPreferences;
export function thresholdOf(map: ReadonlyMap<string, bigint>, key: string): bigint;  // absent -> 0n
export function kindOn(p: ProjectPreferences, outcome: string): boolean;             // threshold < OFF_SEQ
export function anyKindOn(p: ProjectPreferences): boolean;                           // the N33 roll-up
/** The lowest threshold among the platforms an event records; 0n for none recorded (N30). */
export function platformFloorOf(p: ProjectPreferences, keys: readonly string[]): bigint;
/** FR-003, whole: the floor, the kind axis and the platform axis, ANDed (N28). */
export function mayNotify(
  p: ProjectPreferences,
  event: { outcome: string; providerKeys: readonly string[]; seq: bigint },
  floor: bigint,
): boolean;

/** What the SQL builder consumes, and the only thing it consumes (Q4, Q5, Q6). */
export interface EligibilityPlan {
  /** One per group of on member-outcomes sharing a position. Empty when all three are off. */
  memberGroups: { outcomes: readonly string[]; minSeq: bigint }[];
  /** Null when `connect_failed` is off. */
  connectFailed: { minSeq: bigint } | null;
  /** Null when the person has no platform switch for this project — then no clause is emitted. */
  platforms: { key: string; threshold: bigint }[] | null;
}
export function compileEligibility(p: ProjectPreferences): EligibilityPlan;
```

`mayNotify` in one line: `seq > floor && seq > thresholdOf(kinds, outcome) && seq > platformFloorOf(p, keys)`.
`platformFloorOf` is `keys.length === 0 ? 0n : min(thresholdOf(platforms, k) for k in keys)` — so one
platform still on makes the whole event eligible, and exactly once (N29), while every platform off
makes the floor `OFF_SEQ` (nothing passes). The empty-key case is the only reason `0n` appears
(N30, Q22).

**Offered switches**, also pure (N32, FR-019):

```ts
export function offeredPlatforms(
  p: ProjectPreferences,
  projectPlatformKeys: readonly string[],         // platforms the project has live accounts for
  registered: readonly { key: string; name: string }[],  // platformOptions(): registry minus disabled mock
): { key: string; name: string; on: boolean }[];
```

Registry order; a platform is offered when it is registered **and** (the project has an account for it
**or** the person has an off switch for it). A switch stored for an unregistered or disabled platform
still counts in `ProjectPreferences` and is simply absent from this list.

---

## 4. The statements

All in `src/server/dal/notifications.ts` unless noted. 022's SQL rules hold throughout: no `OR`, no
`NOT` other than `IS NULL`/`IS NOT NULL`, every reference pinned to a project, attention outcomes as
SQL literals.

### 4.1 Reading the switches

```sql
SELECT axis, switch_key, on_from_seq::text AS on_from_seq
  FROM notification_preferences
 WHERE project_id = $1 AND user_id = $2
```

One primary-key prefix scan. The set version is one `UNION ALL` branch per project id, each pinned,
inside `runForProjectSet` (Q16).

### 4.2 Counting (`unreadCount`, `countUnread`)

`unreadBranches(projectId, userId, select, limit, opts)` gains `plan: EligibilityPlan` and loses
`unmutedOnly` (there is no `muted` column to filter on; a project with no kind on contributes no
branch at all). For each project it emits:

- one branch per `plan.memberGroups` entry:

  ```sql
  (SELECT <select> FROM activity_events
     JOIN notification_states ON notification_states.project_id = activity_events.project_id
                             AND notification_states.user_id = $uid
     JOIN member ON member.organization_id = activity_events.project_id AND member.user_id = $uid
     <mark anti-join, unchanged from M-series>
    WHERE activity_events.project_id = $pid
      AND activity_events.outcome IN ('failed', 'ambiguous')        -- literals, this group's outcomes
      AND activity_events.seq > notification_states.seen_seq
      AND activity_events.seq > 4210::bigint                        -- omitted when minSeq = 0
      <platform clause, §4.3>
      AND hidden.event_id IS NULL
    LIMIT 100)
  ```

- one branch for `plan.connectFailed` (with `actor_user_id = $uid`), same shape;
- **nothing** when `memberGroups` is empty and `connectFailed` is null.

The outer `SELECT count(*) … LIMIT 100` and the 100-cap are unchanged (N9, FR-010). With no stored
preference there is exactly one member group at position 0 and no platform clause, so the statement is
the one shipping today minus the `muted` filter.

### 4.3 The platform clause

Emitted only when `plan.platforms` is non-null (Q6):

```sql
AND activity_events.seq > (
      SELECT coalesce(min(coalesce(p.threshold, 0)), 0)
        FROM unnest(activity_events.provider_keys) AS pk(key)
        LEFT JOIN (VALUES ('tiktok', 9223372036854775807::bigint), ('facebook', 4210::bigint))
               AS p(key, threshold) ON p.key = pk.key)
```

`threshold` values are plan-time literals; `OFF_SEQ` for an off platform, the recorded position for one
turned back on. See the research table for the four cases it covers.

### 4.4 The panel (`listAttention`, `src/server/dal/activity.ts`)

Already one branch per outcome per project. It now takes the per-project `EligibilityPlan` and applies
the same two additions — the per-group `minSeq` and the platform clause — while **not** applying the
floor (the panel lists read rows too; `isNew` is computed from `seen_seq` as before). A project with no
kind on contributes no branch, and `recentPanel` leaves it out of the set anyway (FR-010, FR-012).

### 4.5 `nextChangeAt` (Q13, FR-011)

Per project, one branch per on-kind group plus one for `connect_failed`, joining the marks to their
events:

```sql
(SELECT min(m.counts_again_at) AS next
   FROM notification_event_marks m
   JOIN activity_events ae ON ae.project_id = m.project_id AND ae.id = m.event_id
   JOIN notification_states ns ON ns.project_id = m.project_id AND ns.user_id = m.user_id
   JOIN member ON member.organization_id = m.project_id AND member.user_id = $uid
  WHERE m.project_id = $pid AND m.user_id = $uid
    AND m.counts_again_at > now() AND m.counts_again_at < 'infinity'::timestamptz
    AND ae.outcome IN (<this group's literals>)
    AND ae.seq > ns.seen_seq
    AND ae.seq > <minSeq>::bigint          -- omitted at 0
    <platform clause on ae>)
```

Outer `min` over the branches, formatted to whole-millisecond ISO as today. A snooze on an event whose
kind or platform is now off therefore never arms the poller.

### 4.6 Writing switches (`setSwitches`)

One transaction, R3's order exactly (Q8):

1. `SET LOCAL lock_timeout = '<ms>'`
2. `SELECT projects.id FROM projects WHERE projects.id = $pid FOR UPDATE`
3. the test hook (`setNotificationsAfterLockHookForTests`), then the membership re-check →
   `not_member` if gone
4. load this person's switch rows for the project (§4.1) and drop the requested switches that are
   already in the wanted state → nothing left means `unchanged`, and the transaction commits having
   written nothing (I5, Q9)
5. for `on: true` only: `newestAttentionSeq(tx, projectId, userId)` → `P`
6. the upsert:

   ```sql
   INSERT INTO notification_preferences (project_id, user_id, axis, switch_key, on_from_seq)
   VALUES ($pid, $uid, 'kind', 'failed', <P | NULL>), …
   ON CONFLICT (project_id, user_id, axis, switch_key)
   DO UPDATE SET on_from_seq = GREATEST(notification_preferences.on_from_seq, excluded.on_from_seq),
                 updated_at = now()
   ```

   For an off-write `excluded.on_from_seq` is NULL and `GREATEST` would keep an existing position, so
   the off branch uses `DO UPDATE SET on_from_seq = NULL, updated_at = now()` instead. Two statements,
   one per direction, never mixed in one call.
7. for `on: true` only: the prune (§4.7)

Returns `{ outcome: "changed" | "unchanged" | "not_member"; marksPruned: number }`. A 55P03 anywhere
becomes `NotificationsBusyError` with nothing written (R3).

### 4.7 The prune on an on-write (FR-008, Q11)

In the same transaction, with the switches as they now stand:

```sql
WITH ineligible AS (
  SELECT m.event_id FROM notification_event_marks m
    JOIN activity_events ae ON ae.project_id = m.project_id AND ae.id = m.event_id
   WHERE m.project_id = $pid AND m.user_id = $uid
     AND ae.seq <= coalesce(<the event's kind threshold>, …)   -- see note
)
DELETE FROM notification_event_marks
 WHERE project_id = $pid AND user_id = $uid AND event_id IN (SELECT event_id FROM ineligible)
```

Because "no longer eligible" spans two axes and four kinds, the `ineligible` set is built the same way
every other statement is: one sub-branch per kind (literal outcome list, `ae.seq <= <threshold>`), plus
one for the platform axis (`ae.seq <= <the §4.3 subquery>`), `UNION ALL`-ed. Marks are capped at 200
per person per project, so the whole thing is bounded by that join. An off-write never runs it.

### 4.8 Membership, project and user deletion

Unchanged and untested-by-hand: the composite FK cascades. `MembersRepo.remove` and the leave path need
no new statement, and a rolled-back removal leaves the rows intact because the delete was in the same
transaction (FR-022, N8). `createAtCurrentPosition` (joining) writes **no** preference row — a new
member starts with everything on (FR-002, N7).

### 4.9 Platforms a project has accounts for (Q17)

- one project: `AccountsRepo.platformKeys()` →
  `SELECT DISTINCT provider_key FROM social_accounts WHERE project_id = $1 AND removed_at IS NULL`
- the caller's set: `platformsByProject()` → one such branch per project id, `UNION ALL`, inside
  `runForProjectSet`, returned as `Map<projectId, string[]>`.

Removing an account changes no preference and no past event's `provider_keys`, so filtering keeps
working for events whose account is gone — it only changes which switches are **offered** (N31, FR-004).

---

## 5. The migration (0021, Q24, FR-023, FR-024)

Generated by `pnpm db:generate`, then hand-ordered so the data step reads `muted` before it is dropped:

```sql
CREATE TABLE "notification_preferences" (…);
--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_member_fk"
  FOREIGN KEY ("project_id","user_id") REFERENCES "public"."member"("organization_id","user_id") ON DELETE cascade;
--> statement-breakpoint
-- Every muted project becomes all four kinds off, so no one's choice is lost (N26). Unmuted rows get
-- nothing: absent means on (N27). No seen_seq, seen_at or sparse mark is touched.
INSERT INTO "notification_preferences" ("project_id", "user_id", "axis", "switch_key", "on_from_seq")
SELECT s."project_id", s."user_id", 'kind', k."key", NULL
  FROM "notification_states" s
 CROSS JOIN (VALUES ('failed'), ('ambiguous'), ('needs_reauth'), ('connect_failed')) AS k("key")
 WHERE s."muted" = true
ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE "notification_states" DROP COLUMN "muted";
```

- **Safe on a live install with existing rows**, no operator step, no notification state reset: one
  `CREATE TABLE`, one bounded `INSERT` (at most four rows per muted membership), one `DROP COLUMN`.
  `DROP COLUMN` is a catalogue-only change in Postgres.
- **Nothing is lost and nothing is invented**: a muted project reads as off through the roll-up, an
  unmuted one reads as fully on, and every `seen_seq`, `seen_at` and mark is byte-identical afterwards.
- **Reversal** (recorded in `docs/decisions.md` next to N5/N26): re-add `muted boolean NOT NULL DEFAULT
  false`, set it to true where no kind is on, drop the table. Lossy exactly where the forward migration
  is generous — someone who had turned off a single kind comes back unmuted.
- `pnpm db:check` must be green: the snapshot has to match the schema file, and `drizzle-kit check`
  the journal.

---

## 6. Entity summary

| Entity | Stored | Keyed by | Lifetime |
|---|---|---|---|
| **Notification preference** (new) | `on_from_seq` (NULL = off) | project, person, axis, switch key | Cascades with the membership, project or user. Never per account, never per event (N31). |
| **Notification state** (changed) | `seen_seq`, `seen_at` | project, person | Unchanged; no longer holds a mute (FR-001). |
| **Notification event mark** (unchanged) | `counts_again_at`, `event_seq` | project, person, event | Unchanged in meaning; an on-write prunes the ones it makes redundant (FR-008). |
| **Eligible attention event** | not stored | — | Derived by `mayNotify` (FR-003); the one question every surface asks (FR-010). |
| **Offered switch set** | not stored | — | Derived by `offeredPlatforms` from the registry, the project's live accounts and the person's off switches (FR-019). |
