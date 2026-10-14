# Phase 1 — Quickstart: validating a date-pegged series

**Feature**: `072-dated-series` | [plan](./plan.md) · [spec](./spec.md) · [services](./contracts/services.md) · [worker](./contracts/worker.md) · [ui](./contracts/ui.md)

Every success criterion below has a runnable check. Nothing here makes a live provider call
(constitution II): the text provider is a stub `LlmProvider` or `createFakeLlmFetch`, the image
provider is a stub through `setImageProviderForTests`, and anything that would need real credentials
is reported as **verified with mocks only**.

## Prerequisites

```bash
pnpm install                        # no new dependency is added by this entry
docker compose up -d postgres       # integration tests need a real Postgres
pnpm db:check                       # must be green against the committed SQL
```

Integration tests connect on **port 5555**, not the 5432 in `.env.example`.

Time is advanced with `clock.runAtTime(date, fn)`; no test sleeps. Ticks are driven by calling
`runTick({ config: { … } })` directly, and two concurrent ticks are two un-awaited `runTick`
promises resolved with `Promise.all`. The claim reads the engine clock, not `now()`, so a pinned
clock moves the whole pass ([contracts/worker.md](./contracts/worker.md) § 2 note 3).

### The fixture every date test uses

A project in `America/New_York` (and a second in `Pacific/Auckland` for the zone tests), one
connected non-media account with slots, one voice profile, and a dated series created with

```text
occurrenceRule: "dated_list", leadDays: 0,
template: "Write a short post about {{ name }}. {{ detail }}"
```

imported from

```csv
date,name,detail,media
03-14,Ada Lovelace,the first programmer,ada.jpg
03-14,Albert Einstein,relativity,
02-29,Leap Day,once every four years,
2027-07-04,Anniversary,ten years in business,
```

`name` is the first non-reserved column, so it is the **key column** (A10).

---

## SC-001 — A 50-row spreadsheet becomes a running series in under 5 minutes, no row typed by hand

```bash
pnpm vitest run tests/integration/dated-series/import.test.ts tests/integration/dated-series/ui.test.tsx
```

Asserts the whole path is one screen and one file: create the series with
`occurrenceRule: "dated_list"`, call `importDatedListAction` with a 50-row CSV, and the detail page
then renders the upcoming dates, the rows table and no "Add a row" step required. No route outside
`/p/<slug>/jobs/series/<id>` is touched, and `standing_series_dated_rows` holds 50 rows with
`ordinal` 0–49 in file order.

## SC-002 — Across a simulated year, every every-year row produces exactly one post per year and every year-specific row exactly one in total — 100%, 0 duplicates

```bash
pnpm vitest run tests/integration/dated-series/due.test.ts
```

Walks a pinned clock day by day from 2027-01-01 to 2028-12-31 over the fixture (stepping only the
dates that matter, plus a tick on every date in a ±2-day band around each), running `runTick` until
the series is no longer claimed, then asserts:

- `posts` with a `standingSeriesPositionId` under this series: **exactly 2 for Ada in two years**, 2
  for Einstein, 2 for Leap Day, **1** for the 2027 anniversary and none in 2028 (US1 AS1–AS5);
- `standing_series_occurrences`: one row per `(row_id, year)`, `outcome = 'produced'`, and
  `unique(row_id, year)` never violated by a retry;
- a tick on 15 March produces nothing and changes nothing (US1 AS2);
- the 2027-07-04 row's `next_target_date` is `NULL` afterwards and the row shows as past (US1 AS5).

## SC-003 — Every post for a lead time of N exists at least N−1 days before the date, and no queued post is scheduled before its own date

```bash
pnpm vitest run tests/integration/dated-series/lead-time.test.ts
```

With `leadDays: 3`, a row for 14 March and the series set to **auto-approve + add to queue**:

- a tick on 11 March produces the post; ticks on 12, 13 and 14 March produce nothing for that row (US4 AS1);
- each queued target holds the **earliest free occurrence of its account's slots at or after
  2027-03-14 00:00 local**, never 11–13 March (US4 AS2, FR-039);
- `posts.queue_not_before` equals that local midnight;
- with **review-required**, the post waits in Review, `reviewedByUserId IS NULL`, every target
  `draft`, no occurrence held (US4 AS3) — and when a reviewer then approves it from Review on
  12 March, the slot is **still** on or after 14 March (the `queueFloor` guarantee, **B13**);
- with the account's slots full between 14 March and the end of the queue horizon, the post stays an
  approved draft with the reason recorded and is **not** queued before 14 March (US4 AS4);
- a target failing content validation leaves the post in review under auto-approve, with the
  validation reason, exactly as any other path (US4 AS5).

Plus `pnpm vitest run src/server/services/posts` for `queueFloor`'s unit cases: `NULL` → `now`, a
past floor → `now`, a future floor → the floor.

