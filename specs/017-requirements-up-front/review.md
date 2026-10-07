# Review: Requirements up front (017), re-review after remediation

Reviewed 42 implementation files (29 modified, 13 new; spec artifacts excluded) against `b3277ff` (merge-base with `origin/main`). The branch has 2 commits, both spec/plan docs. **The implementation is still uncommitted**, so this reviews the working tree (`git diff b3277ff` plus untracked files), not a commit range.

This is the second review. Under the constitution's rule ("a re-review after remediation checks ONLY that each earlier finding is fixed and that the files changed by the remediation introduced no regression"), its scope is:
- the two blocking findings from the first review (F1, F2) and their tasks T047 and T048;
- the files the remediation changed: `src/components/compose/requirements-ui.ts`, `src/components/compose/requirements-ui.test.ts`, `src/app/p/[projectSlug]/compose/Composer.test.ts`, the new `src/server/services/media-fit.test.ts` and `tests/integration/media/fit.test.ts`. Nothing is committed, so these come from T047/T048 and the implement pass's output, not from a diff;
- re-confirming the first review's MINORs at their cited lines;
- the DB-backed suites the first review could not run. `DATABASE_URL` is now set, and the earlier sandbox had no Postgres.

Read in full: all five remediation files, plus `src/providers/requirements.ts`, `src/server/services/media-fit.ts`, `RequirementsSummary.tsx`, the preview part of `Composer.tsx`, and `MediaPicker.tsx`/`FitBadges.tsx`/`fit-ui.ts` for the regression check. Every other changed file was read in full by the first review and only sampled here, at the lines its findings cite.

Run:
- **Feature test subset, twice:** `src/providers`, `src/components`, `media-fit.test.ts`, `Composer.test.ts`, `tests/lint`, `tests/integration/{media,compose,docs,limits,instagram,facebook}` and `compose-check-route.test.ts`. Real Postgres, 100 files, 1,090 tests. Both runs: 1,089 pass, and 1 is a timeout (NOTE F13).
- **Named new rows, verbose:** `limits/enforcement`, `media/fit` and `compose-check-route`, 85 tests, all pass. They include `instagram: hashtags`, `instagram: mentions` and `instagram: min width`, `facebook: bytes per file`, and the four route `requirements` cases.
- **Probe:** `fitOf` for a dimensionless JPEG, PNG and WebP against every provider (18 cases).
- **Timing comparison:** `tests/integration/instagram/limits.test.ts` alone, on this tree and on `b3277ff`, in a temporary detached worktree that has since been removed.

## Verdict

Yes: the feature now meets its spec, and the remediation added no regressions. There are no BLOCKER or MAJOR findings, so `tasks.md` is unchanged. Once CI is green it can go to a human to merge.

- **F1 is fixed.** The "Text" row now names the counting rule, read from the data: "2,200 characters (code points)", "280 characters (x-weighted)", "500 characters (threads)". The name is left off only where it repeats the unit ("300 graphemes"). The literal-scan lint test still passes.
- **F2 is fixed.** The SC-003 matrix now runs without a database and is strict for every image with dimensions: state, steps and messages must all equal the planner's. It ran and passed here. The scoping cases (US2 AS5–AS7, foreign id) ran against Postgres for the first time and pass.
- **The first review's gaps are closed.** It could not run the caption caps at the check route and in the scheduling/publish suites, the requirements route tests, or the Instagram 50-a-day test. All of them pass now.

Two small leftovers from the remediation's tests are recorded as MINOR (F11, F12). The seven MINORs from the first review (F3–F9) are all still open and unchanged. None of them blocks.

## Findings

### Resolved since the last review

- F1 (was MAJOR): fixed. `textLimitText` at `src/components/compose/requirements-ui.ts:10` reads `requirements.text.countingRule`, and `detailRows` uses it at `src/components/compose/requirements-ui.ts:49`. Tests: `src/components/compose/requirements-ui.test.ts:24` and `src/components/compose/requirements-ui.test.ts:53-59` (Instagram, Bluesky, Threads, X). The probe shows Facebook's row also reads "10,000 characters (code points)". The gist (`src/components/compose/requirements-ui.ts:27`) is unchanged. That is allowed: the first review asked for the name in the gist only "if it fits".
- F2 (was MAJOR): fixed. In `src/server/services/media-fit.test.ts:36-47`:
  - every image with dimensions must give `state === {original: "fits", derive: "converted", refuse: "refused"}[plan.kind]`;
  - `steps` and `details` must equal the plan's;
  - so a validator refusal of a derived image would now fail the test.
  US2 AS1–AS4 have their own fixed expectations at `src/server/services/media-fit.test.ts:52-77`. The scoping cases stay at `tests/integration/media/fit.test.ts:31-57` and pass against Postgres. One clause of the fix was not done (F11).

### Open

