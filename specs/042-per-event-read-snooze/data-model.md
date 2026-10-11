# Data model: Per-event read state and snooze

The reasoning behind each shape is in [research.md](./research.md) (M1–M18). The interfaces are in
[contracts/services.md](./contracts/services.md).

## 1. New table `notification_event_marks` (project-owned)

At most one row per person, per project and per attention event, and **only above that person's floor for
that project**. One row says when that event counts again (FR-002, N15).

Schema file: `src/server/db/schema/notifications.ts`, next to `notificationStates`.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `project_id` | `uuid` | no | — | The scope column. Part of the PK and of the membership FK. |
| `user_id` | `uuid` | no | — | Part of the PK and of the membership FK. Always the session's own user. |
| `event_id` | `uuid` | no | — | `activity_events.id` — the only identifier the browser ever names (N23). |
| `event_seq` | `bigint` (`mode: "bigint"`) | no | — | The event's `seq`, copied at write time (M3). Compared with `notification_states.seen_seq` for the "above the floor" invariant and for the prune. The log is append-only, so it never changes. |
| `counts_again_at` | `timestamptz` | no | — | The instant from which the event counts again. `'infinity'` = read for ever; a finite value = snoozed until then (M2). |
| `created_at` | `timestamptz` | no | `now()` | When the first mark for this event was written. |
| `updated_at` | `timestamptz` | no | `now()`, `$onUpdate` | Moves when the choice is replaced (re-snooze, or mark read over a snooze). |

### Constraints

- **PK** `notification_event_marks_pkey (project_id, user_id, event_id)`.
  This is "at most one mark per person, project and event" as a database fact (FR-002), and the full prefix
  the count's anti-join probes (M15).
- **FK** `notification_event_marks_member_fk`: `(project_id, user_id)` → `member (organization_id, user_id)`
  `ON DELETE CASCADE`, against the existing unique index `member_organization_user_uidx`. The same key shape
  as `notification_states_member_fk`, so the floor, the mute and the marks can never diverge (M5, FR-027):
  - remove member and leave project delete the marks in the same statement, and so the same transaction, and
    keep them on rollback (US6-AS1, US6-AS2);
  - project deletion (`organization` → `member`) and user deletion (`user` → `member`) delete them too
    (US6-AS3);
  - a rejoin is a new `member` row, so the person starts with no mark (US6-AS4);
  - a role change does not touch the key, so marks survive it.
- **FK** `notification_event_marks_event_fk`: `(event_id)` → `activity_events (id)` `ON DELETE CASCADE`.
  Insurance only: the log is append-only, and project deletion already removes both sides.
- **CHECK** `notification_event_marks_seq_positive`: `event_seq > 0`.
- **CHECK** `notification_event_marks_ms`:
  `counts_again_at = date_trunc('milliseconds', counts_again_at)`. Holds for `'infinity'`, which
  `date_trunc` returns unchanged (M4).

### The three Postgres facts the design leans on

Checked against this project's own Postgres 17 (`docket-pg`) while planning, and asserted again by
`marks-migration.test.ts` rather than left to trust:

| Expression | Result | Why it matters |
|---|---|---|
| `date_trunc('milliseconds', 'infinity'::timestamptz) = 'infinity'::timestamptz` | `true` | the millisecond CHECK accepts a read mark |
| `'infinity'::timestamptz > now()` | `true` | the "hidden now" anti-join catches read marks as well as live snoozes |
| `'infinity'::timestamptz < 'infinity'::timestamptz` | `false` | the "snoozed now" anti-join excludes read marks, so a read row stays in the panel (N20) |

**Driver note.** `node-postgres` parses an infinite `timestamptz` to the JavaScript number `Infinity`, not a
`Date`, so `counts_again_at` is never selected raw into application code: `"never"` is written as the SQL
literal `'infinity'::timestamptz`, `nextChangeAt` selects only finite instants (§4.7), and the prune counts
the snoozes it cleared in SQL (§4.3). The one value that does cross into TypeScript is a finite snooze
instant.

### Indexes

| Index | Columns | Serves |
|---|---|---|
| (the PK) | `(project_id, user_id, event_id)` | the count's and the panel's per-event anti-join probes; the row-action upsert |
| `notification_event_marks_floor_idx` | `(project_id, user_id, event_seq)` | the prune (`event_seq <= newFloor`), the cap count, the next-change scan, the floor-follow's probes |

