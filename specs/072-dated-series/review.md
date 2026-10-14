# Review: Date-pegged series — content that fires on an anniversary, from a spreadsheet

**This is the second review of this entry — a re-review after remediation.** Per
`.specify/memory/constitution.md:99` ("Review is exhaustive once, then scoped"), the first pass swept
every category and reported all 14 of its findings in one go; this pass checks only (a) that each
blocking finding of that pass is actually fixed and (b) that the files the remediation touched
introduced no regression. It deliberately opens no new lines of inquiry, and records what it noticed
in passing as MINOR for a hardening entry rather than as BLOCKER/MAJOR.

Reviewed 97 file(s) changed across 11 commit(s), against
`b59fb201f891218d0e10437b32015af2ae0913ab`...HEAD (`git merge-base HEAD origin/main`). The
remediation is one commit, `450d946 feat(dated-series): fix review blockers F1-F4 (T072-T076)`:
12 files, 563 insertions, 24 deletions, of which 143 insertions are the four new test groups.

**Read in full** (the remediation diff, every changed file in its surrounding context):
`src/lib/time/format.ts`, `src/lib/series/dated.ts` (the whole date-rule module, not just the diff),
`src/server/services/standing-series/run.ts` (the whole file — both the cadence and the dated
branch, `closeRun`, `closeStale`, `configFrom`, `shouldSelfPause`),
`src/server/services/standing-series/dated-rows.ts`, `.../dated-import.ts` (diff plus the whole
per-date counter and the transaction's existing-row path), `.../dated-due.ts` (whole),
`.../manage.ts` (`updateStandingSeries` and `fieldsFrom`), `.../read.ts` (`datedRowView` and
`getStandingSeries`), `src/server/dal/standing-series-dated.ts` (`recordMissed`),
`src/server/dal/standing-series-claims.ts` (the due predicate),
`src/server/services/standing-series/runner.ts` (the `openOrResumeRun` call site),
`src/app/p/[projectSlug]/jobs/series/[seriesId]/page.tsx` (every `LocalDate`/`formatMonthDay` call
site), `src/components/ui/LocalDate.tsx`, `src/lib/time/format.test.ts`, and all four new test
groups in `tests/integration/dated-series/{lead-time,ui,import,rows}.test.ts`.

**Sampled**: `specs/072-dated-series/research.md` § 3 and B20/B30, `contracts/services.md` § 7,
`contracts/worker.md` § 2, `tasks.md` Phase 11, and the previous `review.md` (reproduced below as the
re-check table).

**Not reviewed this pass**: everything the first review already swept and the remediation did not
touch — the schema and the four migrations, the DAL, the media/queue/scheduler integration, the
import parser extraction, the UI components other than the one changed line, and the 41,486 lines of
`drizzle/meta/*_snapshot.json`. The first review's coverage of those stands; re-reading them is what
the constitution's "exhaustive once, then scoped" rule exists to prevent.

**Ran** (targeted, per the constitution's "review: do not re-run the full suite" rule — implement's
final pass T076 and CI already ran the full gate on this code):

- `npx vitest run tests/integration/dated-series src/lib/time/format.test.ts src/lib/series/dated.test.ts`
  → **107 passed** across 13 files. The dated-series suite alone is **74 passed** across 11 files,
  up from the 66 the first review recorded: exactly the 8 cases the four new groups add (2 lead-time,
  1 UI, 2 import, 3 row-editor), with no existing case removed.
- `npx vitest run tests/integration/standing-series tests/lint` → **224 passed** across 29 files —
  byte-for-byte the same count the first review recorded, so the cadence path, the parity proof and
  the one-date-format lint rule are unregressed by the `format.ts` tightening.
- `npx tsc --noEmit` → clean.

## Verdict

**All four blocking findings are genuinely fixed, not papered over, and nothing the remediation
touched regressed. This is mergeable.** Each fix is the one the earlier finding's `owed` asked for
rather than a narrower dodge: the Rows cell now composes `${r.year}-${r.date}` so a year-specific row
renders a real calendar date, *and* `formatLocalDate` refuses a malformed input with a named error so
the next caller cannot repeat it; the dated resume check now spans the whole
`[period_start - lead_days, period_start]` window and only treats a run as stale once today has
passed `period_start`, which collapses to the old, correct behaviour at `lead_days = 0`; the per-date
cap is counted against resolved calendar dates through one new pure function, `resolvedCapDates`,
used by the importer and both row-editor paths alike, so `03-14` + `2027-03-14` and `02-28` + `02-29`
now collide as FR-013 and research § 3 require, with a defensive clamp in run-open so no residual
over-cap list can ever reach the `requested_count` CHECK; and `nextTargetDate` is now handed the
row's real fired years at both call sites that passed `[]`, with run-open skipping an
already-recorded row instead of rolling back every other row due that date. Four new test groups pin
all four, each written against the state the suite previously never reached. I verified the `why`
chains independently rather than trusting the tests: the claim predicate's open-run branch
(`src/server/dal/standing-series-claims.ts:67-77`) does make the resumed run reachable on a non-target
day, `recordMissed`'s `onConflictDoNothing` (`src/server/dal/standing-series-dated.ts:191`) does make
the new skip path self-heal into a recorded miss rather than a stall, and
`runner.ts:134`'s `if (!openResult) return` makes the clamp's and the skip's `null` a clean no-op
that bumps no counter. The five live findings below are all MINOR: one real-but-narrow correctness
hole left behind the F2 fix (the resume window reads the series' *current* `lead_days`, not the run's
own snapshot of it, so editing lead time downward mid-window re-opens the old symptom), the four
cosmetic/observability MINORs the first review already left for a human, and three NOTEs. None blocks
the merge, and `tasks.md` is therefore left byte-for-byte unchanged.

## Earlier findings, re-checked

| # | Severity then | Status | Evidence |
|---|---|---|---|
| F1 | BLOCKER | **Fixed** | `src/app/p/[projectSlug]/jobs/series/[seriesId]/page.tsx:190` now passes `` `${r.year}-${r.date}` ``; `src/lib/time/format.ts:35` rejects anything but `YYYY-MM-DD` with `InvalidLocalDateError` (`format.ts:26`). All five `LocalDate` call sites audited: `page.tsx:106` (`upcoming[].target`), `:147` (`occurrence.target`), `:190` (now composed), `:210` (`r.nextTargetDate`), `:260` (`run.periodStart` — a `PlainDate.toString()` for both cadence and dated runs) each pass a full date, so the new throw is unreachable from live code. Pinned by `tests/integration/dated-series/ui.test.tsx:123` asserting "Mar 14, 2027" and "once, in 2027" render. |
| F2 | BLOCKER | **Fixed** (narrow residue, F15) | `src/server/services/standing-series/run.ts:222-227` resumes while `windowStart <= today <= periodStart`. At `lead_days = 0`, `windowStart === periodStart`, so the predicate is identical to the old `periodStart === today` — which is why the 224 standing-series/lead-0 assertions are unchanged. Pinned by two new cases: `lead-time.test.ts:288` (lead 3, three rows, `standingSeriesMaxPosts: 2` — the shipped default — asserting one run, `produced_all`, every position `produced`) and `:317` (lead 3, a `timeout` failure on day 1 retried on day 2, asserting one run and `produced_all`). I separately confirmed the resumed run is *claimable* on a non-target day: `standing-series-claims.ts:67-77`'s open-run branch matches a `queued` position whose `next_attempt_at <= now` (:75), which is what makes the retry case reach the worker at all. |
| F3 | BLOCKER | **Fixed** | New pure `resolvedCapDates` (`src/lib/series/dated.ts:80`) returns the row's own year for a year-specific spec and `[today.year, today.year + 1]` for an every-year one, each through `targetDateFor` so the `02-29` → `02-28` collapse (A24) is applied before the key is formed — exactly the resolution `research.md:286-289` records. Used by the importer's counter (`dated-import.ts:227-233`) and by both `addDatedRow` (`dated-rows.ts:48-52`) and `updateDatedRow` (`dated-rows.ts:99-105`), so the cap is counted the same way on all three write paths. `run.ts:239-245` adds the clamp the finding asked for, so even an over-cap list that somehow slipped past all three would miss a date rather than make the insert violate `standing_series_runs_requested_count_range` and stall every tick. Pinned by four new cases (`import.test.ts:89`, `:101`; `rows.test.ts:72`, `:86`) covering `03-14` + `2027-03-14` and `02-28` + `02-29` in both the importer and the row editor. The pre-existing eleven-identical-rows case still passes, so the stricter counting did not lose the case the old bucketing did catch. |
| F4 | MAJOR | **Fixed** | `dated-rows.ts:107-111` and `dated-import.ts:303-307` both now read `tx.datedRows.firedYears(...)` and pass the result to `nextTargetDate` instead of `[]`. `run.ts:246-251` filters out any due row that already has an occurrence for `dueYear`, so the whole date's transaction no longer rolls back on `unique(row_id, year)` and the other rows due that date keep their posts. Pinned by `rows.test.ts:117`: a row recorded `missed` for 2026, edited forward to `06-01`, lands on `2027-06-01` while a second, never-fired row on the same date keeps `2026-06-01` — the collision the finding described cannot form. |

## Findings

No blocking findings. Five MINOR and three NOTE items are live; one (F15) is new to this pass, four
(F5-F8) are carried forward unfixed from the first review, where they were deliberately left out of
Phase 11 as non-blocking.

- [ ] MINOR F15 — the dated resume window reads the series' *current* `lead_days`, not the run's own snapshot, so shortening lead time mid-window re-opens F2 for that one run
      where:  src/server/services/standing-series/run.ts:224, src/server/services/standing-series/run.ts:49, src/server/services/standing-series/manage.ts:67
      why:    `windowStart = periodStart.subtract({ days: series.leadDays })` reads the live series
              row, but `updateStandingSeries` writes `leadDays` on every edit
              (`fieldsFrom`, manage.ts:67) with no effect on an open run. Shorten lead time from 5
              to 1 on 2026-03-10 while a run opened on 03-09 for `period_start = 2026-03-14` is
              still unfinished, and the next tick computes `windowStart = 2026-03-13`, so
              `insideWindow` is false and the run is handed to `closeStale`. Because
              `today (03-10) <= periodStart (03-14)`, `closeRun`'s dated branch (run.ts:47-57) does
              not mark the leftovers `missed` — they stay `queued` on a run whose `closed_at` is
              now set, and the claim predicate's open-run branch requires
              `closed_at IS NULL` (standing-series-claims.ts:69), so nothing ever looks at them
              again. The run's own rows were advanced to next year when it opened, so no replacement
              run forms either: that row produces nothing, this year or ever. This is strictly
              narrower than the F2 it is left behind by — F2 fired on *every* day of *every*
              lead-time window; this needs a lead-time edit made while a run is mid-window — and the
              F2 fix is exactly what its `owed` specified, so it is recorded as MINOR for a
              hardening entry per the constitution's re-review rule rather than as a new blocker.
      owed:   read the lead time the run itself recorded — `configFrom` already snapshots it into
              `run.config.leadDays` (run.ts:92) — instead of `series.leadDays`, so an open run's
              window cannot move under it; and make `closeRun`'s dated branch settle `queued` and
              `running` positions whenever it closes a dated run, not only when
              `today > period_start`, so no close path can leave an unreachable position behind. A
              case that edits `leadDays` downward between two ticks of an unfinished run.
      traces: FR-037, FR-040, US5 AS2, contracts/worker.md § 7

- [ ] MINOR F5 — every import problem is rendered with a doubled `Line N:` prefix  *(carried forward, unfixed)*
      where:  src/components/ui/CsvProblemList.tsx:7, src/server/services/standing-series/dated-import.ts:197, src/app/p/[projectSlug]/jobs/series/[seriesId]/page.tsx:163
      why:    the importer composes each row-level problem as `Line {row.line}: ...` *and* stores
              `line: row.line`; `CsvProblemList` prepends `Line {p.line}: ` whenever `line` is
              non-null, so the Last-import panel reads `Line 5: Line 5: "03/14" is not a date.`
              Inherited rather than introduced — `parseJobCsv`'s row messages are shaped the same
              way, so the jobs screen stutters identically today. Two smaller copy defects sit in the
              same panel: its heading is "This file can't be used:" inside an alert about a file that
              *was* partly used, and the count line's denominator is the number of rows **stored**,
              not the file's total. The remediation moved the per-date cap message
              (`dated-import.ts:229`) but kept its doubled shape, so the defect is unchanged in
              extent, not widened.
      owed:   carry the line number in `line` only and let the component render it, in the dated
              importer and in `parseJobCsv` alike; give the panel a heading that fits a partial
              import; compare against `rowCount + problems.length`.
      traces: FR-022, FR-026, US2 AS1

- [ ] MINOR F6 — Upcoming and "Next due" can show an occurrence whose window has already closed  *(carried forward, unfixed)*
      where:  src/lib/series/dated.ts:142, src/server/services/standing-series/read.ts:260, src/app/p/[projectSlug]/jobs/series/[seriesId]/page.tsx:106
      why:    `upcoming()` filters only on `nextTargetDate !== null` and never compares against the
              project's today, and the read path deliberately never writes (B24), so a row is retired
              only when the worker next evaluates the series. A **paused** series is never claimed,
              so from 15 March onward its screen still announces 14 March as the next due date, until
              someone resumes it. FR-044 requires the next due date to be "the earliest occurrence
              that is still ahead of now or still inside its window".
      owed:   drop occurrences whose window has closed inside `upcoming()` — it already receives the
              zone and the lead days, so `localToday`/`isEligible` is all it needs.
      traces: FR-044, A34

- [ ] MINOR F7 — the import control renders up to three times on one page with the same DOM ids  *(carried forward, unfixed)*
      where:  src/app/p/[projectSlug]/jobs/series/DatedListImport.tsx:53, src/app/p/[projectSlug]/jobs/series/[seriesId]/page.tsx:140, src/app/p/[projectSlug]/jobs/series/[seriesId]/page.tsx:172, src/app/p/[projectSlug]/jobs/series/[seriesId]/page.tsx:182
      why:    `DatedListImport` hard-codes `id="dated-list-file"` and `id="dated-list-file-hint"`,
              and the page mounts it in the Upcoming empty state, in the Rows card's actions and in
              the Rows empty state. A newly created dated series with no rows therefore renders three
              file inputs sharing one id, three `<label htmlFor="dated-list-file">` and three
              `aria-describedby="dated-list-file-hint"`. A browser resolves every one of those labels
              to the *first* input, so activating the label in the Rows card drives a different
              component instance than the one the user clicked.
      owed:   derive the ids from `useId()`, as `StandingSeriesForm` already does with its `uid`, or
              render the control once.
      traces: FR-053, Constitution "Accessibility: ... labelled controls"

- [ ] MINOR F8 — the `missed` and `retired` tick counts are declared, printed, and never incremented  *(carried forward, unfixed)*
      where:  src/server/services/standing-series/runner.ts:54, src/server/services/standing-series/runner.ts:79, src/server/services/standing-series/run.ts:214, src/server/scheduler/loop.ts:32
      why:    contracts/worker.md § 5 adds both fields so the sweep is observable, and `loop.ts`'s
              summary line and the `standing_series` heartbeat both carry them. But
              `evaluateDatedSeries` returns `{ dueDate, missed, retired }` and
              `openOrResumeDatedRun` destructures only `dueDate` — nothing in the tree ever writes
              `counts.missed` or `counts.retired`, so `series_missed=0 series_retired=0` is printed
              unconditionally and `loop.test.ts` asserts exactly those zeros. The remediation added
              two more silent paths to the same blind spot: the F3 clamp (`run.ts:245`) and the F4
              skip (`run.ts:251`) each drop a row from a date's run without recording anything an
              operator could see.
      owed:   add the evaluation's two numbers, the `closeRun` dated branch's misses, and the two new
              drop paths into the tick counts, and assert a non-zero summary in a test that actually
              sweeps a miss.
      traces: contracts/worker.md § 5, B34, FR-035

- NOTE F16 — `formatLocalDate`'s new `InvalidLocalDateError` guard (src/lib/time/format.ts:35) has no
  failing-case test: `src/lib/time/format.test.ts` covers only the happy path, so the guard T072
  asked for is an assertion with no test that would notice if it were removed. Cheap to add
  (`expect(() => formatLocalDate("03-14")).toThrow(InvalidLocalDateError)`), and worth it precisely
  because the guard's whole purpose is to catch a *future* caller.

- NOTE F17 — the importer's existing-row refresh now issues one `firedYears` query per retired row
  inside the import transaction (src/server/services/standing-series/dated-import.ts:305), where it
  previously issued none. Bounded by the rows whose `next_target_date` is already `null`, so at worst
  500 extra round trips inside one transaction on a full re-import of a fully retired list. Correct,
  and cheaper than the bug it replaces, but one batched `firedYears(ids)` before the loop — the shape
  `run.ts:250` and `evaluateDatedSeries` both already use — would collapse it to one query.

- NOTE F18 — `research.md:271` (B30) records `formatLocalDate("2027-03-14")` as "Sat, Mar 14, 2027",
  with a weekday; the implementation returns "Mar 14, 2027" (src/lib/time/format.ts:37, pinned by
  `format.test.ts:6` and now by `ui.test.tsx:127`). Pre-existing doc drift, not introduced by the
  remediation, and the code is the better choice — a weekday is noise on a date that carries its
  year. Noted so nobody "fixes" the formatter to match the research note.

The first review's remaining NOTEs (F9 the dead `importProblemLine` export, F10 the unreachable
`DATED_ROWS_MAX` branch, F11 the duplicated key value in the Upcoming table, F12 `datedRowView`'s
per-row query, F13 the missing/mismatched `Co-Authored-By` trailers, F14 the undocumented reliance on
Postgres' default `NULLS LAST`) all still stand unchanged; the remediation touched none of them. F13
in particular still needs a human: the remediation commit carries `Co-Authored-By: Claude Sonnet 5`,
not the literal `.specify/memory/constitution.md:92` names, and fixing it across eleven commits is a
history rewrite a remediation pass should not do unattended.

## Coverage

This pass's denominator is the blocking set of the first review plus the files the remediation
touched — not the whole spec, which the first review already swept.

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Earlier blocking findings (F1-F4) | 4 | 4 fixed | 0 | 0 | 0 |
| Obligations they contradicted (FR-013, FR-047) | 2 | 2 | 0 | 0 | 0 |
| Obligations they left partial (FR-037, FR-040, FR-044, FR-053, SC-003, US1 AS5, US4 AS1, US5 AS2, US5 AS3, A11, A22, A24) | 12 | 10 | 2 (FR-044 — F6; FR-053 — F7) | 0 | 0 |
| Files changed by the remediation, re-read for regression | 8 | 8 | 0 | 0 | 0 |
| Constitution principles bearing on the changed files (III, IV, VI, accessibility, "tests required") | 5 | 4 | 1 (accessibility — F7) | 0 | 0 |
| Non-blocking findings of the first review (F5-F8) | 4 | 0 | 4 still open | 0 | 0 |

- **FR-013/A11/A24 are now satisfied** on all three write paths, through one shared function rather
  than three local predicates — Principle IV ("one service layer, many callers") honoured rather than
  worked around. Verified against `research.md:286-289` rather than the spec alone, because that is
  where the two-year horizon was decided; the implementation matches it exactly, including the
  consequence that an every-year row and a year-specific row more than one year out are *not* counted
  together. That is the design, not a gap: the `run.ts:239-245` clamp is what keeps the far-future
  case a missed date rather than a stalled series, and `recordMissed`'s `onConflictDoNothing` is what
  makes the dropped row settle as a recorded miss on the next day's sweep.
- **FR-003, FR-020 and SC-011 (cadence and the shared parser unchanged) re-verified by running**, not
  by reading: the 224 standing-series + lint assertions and the byte-identical
  `src/server/services/jobs/sources/csv.test.ts` both still pass after `format.ts` was tightened and
  `run.ts` changed — the two files where a dated-series fix could plausibly have reached the cadence
  path.
- **The four new test groups are not self-affirming.** Each asserts an observable outcome — run
  count, run outcome, every position's status, the stored `next_target_date`, the exact problem
  message, the rendered HTML — rather than re-stating the code. The F2 lead-window case deliberately
  runs at the *shipped* `standingSeriesMaxPosts: 2` rather than the suite's usual 5 or 10, which was
  the specific coverage gap the first review called out. No existing assertion was weakened,
  loosened or deleted: `git show 450d946 --stat` is additions only in the four test files
  (+25, +55, +53, +10 lines), with the only deletions in the commit being the eight code lines the
  fixes replace.

## What I could not check

- **SC-001 and contracts/ui.md § 10's rendered-state checklist.** Still unverified in a browser: it
  needs a real `pnpm dev`, a signed-in owner and a real CSV. T071 records the same gap and marks
  itself unachievable in a headless phase. F1 was exactly the kind of defect this gap hides, and its
  fix is now pinned by a server-render assertion rather than by a human walkthrough — so the *shape*
  of the gap is unchanged even though its worst known instance is closed.
- **F15 was reasoned, not executed.** I confirmed every link in its chain against the code
  (`fieldsFrom` writes `leadDays` on every update; `insideWindow` reads the live `series.leadDays`;
  `closeRun`'s dated branch is guarded on `today > period_start`; the claim predicate requires
  `closed_at IS NULL`) but did not run it, because this phase may not write code and a probe would
  need a new test file. Its MINOR classification reflects that as well as the constitution's
  re-review rule.
- **`pnpm lint`, `pnpm build` and the Docker image build.** `tsc --noEmit` is clean and the targeted
  suites pass; per the constitution's "review: do not re-run the full suite, lint, typecheck or
  build" rule I read T076's record of them rather than re-running. A lint-only or build-only
  regression in the remediation would not have been caught here — though it changed no route, no
  config and no server/client boundary, and added no import `tsc` would not have seen.
- **Anything needing a live provider, and Neon.** Unchanged from the first review: text through the
  stub `LlmProvider`, images through `setImageProviderForTests`, and the four migrations exercised
  only against the local Postgres on port 5555.
- **Load and retention.** Nothing measures a 500-row import (now marginally more query-heavy per
  F17), the missed sweep against a large backlog, or the occurrence prune at volume; those bounds are
  argued structurally, not observed.