- [ ] MINOR F11: the dimensionless row in the SC-003 matrix accepts either answer
      where:  src/server/services/media-fit.test.ts:33, specs/017-requirements-up-front/tasks.md:160
      why:    T048 (ticked) asked for "the dimensionless row as its own explicit expectation". The test instead asserts `["fits", "refused"]).toContain(fit.state)`, which only rules out "converted". The probe shows that a dimensionless 200 kB JPEG gives "fits" for every one of the six providers. So a regression that badged every dimensionless JPEG "will be refused" would still pass. Uploads always have dimensions, so no realistic input reaches this row today (first review, F3). That is why this is MINOR.
      owed:   Assert `expect(fit.state).toBe("fits")` and `expect(fit.details).toEqual([])` for the dimensionless JPEG. Optionally add a dimensionless WebP row that expects "refused" for Instagram, as research P5 describes.
      traces: SC-003, FR-010, review F2

- [ ] MINOR F12: the composer test for the rule name uses an account whose name is hidden, so it cannot fail
      where:  src/app/p/[projectSlug]/compose/Composer.test.ts:94
      why:    T047 asked for the rule name to be asserted "for one account in Composer.test.ts". The assertion added is `"300 graphemes</dd>"`, for Bluesky, where the name is omitted because it equals the unit. The pre-fix code produced exactly that string, so this assertion does not tell fixed code from unfixed. The helper's own tests do cover the fix (`src/components/compose/requirements-ui.test.ts:55-58`), so only the wiring through the composer goes unasserted.
      owed:   Render an Instagram or X target in that test and assert "2,200 characters (code points)</dd>" or "280 characters (x-weighted)</dd>".
      traces: FR-001, US1 AS1, review F1

- [ ] MINOR F3: `fitOf` checks with `validateAgainstCapabilities`, not the provider's own `validate` that research P5 and the decision record describe
      where:  src/server/services/media-fit.ts:35, docs/decisions.md:639
      why:    Still open. The shared validator skips `validateInstagram`, `validateThreads` and `validateX`, which excuse PNG and oversize files for the planner. The probe here shows one result: a dimensionless PNG is "refused" for Instagram, although the first review found that the gate accepts it. The first review found 11 such cases. None is reachable through upload.
      owed:   Call `validateResolvedContent(provider, …)` as P5 says, or record in decisions.md why the shared validator is used.
      traces: FR-010, constitution IV, research P5

- [ ] MINOR F4: the summary sits inside the preview's polite live region and relies on a nested `aria-live="off"`
      where:  src/app/p/[projectSlug]/compose/Composer.tsx:297, src/app/p/[projectSlug]/compose/Composer.tsx:328, src/components/compose/RequirementsSummary.tsx:23, specs/017-requirements-up-front/contracts/compose-check.md:85
      why:    Still open. The contract, T030 and decisions.md P9 put the summary outside the live region. Screen readers handle a nested `off` unevenly, so when a card changes from "Checking…" to its result, the whole summary may be read out.
      owed:   Make the live region wrap only the counter, the text and the issues, or change the contract and P9 to match the code.
      traces: FR-007

- [ ] MINOR F5: a `#` or `@` inside a URL with no scheme is still counted
      where:  src/providers/text.ts:39
      why:    Still open. The URL mask matches only `scheme://` and `www.`, so `example.com/#top` counts as a hashtag and `x.com/@user` as a mention. This over-counts, the safe side of D7.
      owed:   Extend the mask to bare `host.tld/…` forms, or record the limitation next to P4.
      traces: FR-012

- [ ] MINOR F6: Instagram source comments contradict the research
      where:  src/providers/instagram/capabilities.ts:32, src/providers/instagram/capabilities.ts:3, tests/integration/instagram/limits.test.ts:1
      why:    Still open. "Meta's own quota (read at run time) is 100" describes the test fake. The research has the `content_publishing_limit` reference saying `quota_total` is "currently 50". Line 3 still says "R1 interim" for the 2,200 limit.
      owed:   Reword both comments to match `docs/research/meta.md`.
      traces: constitution I, FR-013, research P12

- [ ] MINOR F7: `docs/limits.md` contradicts itself on narrow Instagram images, and the provider guide lacks P14's sentence
      where:  docs/limits.md:38, docs/limits.md:9, docs/adding-a-provider.md:78
      why:    Still open:
              - the `max width` row still says "narrower is accepted (D15)", directly below the `min width | 320` row;
              - the Source bullet describes only the old `interim, UNVERIFIED` form;
              - the guide documents the new fields but never says that the summary and the badges read capabilities automatically.
      owed:   Drop the phrase, describe the "UNVERIFIED (not documented by …, checked …)" form, and add the one sentence.
      traces: FR-014, FR-018, research P11/P14

