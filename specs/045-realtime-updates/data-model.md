# Phase 1 — Data model: real-time updates

**Feature**: `specs/045-realtime-updates/` · **Branch**: `061-realtime-updates` · **Date**: 2026-10-12

This entry stores nothing. There is **no new table and no new column**; the only schema change is one
additive index, and everything a connection knows lives in one web process's memory. So this document has
three parts: the index and its migration (§1), the one statement the watcher runs and why it detects every
change the count depends on (§2–§3), and the in-memory entities with their fields, lifetimes and
invariants (§4–§7).

---

## 1. The only schema change: migration `0023`

```sql
-- 0023: one partial index so the stream watcher's install-wide probe is a single-row index-only
-- scan that only a real problem can move (plan decision S15).
CREATE INDEX "activity_events_attention_global_seq_idx" ON "activity_events" ("seq")
  WHERE "outcome" IN ('failed', 'ambiguous', 'needs_reauth', 'connect_failed');
```

In `src/server/db/schema/activity.ts`, added to the `activityEvents` table's extras list beside R4's two
existing partial indexes:

```ts
// The stream watcher's install-wide change probe (045): max(seq) over attention events in one
// index-only row fetch. Literals, never parameters, so the planner matches the partial predicate.
index("activity_events_attention_global_seq_idx")
  .on(t.seq)
  .where(sql`${t.outcome} IN ('failed', 'ambiguous', 'needs_reauth', 'connect_failed')`),
```

| Property | Value |
|---|---|
| Kind | Additive DDL. One `CREATE INDEX`. No `UPDATE`, no `ALTER`, no data step |
| Safe on a live install | Yes. It cannot alter a reading floor, a sparse mark, a preference row or an activity event |
| Operator action | None. Migrations already run before the web container serves (`MIGRATE_ON_START`) |
| Lock | `SHARE` on `activity_events` for the length of one build; no `CONCURRENTLY`, because Drizzle migrations run in a transaction |
| Insert cost | Partial: a `published`, `retrying` or `resolved` event pays only the predicate evaluation, not an index entry |
| Rollback | `DROP INDEX`. The probe still works without it, just not O(1) (S15) |
| Gate | `pnpm db:check` green; `tests/integration/notifications/stream-migration.test.ts` applies it on its own seeded database |

**Why both existing indexes are insufficient.** R4's `activity_events_attention_seq_idx` is
`(project_id, seq)`, so a global `max(seq)` over it has no leading-column restriction and must scan the
whole index — correct, but linear in the number of problems the install has ever had.
`activity_events_seq_uq` gives `max(seq)` in one row fetch but moves on every successful publish, so a
bulk publish would start a recompute round per event. This index is the only shape that is both O(1) and
attention-only.

**No other schema change.** `notification_states`, `notification_preferences`,
`notification_event_marks`, `member`, `session` and `activity_events` keep every column, constraint and
index they have. `projectOwnedTables` and `notProjectOwned` are unchanged.

---

## 2. The change fingerprint

One statement, run by the watcher every 2 seconds through `crossProject("notifications stream: install
probe")`. It reads nine scalars and no per-person data at all.

```sql
SELECT
  (SELECT max(seq)::text FROM activity_events
     WHERE outcome IN ('failed','ambiguous','needs_reauth','connect_failed'))  AS attention_seq,
  (SELECT count(*)::int        FROM notification_states)        AS states_n,
  (SELECT max(updated_at)      FROM notification_states)        AS states_at,
  (SELECT count(*)::int        FROM notification_preferences)   AS prefs_n,
  (SELECT max(updated_at)      FROM notification_preferences)   AS prefs_at,
  (SELECT count(*)::int        FROM notification_event_marks)   AS marks_n,
  (SELECT max(updated_at)      FROM notification_event_marks)   AS marks_at,
  (SELECT count(*)::int        FROM member)                     AS members_n,
  (SELECT max(created_at)      FROM member)                     AS members_at
```

- The outcome list is a SQL **literal**, never a parameter, so the planner matches §1's partial predicate —
  the same rule `src/server/dal/notifications.ts:120-121` already follows.
- `max(seq)` is cast to `text` because `seq` is a bigint; the result is only ever compared, never
  arithmetic.
- The nine values are folded into one opaque string. Nothing orders them: the comparison is **equality**
  against the stored baseline, so no clock has to be monotone across machines.

```ts
export interface ChangeFingerprint { readonly value: string }   // opaque; compare with ===
```