## SC-004 — A row for 29 February produces a post in 100% of years, leap or not

```bash
pnpm vitest run src/lib/series/dated.test.ts tests/integration/dated-series/due.test.ts
```

Unit: `targetDateFor({month:2,day:29}, y)` is `2028-02-29`, `2029-02-28`, `2030-02-28`,
`2031-02-28`, `2032-02-29` — and **never** `03-01` (A24, FR-031).
Integration: ticking on 28 February 2027 produces exactly one post for the Leap Day row and a tick on
1 March produces none; in 2028 the post lands on 29 February (US3 AS3).

## SC-005 — 100% of unusable rows are reported with their line number and a reason, 0% stored or silently dropped, and the report survives a reload

```bash
pnpm vitest run tests/integration/dated-series/import.test.ts
```

Imports one file containing **every** class of bad row — an unparseable date (`3/14`), an impossible
date (`02-30`), a past year-specific date (`2026-03-14`), a duplicate date-and-key, an eleventh row
on one date, an empty key value, a media reference matching nothing, one matching two assets, one
matching a video, and a row whose rendered instructions exceed 10,000 characters (**B3**) — and
asserts every other row is stored, every bad row is reported with its **file line** and the exact
message from [contracts/services.md](./contracts/services.md) § 6, and **no** bad row is in
`standing_series_dated_rows` (US2 AS1, FR-022, FR-023).

Then the whole-file refusals, each leaving the existing list byte-for-byte untouched: not UTF-8, over
1 MB, a duplicated column name, over 500 data rows, no `date` column, and a file lacking a column the
template uses (US2 AS2, AS4, FR-021).

Then a fresh server render with no client state still shows the problems, the filename and when it
ran (US2 AS3, FR-026) — asserted in `ui.test.tsx`.

## SC-006 — Two projects in different zones each fire on their own local date, 100%, including both DST directions

```bash
pnpm vitest run src/lib/series/dated.test.ts tests/integration/dated-series/due.test.ts
```