**No change to `activity_events`** — no column, no CHECK, no index (M6). R4's two partial indexes still drive
every scan over the log, so FR-004's "index-backed" promise holds for the count and for the floor-follow.

### Registration

- One line in `projectOwnedTables` (`src/server/db/project-owned.ts`):
  `{ table: "notification_event_marks", scopeColumn: "project_id" }` — so `tests/helpers/scope-check.ts`
  fails any statement that touches the table without pinning a project (FR-027, US7-AS3).
- Exported from `src/server/db/schema/index.ts` through the existing `export * from "./notifications"`.
- `projectOwnedTables` / `notProjectOwned` coverage test in `src/server/db/project-owned.test.ts` picks the
  new table up automatically.

## 2. The four invariants

| # | Invariant | Enforced by | Proved by |
|---|---|---|---|
| **I1** | A mark exists only **above** the floor: for every row, `event_seq > notification_states.seen_seq` for the same `(project_id, user_id)`. | Row actions refuse to write at or below the floor (M10); every floor rise prunes in the same transaction. | `marks.test.ts` asserts it after each of the N4 paths and after every row-action ordering; `cap.test.ts` after filling to 200 and marking all read. |
| **I2** | The floor never falls. | The existing `GREATEST(seen_seq, excluded.seen_seq)` upsert, and `newFloor > seen_seq` guard. | `mark-read.test.ts` two-tab cases (US3-AS5, AS6). |
| **I3** | At most 200 marks per `(project_id, user_id)`. | The cap check inside the locked transaction, before any write (M9). | `cap.test.ts`, including two tabs racing at 199. |
| **I4** | A mark's `project_id` is its event's `project_id`, and `event_seq` is that event's `seq`. | Both are read from one row resolved by `WHERE project_id = $p AND id = $e AND <attention predicate>` inside the lock (M11). | `marks.test.ts` cross-checks every mark against `activity_events` after a mixed run. |

## 3. Meaning of a mark (one comparison)

Let `C` be `counts_again_at` and `T` the transaction's `now()` (M14).

| State | Condition | Counts? | In the panel / `/notifications` / callout? | "New" marker? | In Activity? |
|---|---|---|---|---|---|
| no mark, above the floor | — | yes | yes | yes | yes |
| at or below the floor | `seq <= seen_seq` | no | yes (the panel lists the newest 10 regardless) | no | yes |
| individually read | `C = 'infinity'` | no | **yes** (N20) | no | yes |
| snoozed | `T < C < 'infinity'` | no | **no** (N20, FR-010) | — | yes, for everyone (N5) |
| expired snooze | `C <= T` | yes | yes | yes | yes |
| any of the above, muted project | — | no | no | — | yes |

**Counted** ⟺ above the floor, project not muted, still a member, an attention event for this person
(N1), and no mark with `C > T` (FR-003). Note what is absent: no join to `posts`, `post_targets` or
`social_accounts`, so a retried, published or resolved target changes nothing (N18, FR-012, US2-AS6).

## 4. Statements that change

Every statement below pins `project_id`, joins `member` for the caller, writes the attention outcomes as SQL
literals, and uses no `OR` and no `NOT` other than an `IS NULL` / `IS NOT NULL` anti-join (M15). The
cross-project ones run inside `runForProjectSet` over the caller's own resolved set.

### 4.1 `unreadBranches` — the count (FR-003, FR-004)

Each of the two existing branches per project gains one anti-join, keeping its `LIMIT cap`:

```text
LEFT JOIN notification_event_marks hidden
       ON hidden.project_id = activity_events.project_id
      AND hidden.user_id    = $userId
      AND hidden.event_id   = activity_events.id
      AND hidden.counts_again_at > now()
...
WHERE ... AND hidden.event_id IS NULL
```