### 2.1 Why these nine, and why a count *and* an instant

| Input the count reads | What can change it | Scalar that sees it |
|---|---|---|
| Attention events (N1) | A new failed / ambiguous / needs-reauth / connect-failed event | `attention_seq` rises. The log is append-only and nothing purges it (`src/server/scheduler/housekeeping.ts` has no activity purge), so additions are the only case; a project deletion cascades to `member` and is caught by `members_n` |
| The read floor, `notification_states.seen_seq` (N13) | "Mark all as read", a problems view, a row action pulling the floor up, unmuting | `states_at` (every write path stamps `updated_at`; S16 puts the last one on the database clock) |
| | A membership's starting row created | `states_n` and `states_at` |
| | A membership removed, or a project or user deleted | `states_n` falls |
| Preference switches (N35, N39) | A kind or platform turned on or off | `prefs_at` |
| | A first switch row appearing; a row cascading away with the membership | `prefs_n` and `prefs_at` |
| Sparse per-event marks (N13–N15) | A problem marked read, or snoozed | `marks_n` and `marks_at` |
| | A snooze changed to a different instant on the same event | `marks_at` |
| | A mark pruned by a floor move, or cascaded by an event or membership deletion | `marks_n` falls |
| Memberships (022 FR-019) | Joining, leaving, being removed; a whole project or user deleted | `members_n`, and `members_at` for an add |
| | A **role** change | Nothing — and nothing is needed: all three roles hold `post: view` (`src/server/auth/access.ts:11, 28, 43`), so a role change cannot change who counts |

**The pair is the point.** `max(updated_at)` cannot see a deleted row; `count(*)` cannot see an in-place
update. Together they see additions, changes and deletions, which is exactly what FR-010 demands. A delete
plus an insert inside one interval is still caught, because an insert takes `DEFAULT now()` and moves the
instant.

### 2.2 Deliberately absent

| Not in the fingerprint | Why |
|---|---|
| `social_accounts` | The count does not read it. `countUnread` compiles eligibility from preference rows alone; `platformsByProject()` only feeds the preferences *grid* (`src/server/dal/notifications.ts:533-544`) |
| `projects` | A rename cannot change a count; a deletion cascades to `member` and is caught |
| `session` | Per-connection, not install-wide: §5.3 |
| `email_*` | A push is not a send. N42–N67 are untouched |
| Anything per-person | The probe is a change *detector*. Who is affected is decided by recomputing, which is pinned and scoped (§3) |

### 2.3 Over- and under-triggering

Over-triggering is harmless by construction: a round that recomputes and finds every snapshot unchanged
sends nothing (FR-010). The only cases are a problem written in a project nobody connected belongs to, and
a mark or switch written by somebody with no stream. Both cost one round and no messages.

Under-triggering is the only real risk, and §2.1 is the argument that there is none for any input the count
reads. Two residual cases, both named and both bounded:

- a row deleted and another inserted with an identical `updated_at` *and* an unchanged count — impossible
  for the sparse tables (an insert's `DEFAULT now()` is strictly later than a committed earlier write) and
  for `member` it would also need an identical `created_at`;
- a snooze instant changed to the same instant it already held — not a change at all.

### 2.4 Cost

`attention_seq` is one index-only row fetch (§1). The four `count(*)`s scan sparse tables whose size is
bounded by memberships: one `notification_states` row, a handful of `notification_preferences` rows and at
most `EVENT_MARK_CAP` marks per membership. For a self-hosted Docket that is hundreds to a few thousand
rows, read from shared buffers, 30 times a minute per web process, **independent of how many connections
the process holds** (SC-004). It is linear in install size rather than constant; the honest point at which
it would stop being cheap is around 100,000 preference rows — roughly 25,000 memberships — far outside
this product's scale and far outside what 50 streams would serve.

---

## 3. What a recompute reads

Nothing new. One expression, the same one `GET /api/me/notifications` uses:

```ts
const summary = await unreadSummary(await forMyProjects({ user: { id: userId } }));
```

| Step | Statements | Scope |
|---|---|---|
| `forMyProjects()` | the `member` ⋈ `projects` ⟕ `notification_states` resolve; `preferencesByProject()` | `crossProject("resolve my projects")`, then `runForProjectSet` — the one sanctioned cross-project reader |
| `unreadSummary()` | `countUnread()` (which reads preferences again) and `nextChangeAt()` | `runForProjectSet`, each branch pinned to one project id and re-joining `member` for this user |

So about four indexed statements per person per round, every one of them already governed by the project
scope harness. Three consequences the spec asks for fall straight out of reusing it:

- **FR-006** — the eligibility rule, the read floor, the sparse marks and the switches are whatever
  entries 1 and 2 shipped. The stream has no second notion of what is counted.
- **FR-022 / FR-024** — memberships and preferences are resolved **afresh on every recompute** and are
  never cached for the life of a connection. Losing a project drops its problems from the next push;
  a rolled-back removal leaves the count unchanged because the read simply sees the row again.
- **FR-007** — no new query shape exists to audit. The only install-wide statement in the whole feature is
  §2's probe.

Two tabs of one person share one recompute (S21): a round groups its connections by user id, computes once,
then compares the result against **each** connection's own `lastSent`.

---

## 4. In-memory entities

Nothing below is persisted, shared between processes, or survives a restart.

### 4.1 Count snapshot

The spec's **Count snapshot**. Not a new type: it is `UnreadSummary` from
`src/lib/notifications/types.ts`, unchanged.

| Field | Type | Meaning |
|---|---|---|
| `count` | `number` | Unread attention events over the person's notifying projects, counting stops at 100 (N9) |
| `display` | `string` | `""` at zero, `"99+"` from 100 |
| `label` | `string` | The accessible name in words |
| `nextChangeAt` | `string \| null` | ISO instant of the soonest live snooze, or null (M17) |

Absolute, never an increment (N69). Computed on demand; stored nowhere.

### 4.2 Connection

One person's live stream held by one web process.

| Field | Type | Lifetime | Notes |
|---|---|---|---|
| `id` | `string` | the connection | `randomUUID()`, process-local, never sent to the browser |
| `userId` | `string` | the connection | Resolved from the session at connect; never from input (FR-002) |
| `sessionId` | `string` | the connection | The session **id**, never the token. What §5.3 re-checks |
| `openedAt` | `number` | the connection | Monotone ms. Orders displacement (oldest first, FR-014) and drives the lifetime close |
| `lastSent` | `{ count: number; nextChangeAt: string \| null }` | updated per message | What this connection last received. A message goes out only when a recompute differs from it (FR-010) |
| `write(frame)` | `(string) => void` | the connection | Guarded: a throw means the client has gone, and deregisters (S19) |
| `end(reason)` | `(…) => void` | the connection | Writes the terminal frame, clears every timer, deregisters, closes |
| timers | heartbeat, lifetime, session re-check | the connection | §5 |

**Not** on a connection: the session token, a cookie, a project list, a membership set, a preference set,
an eligibility plan, a snapshot history, an event id or a cursor. Everything about *what the person may
see* is resolved afresh by each recompute (§3), which is what makes FR-022 and FR-024 true rather than
hoped for.

### 4.3 Watcher

One per web process.

| Field | Type | Notes |
|---|---|---|
| `connections` | `Map<string, Connection>` | The registry. The only state the watcher has |
| `baseline` | `ChangeFingerprint \| null` | Replaced **only** by a successful probe (S24). `null` before the first |
| `running` | `boolean` | Started by the first connection, stopped by the last (S23) |
| `abort` | `AbortController` | `SIGTERM` closes every connection with `reconnect`, then stops the loop |
| `lastLoggedAt` | `number` | Rate-limits probe and recompute failure logging to one line a minute |

Held under `Symbol.for("docket.notifications.stream")` on `globalThis`, the pattern
`src/server/scheduler/in-process.ts:5-7` already uses, so a hot reload or a second module evaluation
cannot produce two watchers.

### 4.4 Map to the spec's Key Entities

| Spec entity | Here |
|---|---|
| Count snapshot | §4.1 — `UnreadSummary`, unchanged, computed by the existing service function, absolute |
| Connection | §4.2 — process-local, at most 4.5 minutes, never shared or persisted |
| Watcher | §4.3 — one per process, probes the install, recomputes its own connections, holds no per-person state beyond them |
| Activity event, attention event, notification state, per-event mark, preference switch, project, member, user, session | Unchanged in meaning and in schema. Read only |

---

## 5. Lifetimes

### 5.1 The round

```
probe ──► fingerprint == baseline  and  no connection's nextChangeAt has passed
          │                                   └─► send nothing, sleep
          └─► otherwise ─► group connections by userId
                           ─► for each person, at most 3 at a time:
                                re-check the session (§5.3) ─► gone? end with `ended`
                                recompute (§3)
                                for each of that person's connections:
                                  differs from lastSent? ─► write `snapshot`, set lastSent
                           ─► replace baseline with the probed fingerprint
                           ─► sleep to the next 2-second boundary
```

The loop is **sequential**, so rounds never overlap and a slow round delays the next probe instead of
piling up. A round is entered when the fingerprint moved **or** any connection's `lastSent.nextChangeAt`
is non-null and has passed (FR-012): that is how a snooze running out raises a count with no new event
and no fingerprint change.

### 5.2 Heartbeat and lifetime

| Timer | Interval | Effect |
|---|---|---|
| Heartbeat | 20 s | Writes a `ping` frame. Keeps a proxy's idle timer from firing (FR-016) and feeds the client's silence watchdog (S17). Because every write is guarded, it is also the liveness check that reaps a vanished client within one interval (S19) |
| Lifetime | 270 s (4.5 min) | Writes `reconnect`, then closes and deregisters. Under the 300-second read timeout that is the common proxy and Node default, so a deliberate close never races a timeout (S18, FR-015) |

### 5.3 Session re-check

On every recompute, and on its own 60-second timer when no round has run (FR-022):

```sql
SELECT 1 FROM session WHERE id = $1 AND user_id = $2 AND expires_at > now()
```

Read-only, through `crossProject("notifications stream: session re-check")`. No row → write `ended` and
close; the client stops reconnecting and does not start polling a signed-out endpoint (FR-021, FR-023).

It is **not** `auth.api.getSession`, which would refresh a session whose new cookie a response already in
flight cannot deliver (S20). Verified against Better Auth 1.7.7: sign-out deletes this row by token and a
refresh updates the same row, so the id is stable for the session's life and a refresh never looks like a
sign-out. The user id is compared too, so a row that somehow belonged to somebody else ends the stream
instead of serving it.

---

## 6. Invariants

1. **No message is an increment.** Every `snapshot` is the person's whole current count (N69, FR-005).
2. **No event id is ever written**, so the browser sends no `Last-Event-ID` and the server needs no
   history to answer correctly (FR-005, US3 §6).
3. **A message goes out only when the snapshot differs from that connection's `lastSent`**, in the count or
   the next-change instant (FR-010).
4. **One snapshot is sent on connect and on every reconnect**, before any other frame (FR-005).
5. **The payload is produced by `unreadSummary()`.** No second code path can compute a count for the
   stream (FR-003, constitution IV).
6. **No membership, preference or eligibility plan is cached on a connection.** Every recompute resolves
   them (FR-022, FR-024).
7. **No connection holds a database handle between recomputes.** The watcher borrows from the pool for the
   length of a statement only (spec Edge Cases).
8. **The baseline fingerprint is replaced only by a successful probe**, so a database blip delays a push by
   one interval and cannot hide a change for ever (S24).
9. **A recompute failure keeps its connection and its `lastSent`**: no wrong count is sent, the connection
   is not closed, and the person is not dropped to polling (spec Edge Cases).
10. **Probe work per interval is independent of the number of connections** (FR-009, SC-004).
11. **At most 3 recomputes run at once**, against a pool default of 10 (FR-009, S22).
12. **At most 50 connections per process and 5 per person**, as constants, with no environment variable
    (FR-013).
13. **A connection lives at most 270 s** and no stale session is served longer than that, whatever else
    fails (FR-015, N81).
14. **The stream never writes.** No `INSERT`, `UPDATE` or `DELETE` exists anywhere in the feature; in
    particular nothing marks anything read, and a stream request is not a problems view (FR-026, N82).

---

## 7. Migration and upgrade

| Question | Answer |
|---|---|
| What migrates? | Nothing. N12 stored no data: it was a timer and a fetch, so there is no row to rewrite and no state to convert (FR-032) |
| Operator action on upgrade? | None |
| An install whose proxy buffers? | Behaves exactly as today: the client falls back by itself within 5 seconds and nothing appears on screen (N77, N80, SC-005) |
| An install with no client JavaScript? | Unchanged: the server-rendered count, every link and "Mark all as read" all work (FR-018) |
| Rollback? | `DROP INDEX` plus reverting the client. The count route and the recent route are untouched, so a rollback is additive in reverse |
| Anything reset? | No. No operator is asked to reset notification state, and no migration touches a floor, a mark or a switch |
