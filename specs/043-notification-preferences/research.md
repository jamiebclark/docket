# Phase 0 — Research: per-kind and per-platform notification preferences

**Feature**: `specs/043-notification-preferences/` · **Branch**: `057-notification-preferences`

No external platform or library fact is involved in this entry, so nothing here needs `docs/research/`
and nothing is marked `NEEDS RESEARCH`. There is no `NEEDS CLARIFICATION` in the Technical Context
either: the spec settled every product judgement call it needed (N25–N41). What follows are the plan's
own decisions about this repository's code — numbered **Q1–Q24** so they can be recorded in
`docs/decisions.md` next to the shipped decisions they replace or extend (022's R1, R4, R5, R14 and
056's M-series).

Facts read from the installed packages rather than memory: `drizzle-orm` 0.45's `pgTable`/`check`/
`foreignKey` builders and the `GREATEST`-in-`onConflictDoUpdate` form (as already used in
`src/server/dal/notifications.ts`), and Next 16's App Router server-action and `searchParams` shapes
(`node_modules/next/dist/docs/01-app/`). Postgres behaviour this plan leans on — `GREATEST` ignoring
NULLs, `min()` ignoring NULLs, `unnest` over a `text[]`, `coalesce` over an empty aggregate — is
asserted by tests (quickstart §3), not assumed.

---

## The store

### Q1 — One table, `notification_preferences`, one row per switch

Columns: `project_id`, `user_id`, `axis` (`kind` | `platform`), `switch_key`, `on_from_seq`,
`created_at`, `updated_at`. Primary key `(project_id, user_id, axis, switch_key)`; a composite foreign
key to `member (organization_id, user_id) ON DELETE CASCADE`, exactly as R1 did for
`notification_states` and M1 for `notification_event_marks`, so FR-022's "deleted with the membership,
the project or the user, in the same statement" is the database's job and not a writer's.

- **Rejected: a `jsonb` column on `notification_states`.** A switch has to carry a position (N35), so
  every flip would rewrite the whole blob, nothing could be constrained by a `CHECK`, and the SQL could
  not compare one switch's position without extracting it per row.
- **Rejected: two tables** (one for kinds, one for platforms). Identical shape, identical write path,
  two of every test.
- **Rejected: a kind × platform matrix** — N28 rejected it on product grounds; nothing in the
  implementation argues for it, and this shape is a strict subset of it.
- Row growth is bounded without a cap: 4 kinds plus at most one row per registered platform (7 today)
  per person per project. Nothing can create a row for a key that was never registered (Q21).

### Q2 — `on_from_seq bigint NULL`: absent means on, NULL means off, a value means "on from here"

Three states, one column:

| Stored | Meaning |
|---|---|
| no row | the switch is on and has no position of its own (N27, FR-002) |
| row, `on_from_seq IS NULL` | the switch is off (FR-001) |
| row, `on_from_seq = N` | the switch is on, and only events with `seq > N` may notify through it (N35) |

- **Why not `off boolean` + `from_seq bigint`:** two columns that can disagree ("off, from 4210"), and
  the query predicate would need a disjunction of two blocking reasons — which 022's SQL rules forbid
  (no `OR`, no `NOT` other than `IS NULL`/`IS NOT NULL`, so the partial indexes keep matching).
- **Why a row is never deleted when a switch is turned on:** deleting it would mean "on with no
  position", and eligibility would fall back to the project floor — which is exactly the backlog N35
  forbids. A switch-on **rewrites** the row with a position. This is the most load-bearing invariant in
  the data model (data-model.md §2, invariant I3).

### Q3 — One named sentinel for "off", in TypeScript and in SQL

`OFF_SEQ = 9223372036854775807n` (`bigint` max). The predicate for one switch is
`seq > coalesce(on_from_seq, OFF_SEQ)`: a NULL position blocks everything, a stored position blocks up
to itself, and an absent row contributes no clause at all. It is the same shape as 056's
`'infinity'::timestamptz` for "read for ever" — one comparison, no branching — and `bigint` has no
infinity to borrow. Declared once in `src/lib/notifications/eligibility.ts` and interpolated as a SQL
literal.

---

## The rule, and where it lives

### Q4 — `src/lib/notifications/eligibility.ts` is the one statement of the rule (FR-014)

A pure module: `preferencesOf(rows)` builds a per-project `{ kinds, platforms }` threshold map;
`kindOn`, `anyKindOn` (the N33 roll-up), `platformFloorOf(keys)` and `mayNotify(prefs, event, floor)`
answer the question FR-003 asks. `email-delivery` imports this module unchanged; it does not get a
notion of its own.

The SQL cannot call a TypeScript function, so there are two expressions of one rule — the same
situation `attention.ts` has had since 022, where the outcome vocabulary is a pure constant and the
counting SQL writes it as literals. It is handled the same way: the compiled plan
(`compileEligibility(prefs)`) is the *only* input to the SQL builder, and an integration test seeds
every combination of switches and asserts that the database's count equals the pure function's count
over the same events (quickstart §3, `preferences.test.ts` "the SQL and the rule agree"). Drift fails a
test rather than relying on a review habit.

### Q5 — The kind axis is compiled into the branch list, never evaluated per row

`unreadBranches` already emits one branch per outcome family per project. The compiler now:

- emits **no branch** for a kind that is off — so "all kinds off" costs nothing at all, which is the
  common case (it is the old mute, and what every migrated `muted = true` row becomes);
- groups the **on** member outcomes by their position, and emits one branch per group with the outcome
  list as SQL literals and `AND activity_events.seq > <position>::bigint` beside the existing
  `seq > notification_states.seen_seq`. With no preferences stored there is one group with position 0,
  the extra clause is omitted, and the SQL is **exactly what ships today**;
- keeps `connect_failed` as its own branch, with its own position.

So the kind axis adds zero per-row work and the R4 partial indexes keep driving every statement.

### Q6 — The platform axis is one correlated comparison, built from a literal `VALUES` map

Appended to a branch only when the person has at least one platform switch for that project:

```sql
AND activity_events.seq > (
      SELECT coalesce(min(coalesce(p.threshold, 0)), 0)
        FROM unnest(activity_events.provider_keys) AS pk(key)
        LEFT JOIN (VALUES ('tiktok', 9223372036854775807::bigint),
                          ('facebook', 4210::bigint)) AS p(key, threshold)
               ON p.key = pk.key)
```

The subquery is the lowest threshold among the platforms the event records. That one comparison says
all three things FR-003 needs, with no `OR` and no `NOT`:

| Event | Subquery | Result |
|---|---|---|
| records a platform with no switch | `0` | eligible — absent means on (N27) |
| records several, at least one on | that one's threshold | eligible, and **once** (N29) |
| records several, all off | `OFF_SEQ` | excluded (N29) |
| records **no** platform | `0` (empty aggregate) | eligible, the kind alone governs (N30) |

- **Rejected: a `LEFT JOIN … IS NULL` anti-join per platform.** "No platform at all" cannot be folded
  into it without a disjunction, and N30 says that case must never be swallowed.
- **Rejected: `provider_keys <@ ARRAY(…off keys…)`.** Same problem (an empty array is contained in
  everything, so a no-platform event would be excluded), and it cannot express per-platform positions.
- **Rejected: a GIN index on `provider_keys`.** R4 deliberately made two partial indexes the only
  additions to the log. See Q7 before adding a third.

### Q7 — What this costs, and the fallback if the budget is missed

Two honest costs, both only for a person who has stored a platform switch in that project:

1. `provider_keys` is a heap column, so a branch that carries the Q6 expression can no longer be
   satisfied by an index-only scan of the R4 partial index: one heap fetch per candidate row.
2. A person for whom **every** platform is off has a branch that scans without ever reaching its
   `LIMIT 100`, because no row passes. The spec names this state ("every kind on but every platform it
   has accounts for off") and expects a count of zero; the work is a bounded index scan plus a cheap
   filter, but it is proportional to the project's attention events, not to 100.

SC-007 is therefore extended (quickstart §4): the existing 100 000-event performance test gains a
person with four kind switches and every platform switched off, and asserts the same sub-100 ms budget.
**If it is missed**, the named fallback is a GIN index on `activity_events (provider_keys)` plus an `&&`
pre-filter on the on-platform list — written down here so the implement phase does not have to invent
one, and deliberately **not** taken speculatively.

---

## Writing a switch

### Q8 — Switch writes reuse R3's transaction verbatim; one submit is one transaction

`SET LOCAL lock_timeout` → `projects` row `FOR UPDATE` → membership re-check → (for an on-write) the
newest attention position → upsert the switch rows → prune. Identical order to `write` and `markEvent`,
so the lock order is unchanged, no deadlock is possible, and the failure mode is the one already
specified and tested: a 55P03 becomes `NotificationsBusyError`, nothing is written, retrying works.

"Turn all off" and "Turn all on" are **one** transaction writing several switch rows, so they are one
click, one confirmation and all-or-nothing (N34).

### Q9 — An on-write only touches switches that are currently off

Turning on a switch that is already on writes nothing and reports `unchanged`. This matters twice:
clicking "Turn all on" on a project where three kinds are already on must not move those three
positions forward (that would hide events that are eligible right now), and a double submit is
idempotent.

### Q10 — `GREATEST` on conflict, and why no backlog can appear by racing

The upsert sets `on_from_seq = GREATEST(notification_preferences.on_from_seq, excluded.on_from_seq)`.
Postgres's `GREATEST` ignores NULLs, so an off row (NULL) correctly becomes the new position, and two
concurrent on-writes can only ever leave the larger of the two. Because `newestAttentionSeq` only
grows, an off → on cycle can never record a position below an earlier one, which is the edge case the
spec raises for two tabs changing one switch in opposite directions.

### Q11 — Pruning on an on-write, and never on an off-write (FR-008, FR-007)

In the same transaction as the position, an on-write deletes this person's marks in this project whose
event is no longer eligible under the preferences as they now stand. A mark on a permanently
ineligible event can never affect anything, so nothing meaningful is deleted and 056's bound on sparse
rows survives repeated switching (N36, N16). The number pruned is returned for tests; the confirmation
wording does not mention it (the spec does not ask it to, and the sentence stays short).

An **off**-write prunes nothing and touches no position, so the 200-mark cap is unchanged by switching
off — the state the spec's edge case describes.

Switching never touches `seen_seq`: a switch's position lives with the switch. "Turn all on" therefore
leaves the floor exactly where it was, and the project still reads as zero unread because all four kind
positions are at the newest event.

### Q12 — "Turn all off" writes the four kinds; it leaves platform switches alone

All kinds off already silences the project (N33), and keeping someone's "I do not run our TikTok"
choice through an all-off/all-on cycle is the kinder behaviour. "Turn all on" turns on the four kinds
**and** any platform switch that is off, so one click genuinely restores everything (SC-002). The UI
copy says what each project-level control will change.

---

## Readers that change, and readers that must not

### Q13 — `nextChangeAt` joins each live snooze back to its event (FR-011)

Today it takes the minimum future, finite `counts_again_at` over the notifications-on projects. A
snooze whose event's kind or platform has since been switched off must not arm the poller, so the
statement now joins `activity_events` and applies the same compiled branches (and the floor). Marks are
capped at 200 per person per project, so this stays small.

### Q14 — The floor paths stay preference-blind (N37, FR-009)

`projectsWithUnread`, `markAllRead` and `markProblemsView` are unchanged: they raise the floor over
every attention event that exists, including events of switched-off kinds and platforms, exactly as
N4.1 already covered muted projects. This is what guarantees a switch turned on later can never surface
something old.

### Q15 — The panel keeps its wire state name `all_muted`

FR-011 forbids a response-shape change, so `NotificationPanel.state` keeps the literal `all_muted`
while its meaning becomes "no project of yours has any kind on" (FR-012) and its sentence stays
"Notifications are off for all of your projects." A rename would be a payload change for a word the
user never sees.

### Q16 — `MyProject` keeps the floor and gains the preferences

`notifications` drops `muted` and keeps `{ seenSeq }`; a new `preferences` field carries that project's
compiled switches. `forMyProjects` loads every preference row for the caller in **one** extra statement
inside the same project-set section (≤ 20 projects × ≤ 11 rows). `unmutedIds` becomes `notifyingIds` —
the projects with any kind on — and is what the count, the panel and `nextChangeAt` are built over.

The per-project repo (`createNotificationsRepo`, used by the callout and project settings) loads its own
switches with one primary-key-prefix read rather than taking them as an argument, so no caller signature
grows a parameter it would have to thread through.

### Q17 — Which platforms are offered (N32, FR-019)

`offeredPlatforms = platformOptions() ∩ (platforms the project has accounts for ∪ the person's off
switches)`, in registry order. `platformOptions()` already drops `mock` unless it is enabled, so the
`mock` edge case needs no new code. Two new reads: `AccountsRepo.platformKeys()` (one `DISTINCT` on
`social_accounts` where `removed_at IS NULL`) for one project, and a `platformsByProject()` set reader
(one `UNION ALL` branch per project, inside the project-set section) for the grid. A switch stored for a
platform that is no longer registered, or is registered but disabled, still applies to counting and is
simply not offered — so it cannot be changed while the platform is unavailable, and comes back the
moment it is.

---

## Screens

### Q18 — The switch control is a state-showing submit button, not a checkbox

`docs/design-system.md` §7 says many-of-many is checkboxes with `checkStyles`. That guidance assumes a
form with a Save. Here FR-017 and US4's second scenario require each change to be **saved and confirmed
with no client JavaScript**, and a checkbox cannot submit itself without JavaScript — a batched "Save"
would leave a changed switch unsaved, which is the one failure mode the spec calls out. So each switch
is its own small form holding one submit button:

```html
<button type="submit" class="…secondary sm…">On
  <span class="sr-only"> — turn off Failed notifications for Woodwork</span>
</button>
```

Accessible name: "On — turn off Failed notifications for Woodwork" — the state, the project and what the
switch governs (FR-015), with the state as text as well as colour. This is `NotificationToggle`'s shipped
shape (R14) generalised from one button per project to one per switch, so it extends a pattern the app
already has rather than inventing one. `aria-pressed` is deliberately **not** used: the button's visible
label is the current state, so a pressed state would say it twice. Recorded in design-system §7 as "a
switch that saves on activation", with this reasoning.

### Q19 — The grid is `Table grouped` with six columns and a per-project detail row

Columns: **Project · Failed · Needs your decision · Needs reconnecting · Connect failed · This project**.
One `RowGroup` per project holds a `Row` (the project name, the four kind switches, and the project-level
"Turn all off" / "Turn all on") and a `DetailRow` spanning the width with a `<details>` "Platforms"
disclosure — the sanctioned "hidden until opened, works without JavaScript" shape (§7 "Row actions"),
already used by `NotificationRowActions`, `accounts/page.tsx` and `Composer.tsx`.

The design doc's "five columns is the ceiling" is about *fact* columns, which wrap when they are narrow;
a control matrix whose four middle columns are the same four fixed words on every row does not wrap, and
narrow is the point. The doc is amended to say so rather than being quietly broken. `Table`'s existing
phone behaviour does the rest: each row stacks and every cell is labelled with its column name from
`--col-N`, so the four kinds read as a labelled list on a phone with no extra markup.

The same per-project control, built from the same component, is the "Your notifications" card on the
project's settings page for every member role (FR-016), beside — and separate from — the project form
only owners and admins can submit.

### Q20 — Confirmations travel as codes and are rendered by pure functions

R14's shape, extended: the action redirects to `?changed=<slug>&axis=kind&key=failed&on=1`, and the page
resolves the project name from the caller's own set and calls `switchConfirmation()` in
`src/lib/notifications/text.ts`. An unparseable axis or key renders a generic "Notifications updated."
rather than erroring, and `parseSwitchChange` is a pure, tested function. No sentence is ever carried in
a URL.

### Q21 — "Not found" is decided before "invalid"

Every mutation resolves the project through the caller's own resolved set first: an unknown project and
one the caller does not belong to both raise `NotFoundError` with 022's R13 sentence, before any switch
key is looked at. Only then is the key validated — a kind against the four N1 outcomes, a platform
against `offeredPlatforms` for that project — so an invalid key answers "invalid", never reveals whether
a project exists, and the registry is never enumerated to a stranger (FR-020).

---

## Two things worth saying plainly

### Q22 — N30's "an event with no platform" is unreachable today, and is still implemented

`activity_events` has `CHECK (cardinality(provider_keys) >= 1)`, so no event in this schema records zero
platforms. N30's rule is implemented anyway (Q6 handles the empty array for free) and tested two ways —
the pure rule, and a direct assertion of the Q6 expression against `ARRAY[]::text[]` — so the day a kind
of event with no platform appears, no platform switch swallows it. This entry does **not** relax that
CHECK: nothing needs it, and loosening a constraint to make a test convenient is the wrong trade.

### Q23 — What this entry adds to the stack: nothing

No runtime dependency, no environment variable, no infrastructure, no `docker-compose.yml` change, no
recurring server-side work (`runTick()` is untouched), no public-API operation, no webhook change, no
new UI primitive, and no new index on `activity_events`. One new table, one dropped column, one
migration.

### Q24 — Migration 0021 is generated, then hand-ordered

`pnpm db:generate` produces the `CREATE TABLE`, the foreign key and the `ALTER TABLE … DROP COLUMN
"muted"`. The data step is inserted **between** them by hand, separated by `--> statement-breakpoint`:
every `notification_states` row with `muted = true` becomes four kind rows with `on_from_seq = NULL`,
`ON CONFLICT DO NOTHING`; rows with `muted = false` get nothing (N26, FR-024). `pnpm db:check` only
compares the schema snapshot with the migrations, so hand-added statements are safe, and
`drizzle-kit check` keeps the journal honest. The order is load-bearing: the insert must read `muted`
before the column is dropped.