Unit: `isEligible(target, lead, today)` agrees with `dueInstant <= now < windowEnd` for every hour
across both DST transitions in `America/New_York` and `Pacific/Auckland`, for `leadDays` 0, 1 and 30
— the test that keeps the normative date form and the derived instant form from drifting (**B4**).
`dueInstant` for a date whose local midnight does not exist moves forward; for one that exists twice
it takes the earlier offset; exactly one instant in `Australia/Lord_Howe` (+10:30) and
`Asia/Kathmandu` (+05:45) too (US3 AS2, FR-033, the spec's half-hour edge case).

Integration: a New York project and an Auckland project each with a row for 14 March each fire on
their own local date and neither on the other's (US3 AS1); changing a project's zone from
`America/Los_Angeles` to `Pacific/Auckland` resolves the next due date in Auckland and leaves every
already-fired and already-missed occurrence untouched (US3 AS7, FR-041); a window straddling a zone
change is recomputed and fires if still inside it (the spec's edge case).

## SC-007 — Under two concurrent workers, repeated restarts and forced lease expiry, a due row produces exactly one post in 100% of runs

```bash
pnpm vitest run tests/integration/dated-series/idempotency.test.ts
```

Each case from [contracts/worker.md](./contracts/worker.md) § 7, asserted **by counting rows**:

- three rows due today, two un-awaited `runTick`s → **one** run for that date, **three** posts, three occurrences (US5 AS1);
- a run interrupted after some positions produced → the next tick continues from the first unfinished position and produces no second post for any row that has one (US5 AS2);
- a lease forced to expire mid-run → a later tick recovers and finishes it (US5 AS3);
- a credit hold on the day a row is due → not claimed, nothing generated, no attempt counted, no failure recorded, **no occurrence written**; when the hold clears inside the window the row fires normally (US5 AS4, FR-045);
- the same file re-imported while a run is open → matched rows keep their occurrences and nothing fires twice;
- two imports at once → one wins, the other is a `ConflictError`, and the list is never half-replaced (FR-029).

Repeat the concurrency case 20 times in the test to make "100% of runs" a claim the suite actually
makes.

## SC-008 — A row whose window closes unfired produces no post and is reported as missed in 100% of cases, and never produces afterwards

```bash
pnpm vitest run tests/integration/dated-series/missed.test.ts
```

- paused 1–20 March with a row for 14 March → Resume records the occurrence as `missed`, produces no post, and the next due date is the following year's (US3 AS4, FR-043);
- the worker down for all of 14 March with `leadDays: 0` → the first tick on 15 March records `missed` and produces nothing; with `leadDays: 3` and the worker down only on 14 March, the post already exists from 11 March (US3 AS5);
- a missed occurrence never produces a post on any later tick, ever;
- the bounded pass: a series switched on after a year writes at most 50 occurrences per tick and only for windows closed within 30 days, while **every** stale `next_target_date` is still advanced — including one 40 days old, which must not get stuck (FR-036, **B25**);
- `missed` and `retired` appear in the tick counts and the `standing_series` heartbeat (**B34**).

## SC-009 — Every attempt to change a list by a non-owner/admin is refused by the server, 100% of routes, including direct calls

```bash
pnpm vitest run tests/integration/dated-series/authz.test.ts tests/integration/actions-authz.test.ts
```

Calls `importDatedList`, `addDatedRow`, `updateDatedRow` and `deleteDatedRow` — **and** the four
server actions — as an editor, as a non-member, and with another project's series id and row id, and
asserts a refusal every time with the list unchanged (US6 AS2, AS3, FR-049, FR-051). An editor can
read the rows, the upcoming dates and the import problems (FR-050). A media asset belonging to
another project does not match a row's reference and is reported on import (US6 AS4).

## SC-010 — No row data of any kind reaches an image provider: 0 occurrences in the recorded prompts

```bash
pnpm vitest run tests/integration/dated-series/media.test.ts
```

With `mediaSource: "generate"` and rows carrying distinctive field values, asserts the **recorded
prompt** captured by the stub image provider contains the series' stored prompt and the fixed
real-people instruction and **nothing else** — no field value, no key value, no post text, no brand
field (FR-018). The same file covers:

- a row naming a portrait: the post carries that image, the asset is **not** marked used and **not** reserved, and the same row fires with the same image the next year (US1 AS6, FR-016);
- two rows naming the same image on the same date: both fire with it (A14, the spec's edge case);
- a row's reference winning over the series' source, and a row with none falling back to it (FR-017);
- a named asset deleted after import: the row survives and the occurrence **skips** with the media reason rather than failing (the spec's edge case, FR-046);
- a pool-fallback series with an exhausted pool: rows without their own image skip, rows naming one still fire;
- a media-required account with nothing usable: the position is skipped whole with the reason and the account recorded, counting as no failure (FR-046).

## SC-011 — The existing cadence behaviour is unchanged

```bash
pnpm vitest run src/server/services/jobs/sources/csv.test.ts
pnpm vitest run tests/integration/standing-series
```

**`csv.test.ts` must pass with no edit at all** — that is the proof of FR-020, not a claim about it
(**B1**). The whole `071` suite must pass with **no assertion about cadence semantics modified**;
`parity.test.ts` additionally asserts a cadence series created after this entry has
`occurrence_rule = 'cadence'`, `lead_days = 0`, a non-NULL `next_run_at`, no `dated` on any position,
and `queue_not_before IS NULL` on every post it produces.

---

## The spec's edge cases

```bash
pnpm vitest run tests/integration/dated-series/edges.test.ts tests/integration/dated-series/rows.test.ts tests/integration/dated-series/reimport.test.ts
```

| Edge case | Expected |
|---|---|
| a file with `date` and no other column | imports; `template_fields` empty; a template with no placeholder is fine |
| the only non-reserved column is the key column | identity is date + that value |
| a key value of only whitespace | reported and skipped |
| spaces around a date | trimmed, then parsed |
| `02-29` in a leap year | fires 29 February that year, 28 February in the other three |
| `2028-02-29` | a real date, fires once |
| `2027-02-29` | impossible, reported and skipped |
| a row for today imported after its due instant but before the day ends | fires on the next tick |
| 400 rows imported on 1 January with `leadDays: 30` | dates drain oldest first under the existing bounds; rows whose windows close while waiting are `missed` |
| eleven rows on one date | the first ten by file order import, the eleventh is reported (research § 3 says which years the count spans) |
| a template edited to stop using a column | the column stays a field and is unused |
| a named file later deleted | the row is kept; the occurrence skips with the media reason |
| a row naming a video | reported and skipped at import; an asset that becomes unusable later skips at fire time |
| the zone changed mid-window | recomputed; fires if still inside |
| a series deleted with a dated run open | the series, rows, occurrences and runs go; produced posts stay |
| two concurrent imports | one wins, the other is a conflict, never half-replaced |
| a +05:45 or +10:30 zone | local midnight is exactly one instant; the row fires once |
| re-import unchanged | rows keep their history; nothing fires twice (US2 AS5) |
| re-import with one row removed and one added | the removed row and its history go, the added row is pending, untouched rows keep their history, every produced post still exists (US2 AS6) |

---

## The final pass (constitution: run checks in proportion)

Once, at the end of the implement phase:

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm db:check      # the schema changed
pnpm build         # routes and the server/client boundary changed
```

Everything that would need real credentials — a live LLM call, a live image generation, a live
publish — is covered by a mocked-HTTP test and is reported as **verified with mocks only**.