Used unchanged by `NotificationsRepo.unreadCount` (the callout, FR-019), by
`NotificationsSetReader.countUnread` (the bell, the refresh and the panel's summary) and by the per-project
and project-set readers alike, so no caller can see a different answer (FR-004). The outer `LIMIT 100` and
the per-branch `LIMIT 100` are untouched (N9), so counting still stops at 100 with marks in play.

`projectsWithUnread` is **not** filtered by marks: it answers "which projects are worth locking", and a
project whose only events above the floor are individually read still needs its floor raised and its marks
pruned (M13).

### 4.2 `firstUncoveredAttentionSeq` — the floor-follow (FR-006, M7)

New, per project, run inside the lock after the mark is written. Two branches, each ascending on
`activity_events_attention_seq_idx`:

```text
SELECT min(seq) FROM (
  (SELECT activity_events.seq FROM activity_events
     LEFT JOIN notification_event_marks covered
            ON covered.project_id = activity_events.project_id
           AND covered.user_id    = $userId
           AND covered.event_id   = activity_events.id
           AND covered.counts_again_at = 'infinity'::timestamptz
    WHERE activity_events.project_id = $projectId
      AND activity_events.outcome IN ('failed', 'ambiguous', 'needs_reauth')
      AND activity_events.seq > $floor
      AND covered.event_id IS NULL
    ORDER BY activity_events.seq LIMIT 1)
  UNION ALL
  (… the same with outcome = 'connect_failed' AND actor_user_id = $userId …)
) AS uncovered
```

Bounded work: the scan stops at the first uncovered event, and at most 200 marks can precede it.

### 4.3 The prune — every floor rise (FR-005, FR-013, N16.2, N19)

In the same transaction as the `GREATEST` upsert, for the project and person whose floor moved:

```text
WITH pruned AS (
  DELETE FROM notification_event_marks
   WHERE project_id = $projectId AND user_id = $userId AND event_seq <= $newFloor
  RETURNING counts_again_at
)
SELECT count(*) FILTER (
         WHERE counts_again_at > now() AND counts_again_at < 'infinity'::timestamptz
       )::int AS snoozes_cleared
  FROM pruned
```

`snoozes_cleared` counts the pruned marks that were live snoozes, which is what the "Mark all as read"
confirmation names (M13, US3-AS2). It is counted in SQL so no infinite instant crosses into TypeScript
(see the driver note above). Because "Mark all as read" and the N4 problems
views set the floor to `newestAttentionSeq`, which is at or above every attention event's `seq`, this deletes
**every** mark for the project, snoozes included: the floor wins (N19, FR-013), and a snoozed event at or
below the new floor does not come back.

### 4.4 `markEvent` — the row actions (FR-006 to FR-008, FR-014)

One transaction, in R3's order (M12):

1. `SET LOCAL lock_timeout = '<configured>ms'` — `55P03` becomes `NotificationsBusyError`, nothing written
   (US3-AS7).
2. `SELECT projects.id FROM projects WHERE projects.id = $projectId FOR UPDATE`.
3. Membership re-check — gone ⇒ `not_member`.
4. Resolve the event inside this project with the attention predicate (M11) ⇒ `seq`, or `not_found`.
5. Read `seen_seq`. `seq <= seen_seq` ⇒ `unchanged`, nothing written (M10).
6. Cap: `SELECT count(*) … WHERE project_id = $p AND user_id = $u` ⇒ `>= 200` means `at_cap`, nothing
   written (M9, FR-007).
7. Upsert the mark:
   `ON CONFLICT (project_id, user_id, event_id) DO UPDATE SET counts_again_at = excluded.counts_again_at,
   updated_at = now()` — which is how "mark read over a snooze" and "re-snooze in either direction" replace
   the earlier choice (FR-014) and how two tabs marking the same event collapse to one row (US3-AS5).
8. Floor-follow (§4.2) and, when `newFloor > seen_seq`, the `GREATEST` upsert plus the prune (§4.3).

An event committed after step 4 has a larger `seq` and was never covered (FR-008, US3-AS4).

### 4.5 `listAttention` — the panel's rows (FR-018, M16)

Each attention branch gains two anti-joins and the reader returns
`AttentionRecord = ActivityRecord & { hiddenByMark: boolean }`:

- **exclude snoozed**, inside the branch so the `LIMIT` applies after the exclusion:
  join on `counts_again_at > now() AND counts_again_at < 'infinity'::timestamptz`, then `… IS NULL`;
- **readness**: join on `counts_again_at > now()`, select `… IS NOT NULL AS hidden_by_mark`. Having already
  dropped live snoozes, a match here can only be an `'infinity'` mark, so `hiddenByMark` means
  "individually read".

`toNotificationItem` then sets `isNew = seq > seen_seq && !hiddenByMark`: an individually-read event keeps
its place in the list and loses only its "New" marker (N20), while an expired snooze is "New" again
(FR-011, US2-AS2).

### 4.6 `markCounts` — surfacing the cap (FR-020, FR-023)

One statement in the project-set section: a `UNION ALL` of
`SELECT $p AS project_id, count(*) FROM notification_event_marks WHERE project_id = $p AND user_id = $u`
per project in the set. Each item's `actionsAvailable` is `count < 200`, so the rows of a capped project say
so and offer "Mark all as read" (US4-AS3), while another project's rows keep working (US4-AS5).

### 4.7 `nextChangeAt` — the soonest return (FR-021, N22, M17)

One statement in the project-set section over the **notifications-on** projects: a `UNION ALL` of
`SELECT min(counts_again_at) … WHERE project_id = $p AND user_id = $u AND counts_again_at > now()
AND counts_again_at < 'infinity'::timestamptz` per project, then `min()` of those. `NULL` when the caller has
no live snooze, which is today's behaviour exactly (US5-AS6).

## 5. Migration

| File | How | Contents |
|---|---|---|
| `drizzle/0020_<generated>.sql` | `pnpm db:generate` from the schema change | `CREATE TABLE notification_event_marks`, its PK, its two FKs, its two CHECKs and `notification_event_marks_floor_idx`. Nothing else. |

- **No data migration and no backfill.** No per-event row exists today, so the table starts empty, and an
  empty table reproduces today's behaviour to the row (N24, FR-026, SC-008).
- **No existing row is touched.** Every `notification_states` row keeps its `seen_seq`, `seen_at` and
  `muted`, and is still the floor. No operator has to reset notification state.
- Safe on a live installation: one `CREATE TABLE` plus indexes on an empty table, and the two FK targets
  (`member_organization_user_uidx`, `activity_events_pkey`) already exist. The FK creation takes a
  `SHARE ROW EXCLUSIVE` lock on `member` and `activity_events` for the length of the statement; there is no
  validation scan because the new table is empty.
- `pnpm db:check` (`scripts/check-migrations-current.mjs`) must be green: the committed SQL matches the
  schema.
- Rollback is `DROP TABLE notification_event_marks`, which returns the installation to 022's behaviour with
  no loss of the floor or the mute.

## 6. Shapes the browser sees

`src/lib/notifications/types.ts`:

| Type | Change |
|---|---|
| `UnreadSummary` | `+ nextChangeAt: string \| null` — ISO 8601 UTC with whole milliseconds, or `null` (M17). |
| `NotificationItem` | `+ actionsAvailable: boolean` — false for every row of a project at the cap (FR-023). `isNew` keeps its meaning and now also accounts for the mark (§4.5). |
| `NotificationPanel` | unchanged in shape; `items` no longer contains currently snoozed events. |

No internal position, no `seq`, no mark instant other than the caller's own soonest one, and no new
identifier reaches the browser (N23).

## 7. Constants and pure rules

| Where | What |
|---|---|
| `src/lib/notifications/attention.ts` | `EVENT_MARK_CAP = 200` — twice `UNREAD_CAP` (N16.3). |
| `src/lib/notifications/snooze.ts` | `SNOOZE_CHOICES` (`"hour"`, `"tomorrow"`, `"next_week"`), `SNOOZE_LABEL`, `MORNING_HOUR = 9`, `parseSnoozeChoice`, `resolveSnooze(choice, now, timeZone): Date` (M8). |
| `src/lib/notifications/text.ts` | the row-action confirmations, the at-cap sentence and `rowErrorText` ([contracts/ui.md](./contracts/ui.md) §4). |

## 8. Entities, against the spec's Key Entities

| Spec entity | Here |
|---|---|
| Reading floor | `notification_states.seen_seq`, unchanged in storage; its comment and `docs/activity.md` now say "floor", and every rise prunes (§4.3). |
| Per-event mark | `notification_event_marks`, §1. |
| Unread count | §4.1, capped at 100. |
| Next change | §4.7 — derived, never stored. |
| Activity event, attention event, mute, project, member, user, session | Unchanged. |