- [ ] MINOR F8: the SC-004 literal scan lists files instead of covering the directories P13 names
      where:  tests/lint/ui-limit-literals.test.ts:8
      why:    Still open. These files are not scanned: `composer-logic.ts`, `ScheduleDialogs.tsx`, the compose `page.tsx`, `MediaEditDialog.tsx` (alt text), `MediaCardActions.tsx`, `MediaSelection.tsx` and `DeleteMediaDialog.tsx`. None of them holds such a literal today.
      owed:   Glob the directories.
      traces: SC-004, research P13

- [ ] MINOR F9: the summary uses decimal MB, and the library cards use binary sizes labelled "MB"
      where:  src/providers/requirements.ts:60, src/components/media/MediaCard.tsx:12
      why:    Still open. An 8,300,000-byte JPEG reads "7.9 MB" on its card, Instagram's summary says the maximum is "8 MB", and the badge correctly says "will be converted".
      owed:   Use one convention on these surfaces.
      traces: FR-001, US2

- NOTE F10: none of the implementation is committed. All 42 files and the untracked `tasks.md`/`review.md` exist only in this worktree. The constitution's workflow asks for a commit per task, so the handoff depends on the runner committing them.

- NOTE F13: `tests/integration/instagram/limits.test.ts:68` (150 queued targets) went over the 20 s test timeout in both runs of the 100-file subset (24.2 s on the second run). It passes alone. This feature did not make it slower: run alone, the current test took 11.8, 11.7 and 4.6 s, and the `b3277ff` version (the 101st-publish test) took 8.3, 11.3 and 8.2 s. It is a heavy test that sits near the timeout when workers compete, and full `pnpm test` in CI could flake on it. The fix belongs to the suite (a per-test timeout), not this entry.

- NOTE F14: Threads' rule name is `threads`, so its row reads "500 characters (threads)". That meets the spec ("the rule's own name and unit") but tells the reader less than "(code points)" or "(x-weighted)" do: nothing says emoji count as bytes. Renaming the rule in `src/providers/threads/text.ts` would change it everywhere the name is shown, including the counter.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted | Unverified |
|---|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-025) | 25 | 23 | 1 (FR-012 F5) | 0 | 0 | 1 (FR-025) |
| Success criteria (SC-001–SC-007) | 7 | 6 | 0 | 0 | 0 | 1 (SC-007) |
| US1 acceptance scenarios | 5 | 5 | 0 | 0 | 0 | 0 |
| US2 acceptance scenarios | 7 | 7 | 0 | 0 | 0 | 0 |
| US3 acceptance scenarios | 6 | 6 | 0 | 0 | 0 | 0 |
| Edge cases | 10 | 9 | 1 (hashtag-like text F5) | 0 | 0 | 0 |
| Constitution principles (I–VII) | 7 | 5 (II, III, V, VI, VII) | 2 (I F6, IV F3) | 0 | 0 | 0 |
| Plan decisions (P1–P15) | 15 | 9 | 6 (P5 F3, P9 F4, P11 F7, P12 F6, P13 F8, P14 F7) | 0 | 0 | 0 |
| Earlier blocking findings | 2 | 2 (F1, F2) | 0 | 0 | 0 | 0 |

How these were judged:
- **Changed since the first review:**
  - FR-001, US1 AS1 and the custom-rule edge case are satisfied by F1's fix, which its tests check.
  - FR-010, SC-003 and constitution II are satisfied by F2's fix and by these tests now having run. SC-003 counts as satisfied because it holds for every image an upload can produce. Its dimensionless row is asserted loosely (F11).
- **Now run against Postgres, previously judged from the code:**
  - FR-004 (route `requirements` equals `limit`/`countingRule`, including over-limit text);
  - FR-011 and SC-006 (31 hashtags and 21 mentions are refused at the check, at scheduling and at publish time; 30 and 20 are not);
  - US2 AS5–AS7 and the foreign-id case;
  - US3 AS4 (no 51st publish, and no provider call for the rest);
  - US3 AS5 (`facebook: bytes per file`).
- **Everything else** carries over from the first review, which read every changed file. Under the re-review rule it was not re-opened.

## What I could not check

- **The full `pnpm test`, `pnpm lint`, `pnpm typecheck` and `pnpm build`.** The constitution says review does not re-run them. T046 is ticked, but the implement output on disk records only DB-free runs: 65 files and 719 tests, plus `tsc --noEmit`. It does not show the full suite against Postgres. I ran the feature's 100 test files instead. Nothing is pushed, so there is no CI result to read, and FR-025/SC-007 stay unverified until CI runs. F13 says which test may flake there.
- **A browser session:** how VoiceOver, NVDA and JAWS treat the nested `aria-live="off"` (F4), whether `<details>` stays open across re-checks, the picker re-querying when its accounts change, and how several summaries and badge rows fit on a narrow screen.
- **Live platform behaviour:** whether Instagram really refuses widths under 320, how Meta counts hashtags and mentions, and whether the real quota is 50 or 100. Provider behaviour is verified with mocks only.
