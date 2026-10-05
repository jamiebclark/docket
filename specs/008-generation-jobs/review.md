# Review: Generation jobs, batch mode and item sources (008)

**This is a re-review after remediation.** The constitution ("Review is exhaustive once, then scoped", `.specify/memory/constitution.md:115-128`) limits it to two questions:

1. Is each earlier finding fixed?
2. Did the files the remediation changed introduce a regression?

It opens no new lines of inquiry. Anything new it noticed is recorded as MINOR for the hardening entry.

**What the feature is:** 110 files changed across 13 commits, `7244e21..8236798^2`, merged to `main` as `8236798` (PR #13). The first review read the working tree, because none of the implementation was committed then (F5). The remediation was folded into those 13 commits, so the fixes cannot be separated from the feature by commit. This pass therefore reads the files each fix touched in their committed state at `main` HEAD `69cff5d`. Later 009 commits (`6072ac7`, `e97eed9`) touched some of the same files (webhook `emitEvent`, the `api` source, open jobs). Those changes belong to 009 and were reviewed there.

**Read in full:**

- `src/app/p/[projectSlug]/media/page.tsx` (F1)
- `src/app/p/[projectSlug]/jobs/new/page.tsx` and `jobs/new/form-data.ts` (F1, F2)
- `src/server/services/jobs/sources/media.ts` (F2)
- `src/server/dal/media.ts:105-230` (selection listing, search conditions, reservation)
- `src/server/services/jobs/manage.ts` (F3)
- `src/server/dal/jobs.ts:200-238` (`cancelForJob`, F3)
- `src/server/services/jobs/runner.ts:76-363` (finish, release, fail and catch paths that cancel interacts with)
- `docs/generator.md:39-60` and `docs/decisions.md:319-356` (F4)
- these tests: `tests/integration/jobs/create.test.ts:38-60`, `cancel.test.ts` (the assertions at lines 43-130) and `ui.test.tsx:165-185`

**Sampled:**

- `git log --format='%h %s | %(trailers…)' 7244e21..8236798^2` (F5)
- for F6–F14, by grep: `src/server/services/jobs/sources/csv.ts`, `src/lib/validation/jobs.ts`, `src/lib/validation/media.ts`, `core.ts`, `policy.ts`, `create.ts`, `MediaCard.tsx`, `CsvJobForm.tsx`, `CancelJobDialog.tsx`, `template.ts` and `validation/generation.ts`

**Not reviewed** (outside a scoped re-review): anything the remediation did not touch.

**Executed:** `pnpm vitest run tests/integration/jobs/create.test.ts tests/integration/jobs/cancel.test.ts tests/integration/jobs/ui.test.tsx tests/integration/jobs/reservation.test.ts`. Result: 4 files, 31 tests, all passed at HEAD. Per the constitution, I did not re-run the full suite, lint, typecheck or build.

## Verdict

**All five blocking findings from the first review are fixed. Nothing blocks.**

- **F1:** the media library now offers "Generate posts for these N images" whenever a tag, missing-alt or search filter is active, and a test covers it.
- **F2:** filter selections now list used matches as well, so the source counts and reports them.
- **F3:** cancel marks items that already have a post as `done`, so none stays `running`.
- **F4:** `docs/generator.md` and `docs/decisions.md` now carry the FR-032 content and the missing judgement calls.
- **F5:** the work landed as 13 scoped Conventional Commits, each with the trailer, and the stray `tasks.md-E` is gone.

The remediation introduced two small regressions, both in the F2 fix:

- a filter whose matches, used ones included, exceed 500 is now refused even when 500 or fewer of them are unused (F18);
- a filter whose matches are all used cannot reach the "Include images already used" option (F19).

It also left three smaller gaps:

- a `failed` item that has a post stays `failed` on a cancelled job (F20);
- the CSV header rule in the docs omits `.` and the 64-character limit (F21);
- T061–T065 are still unticked on `main` (F22).

None of these corrupts data or duplicates a post: the reservation index and the per-item unique link still hold. They are recorded as MINOR for the hardening entry, as the constitution requires. Of the earlier MINORs, F9 was resolved by 009 and F6–F8 and F10–F14 are still open.

## Findings

### Earlier blocking findings

- [x] MAJOR F1 — The media library had no "Generate posts" action for the current filter or tag. **Resolved.**
      where:  src/app/p/[projectSlug]/media/page.tsx:104-117, src/app/p/[projectSlug]/jobs/new/page.tsx:41-49, tests/integration/jobs/ui.test.tsx:169-178
      why:    When `canGenerate` is true and a tag, `missingAlt` or `q` filter is active with at least one match, the page renders a link to `jobs/new?source=media&mode=filter&…`. The job page parses all three keys into the same `{tag, missingAlt, q}` shape that `mediaSelectionSchema` accepts (`src/lib/validation/jobs.ts:19-26`). Both `list` and `listIdsForSelection` build their conditions with the same `searchCond` (`src/server/dal/media.ts:110-120`), so the job selects the same images the page showed. The `q` bounds also match: both schemas cap it at 100 characters. The test renders `MediaPage` with `tag: "dusk"` and asserts both the label and the href.
      traces: FR-028, FR-006, US1, T062

- [x] MAJOR F2 — A filter or tag selection never reported already-used matches. **Resolved** (see F18 and F19 for regressions).
      where:  src/server/services/jobs/sources/media.ts:28-32, src/server/services/jobs/sources/media.ts:51-56, tests/integration/jobs/create.test.ts:42-48
      why:    Filter mode now calls `listIdsForSelection({ ...filter, includeUsed: true })`. The loop then counts rows with `firstUsedAt` as `already_used` unless `includeUsed` is set, which is the same path pick mode uses. The new test (2 unused images and 1 used, all tagged `dusk`, `includeUsed: false`) expects `itemCount: 2` with `excluded: [{ already_used: 1 }]`, which is exactly the probe from the first review. The job page's "left out" line and the toggle (`jobs/new/page.tsx:122-127`) now have a non-zero `used` to show.
      traces: FR-029, FR-007, US3 scenario 3, T063

- [x] MAJOR F3 — Cancelling while an item had saved its post left it `running` forever. **Resolved** (see F20 for a remaining corner).
      where:  src/server/dal/jobs.ts:223-235, tests/integration/jobs/cancel.test.ts:116-118
      why:    `cancelForJob` runs a second update in the same transaction. It sets queued or running items that have a post to `done`, clears the lease and sets `finished_at`, all under the job's `FOR UPDATE` lock (`manage.ts:57`). The interaction with an in-flight runner is safe:
              - `commit` is lease-checked (`runner.ts:86-95`), and cancel cleared `leaseOwner`, so the runner's later `done` write is counted as stale and changes nothing;
              - the policy guard (`runner.ts:164-169`) sees `cancelled` and leaves the post in review.
              The test now asserts that the item ends `done` and that the counts show `running: 0, done: 1`.
      traces: FR-025, FR-004, data-model.md "State transitions", US5 scenario 7, T064

- [x] MAJOR F4 — `docs/generator.md` contradicted the feature and `docs/decisions.md` lacked required judgement calls. **Resolved** (see F21 for a small inaccuracy).
      where:  docs/generator.md:49-55, docs/generator.md:58-60, docs/decisions.md:347-356
      why:    The Out-of-scope line now names only the public API and image generation. The Jobs section adds:
              - the media template fields;
              - the CSV header and line-number rules;
              - the used-image and reservation rule;
              - retry and cancel behaviour;
              - authorisation of policies at creation.
              Decisions 11–20 add every item listed in the first review (cancel is final, policies are checked once, CSV is text-only, used images are skipped by default, file-line numbering, ⟦ ⟧/`<item_data>`, `incomplete` counts as lasting, no `generation_failures` rows, the guard and the removed `[section]` route), each with how to reverse it.
      traces: FR-032, T065

- [x] MAJOR F5 — None of the implementation was committed. **Resolved.**
      where:  specs/008-generation-jobs/tasks.md:184
      why:    `7244e21..8236798^2` has 13 commits split by layer (`feat(db)`, `feat(dal)`, `refactor(generator)`, `feat(jobs)`, `feat(scheduler)`, `feat(media)`, `test(jobs)`, `feat(llm-check)`, `docs`, `docs(review)`). Every one ends with the Co-Authored-By trailer. `specs/008-generation-jobs/tasks.md-E` is neither tracked nor on disk. The merge went through PR #13.
      traces: Constitution, Development Workflow "Commits", T061

### New in this pass (MINOR for the hardening entry)

- [ ] MINOR F18 — Since the F2 fix, a filter whose matches, used images included, exceed 500 is refused even when 500 or fewer of them are unused
      where:  src/server/services/jobs/sources/media.ts:31, src/server/services/jobs/sources/media.ts:34, src/app/p/[projectSlug]/jobs/new/page.tsx:72
      why:    Filter mode now lists used matches too, capped at `JOB_ITEMS_MAX + 1`. The 500-item check (line 34) runs on that raw list before the used rows are dropped (lines 51-56). Example: a `sunset` tag with 600 images, 450 of them used, and `includeUsed: false`. The 150 unused images would make a valid job, but the source throws "more than 500 images". The page's bare `catch` (F11) then replaces that message with "That selection can't be used." Before the fix, SQL filtered out the used rows and this job was accepted. The only workaround is pick mode, one page at a time.
      owed:   When `includeUsed` is false, apply the limit to the kept rows rather than the listed ids. One way: list unused and used matches in two capped queries, and count the used ones without loading them all.
      traces: FR-029, edge case "Job limits", review F2

- [ ] MINOR F19 — A filter whose matches are all already used ends at "No images to generate for." and never offers "Include images already used in posts"
      where:  src/app/p/[projectSlug]/jobs/new/page.tsx:80-90, src/app/p/[projectSlug]/jobs/new/page.tsx:123-127, src/app/p/[projectSlug]/media/page.tsx:116
      why:    With `includeUsed: false` and every match used, `preview.itemCount` is 0. The page returns the empty state before it renders the summary that holds the toggle. The media link that led there said "Generate posts for these 3 images", because `list.total` counts used images. The person has no way in the UI to include them except editing the URL (`includeUsed=1`). US3 scenario 3 is met only when at least one match is unused.
      owed:   When `itemCount === 0` and `used > 0` in a non-`unused` mode, render the "N already used" line and the include toggle in the empty state.
      traces: US3 scenario 3, FR-029, review F2

- [ ] MINOR F20 — Cancel leaves a `failed` item that already has a post as `failed` on the cancelled job, and the `cancelJob` doc comment still describes the old behaviour
      where:  src/server/dal/jobs.ts:217-219, src/server/dal/jobs.ts:232, src/server/services/jobs/runner.ts:353-357, src/server/services/jobs/manage.ts:49-52
      why:    An item can be `failed` with a post. Suppose `finish()` throws something other than a `ConflictError`, for example from `applyApprovalPolicy`. The outer catch calls `retryLater`, which calls `fail` once attempts run out. `cancelForJob` then reaches neither update for that item: the first skips items that have a post, and the second covers only `queued` and `running`. The item stays `failed`, so the job page shows "Failed 1" on a cancelled job, and retry is refused because the job is cancelled. Its image is already used, so no reservation leaks. The comment at `manage.ts:50-51` still says that items with a post "finish on their own".
      owed:   Include `failed` in the second update's status list. Update the comment.
      traces: FR-025, review F3

- [ ] MINOR F21 — The CSV header rule in the docs omits `.` and the 64-character limit that the parser enforces
      where:  docs/generator.md:50, src/server/services/jobs/sources/csv.ts:10-11, src/server/services/jobs/sources/csv.ts:58
      why:    The docs say headers "use letters, numbers, spaces, `-` or `_`". The parser accepts `/^[\p{L}\p{N} _.-]+$/u` up to 64 characters, and its own message says "_ - and .".
      owed:   Add `.` and the 64-character limit to the docs line.
      traces: FR-032, review F4

### Earlier MINORs, status at HEAD

- [ ] MINOR F6 — Still open. CSV problems display the line twice: `csv.ts:43-46`, `:73` and `:77` put `Line {n}: ` in the message, and `CsvJobForm.tsx:16` adds it again.
- [ ] MINOR F7 — Still open. Image preparation runs twice per item: `core.ts:100` calls `imagesForModel` again after `runner.ts:238`. Variant preparation also runs twice: `policy.ts:83` repeats `runner.ts:147`.
- [ ] MINOR F8 — Still open. `create.ts:166` stores `sourceMeta: prepared.meta`, which is only `{mode, includeUsed}`, and `skippedReserved` (`create.ts:182`) is still never shown.
- [x] MINOR F9 — Resolved by 009. `jobSourceSchema` now has a loose `api` member (`src/lib/validation/jobs.ts:35`), and the `api` source validates its own input.
- [ ] MINOR F10 — Still open. `MediaCard.tsx:45` shows "Unused" next to "In a job".
- [ ] MINOR F11 — Still open. `jobs/new/page.tsx:72` swallows the 500-limit message. F18 makes this path easier to hit.
- [ ] MINOR F12 — Still open. `CsvJobForm.tsx:12`, `:56` and `:62` use `red-300`, `neutral-600` and `red-700` without dark-mode variants. The CSV page has no voice, account or not-configured guards.
- [ ] MINOR F13 — Still open. `CancelJobDialog.tsx:16-18` closes on `ok` without showing a `changed: false` message.
- [ ] MINOR F14 — Still open. Two 10,000 constants: `src/lib/jobs/template.ts:6` and `src/lib/validation/generation.ts:9`.

### Notes

- NOTE F15 — Unchanged. A failed item in a finished job keeps its image reserved (`src/server/db/schema/jobs.ts:153`, `manage.ts:59-61`). This is by the spec's decisions.

- NOTE F16 — Unchanged. Latency is still unmeasured, and T058 is blocked on a key (`docs/decisions.md:321`).

- NOTE F17 — Unchanged. `src/server/dal/job-claims.ts` imports a service and casts to `ProjectScope`. The T044 text at `specs/008-generation-jobs/tasks.md:144` still says "PARTIAL".

- NOTE F22 — T061–T065 are still unticked on `main` (`specs/008-generation-jobs/tasks.md:184-188`), although the work is done and the findings above are ticked. Commit `18981ed` on the unmerged local branch `chore/review-bookkeeping` ticks them, and merging it closes them. This review does not re-tick existing tasks.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Earlier blocking findings (F1–F5) | 5 | 5 fixed | 0 | 0 | 0 |
| Earlier MINOR findings (F6–F14) | 9 | 1 resolved (F9, by 009) | 0 | 8 still open | 0 |
| Obligations the fixes traced to (FR-006, FR-007, FR-025, FR-028, FR-029, FR-032, US3-3, US5-7, constitution "Commits") | 9 | 6 | 3 (FR-029 and US3-3 via F18/F19, FR-025 corner via F20) | 0 | 0 |
| Regressions in files the remediation changed | — | — | 4 MINOR (F18–F21) | — | — |

FR-001–FR-032, SC-001–SC-010 and the constitution principles were swept in the first review (see its coverage table, preserved in git at `cfe055c`). Per the constitution, they were not re-swept here.

## What I could not check

- **Browser behaviour of the new filter link and the toggle:** keyboard focus, and how the "Generate posts for these N images" link reads next to the "Generate for all unused images" button. Both were checked only by server render and code reading.
- **F18 and F19 at scale.** I traced them by reading the code. I did not seed 600 images to reproduce F18, or an all-used tag to reproduce F19.
- **The full suite, lint, typecheck and build at HEAD.** Not re-run, per the constitution. Only the four job test files above were run.
- **Live model latency against the tick budget** (FR-031, SC-010, T058). No API key is available in this phase.
- **Whether later 009/010 edits to `manage.ts`, `dal/jobs.ts` and `sources/media.ts` changed the 008 fixes' behaviour** beyond what the four test files exercise. Those edits belong to their own entries' reviews.
