# Review: Auto-growing, monospace prompt and instruction fields

**This is a re-review after remediation** (review attempt 2; the first review's verdict and its eight findings
F1–F8 are superseded by this file). Per `.specify/memory/constitution.md:125-128`, a re-review checks only that
each earlier finding is fixed and that the files the remediation changed introduced no regression; it does not
re-open the exhaustive sweep, and anything else it notices is recorded as MINOR rather than BLOCKER/MAJOR.
Per `.specify/memory/constitution.md:112-114` it also does not re-run the full suite, lint, typecheck or build;
those were read from the remediation pass's own run, and only targeted tests were re-executed here.

Reviewed 18 source files (14 modified, 4 new) plus 4 documentation files, across 4 commits, against
`2c0b8e6...HEAD`. Unlike the first review, the implementation is now **committed** (`dc232db`, 2026-10-10
02:25:38 -0400) and the working tree is clean, so this is a real branch diff rather than a working-tree read.

Read in full: `src/components/ui/TextareaField.tsx`, `src/components/ui/textarea-sizing.ts`,
`src/components/ui/TextareaField.test.tsx`, `src/components/ui/textarea-sizing.test.ts`,
`src/components/ui/controls.ts`, `src/components/ui/Field.tsx`, and the complete `2c0b8e6...HEAD` diff of all
14 modified source files and all 4 documentation files. Also read: this feature's `spec.md` (requirements,
success criteria, edge cases, assumptions), `data-model.md` sections 1–2, `tasks.md` Phase 6–7,
`contracts/ui.md`, `contracts/component.md`, `.specify/memory/constitution.md`, the `## 034` entry in
`docs/decisions.md`, and the first review's three remediation tasks T033–T035.

Sampled: `.next/static/chunks/106geqa-psd1v.css` (the `\!text-base`, `.text-sm`, `.leading-relaxed`,
`--text-base`, `--leading-relaxed` and `box-sizing` output), `tests/integration/jobs/ui.test.tsx` and
`tests/integration/accounts-ui.test.ts` (grepped for the assertions the remediation could have broken),
`src/app/p/[projectSlug]/compose/Composer.test.ts:212-235`, and the remediation pass's own transcript
(session `e052efd0`) for its `pnpm lint` / `pnpm typecheck` / `pnpm build` results.

Not reviewed: the obligations the first review already swept and the remediation did not touch — they are
carried over as checked there, not re-asserted here (named under "Coverage" and "What I could not check"). Also
not reviewed: the rest of the repository, which this entry does not touch.

## Verdict

**All three blocking findings are fixed, and the remediation introduced no regression. Nothing blocks the
merge.** F1: `resize()` now calls `releaseHeight(el)` before reading `scrollHeight`
(`src/components/ui/TextareaField.tsx:18`), and because a `<textarea>` at `height: auto` takes its intrinsic
height from `rows` rather than from its content, the released element reports a content-driven `scrollHeight` —
so a field that has grown to the ceiling measures back down to the floor when the text is deleted. F2: the
composer now forces `!text-base`, which the built stylesheet confirms emits
`font-size:var(--text-base)!important;line-height:var(--tw-leading,var(--text-base--line-height))!important`,
so the field really renders at 16 px and `leading-relaxed` still supplies the 1.625 line-height through
`--tw-leading` — making `ROW_REM_COMPOSER` exact (6 × 26 + 16 = 172 px floor, 14 × 26 + 16 = 380 px ceiling,
matching the inline `calc(9.75rem + 0.875rem + 2px)` and `calc(22.75rem + 0.875rem + 2px)`), and the now-dead
`min-h-40` is gone. F3: the `{{field}}` chip row is back as its own `<ul>` between the hint and the control,
through a new `beforeControl` slot that is deliberately excluded from `aria-describedby`
(`src/components/ui/TextareaField.tsx:68`, `:102`), so the textarea's accessible description is the
one-sentence hint again; `contracts/component.md:121,141` and `contracts/ui.md:45` were updated to match, and
all three fixes are recorded in `docs/decisions.md` per FR-036.

What is left is three MINORs, none of which is a reason to hold the merge. Two are the first review's F4 and F5
carried forward unfixed — correctly, since neither was ever tasked: `JobForm` and `GenerateForm` still render
their field error outside the primitive's reserved `aria-live` line, and the one test named for
`measureHeight`'s row-height fallback still exercises neither branch of it. The third is new and sits in the
same scripted fallback F1 repaired: `measureHeight` compares a padding-box measurement (`scrollHeight`) against
border-box bounds and the result is then assigned as a border-box `height`, so the fallback lands about 2 px
short of its own content and shows a hairline scrollbar on a field that FR-008 says must not scroll. It is
MINOR because it only reaches browsers without `field-sizing: content` — not the path any current Chrome, Edge,
Safari or Firefox takes — and because the symptom is 2 px, not a broken field. All three belong to a hardening
entry.

The adoption and classification work the first review verified still holds on the committed tree: 17
`<TextareaField>` elements across 12 source files, which is the 13 sites the spec counts; 10 `mono` call sites,
which is the 6 sites of FR-018; no hand-rolled `<textarea>` anywhere in `src/` outside the primitive except a
regex literal in a test; and all 16 rows of `data-model.md` section 2 match the
`minRows`/`maxRows`/`mono`/counter values that landed, including the two the remediation changed.

## Findings

- [ ] MINOR F1 — The scripted fallback measures a padding-box height and assigns it as a border-box height, so
      it lands 2 px short of its own content and shows a scrollbar on a field FR-008 says must not scroll.
      where:  src/components/ui/textarea-sizing.ts:99, src/components/ui/TextareaField.tsx:23
      why:    Tailwind's preflight sets `box-sizing: border-box` for everything (confirmed in the built
              stylesheet), so the `height` assigned at `TextareaField.tsx:23` includes the control's 1 px
              borders. `input.scrollHeight` does not: `scrollHeight` is the scroll area including padding but
              *excluding* borders. `measureHeight` takes `Math.max(input.scrollHeight, floorPx)` where
              `floorPx` correctly adds `CONTROL_CHROME.borderPx`, and that value is then written as a
              border-box `height` — so whenever content rather than the floor decides the answer,
              `clientHeight` comes out at `scrollHeight - 2`, the content overflows by 2 px, and
              `overflow-y: auto` shows a scrollbar. Concretely: in a browser where
              `CSS.supports("field-sizing","content")` is false, type ten lines into the composer's post text —
              `scrollHeight` is 274 px (10 × 26 + 14 padding), the field is set to 274 px border-box, its
              padding box is 272 px, and a 2 px scrollbar sits on a field between its 172 px floor and its
              380 px ceiling. The same arithmetic applies to all thirteen fields. A second, smaller term in the
              same expression: `chromePx` uses `input.rootPx ?? 16` and `resize()` never passes `rootPx`
              (`TextareaField.tsx:21`), so under a non-16 px root font size the fallback's floor is computed
              from an assumed padding while the element's real padding is `0.875rem`. Neither term is visible to
              the suite: `measureHeight` is a pure function and its tests feed it the already-wrong
              `scrollHeight`, which is the same measurement boundary the first review's F1 sat on. Not a
              regression from the remediation — the expression is unchanged from the original implement pass —
              and MINOR both on its merits (2 px, fallback path only) and because
              `.specify/memory/constitution.md:125-128` caps a re-review's new observations at MINOR.
      owed:   Add the border term to the measured branch —
              `Math.max(input.scrollHeight + CONTROL_CHROME.borderPx, floorPx)` — and assert it in
              `textarea-sizing.test.ts` with a case where content, not the floor, decides (e.g.
              `scrollHeight: 274, lineHeightPx: 26, minRows: 6, maxRows: 14` → 276). Pass the real root font
              size from `resize()`, or drop `rootPx` and read the computed padding, so one measurement path
              does not mix a measured value with an assumed one.
      traces: FR-008, FR-014, FR-016, FR-038, SC-001, spec edge case "Value at exactly the ceiling"

- [ ] MINOR F2 — Two sites still render a field error outside the primitive's reserved `aria-live` region while
      the others pass it in, so the same job is still done two ways inside one feature. (First review's F4,
      unfixed.)
      where:  src/app/p/[projectSlug]/jobs/new/JobForm.tsx:180, src/app/p/[projectSlug]/generate/GenerateForm.tsx:194
      why:    `src/app/p/[projectSlug]/accounts/PostingInstructionsForm.tsx:61` and `VoiceEditor`'s call sites
              pass `error` into `TextareaField`, so the message lands in `<p id="…-error" aria-live="polite">`
              and is linked through `aria-describedby`. `JobForm` (`fieldErrors.template`) and `GenerateForm`
              (`fieldErrors.brief`) still render their own `<p className="text-xs text-danger">` after the
              component, leaving the primitive's error line rendering empty above it. The cost is a reserved
              blank 16 px line (`errorStyles`' `min-h-4`) between the counter and the real error, and an error
              that is still neither announced nor linked. Not a regression — both were unlinked before this
              entry — and correctly not tasked in Phase 6, which carried only the blocking set. Re-reported
              because it is still open and it is exactly the divergence this entry exists to remove.
      owed:   Pass `error={fieldErrors.template}` and `error={fieldErrors.brief}` (the latter through
              `GenerateForm`'s `TextArea` shell, which would need an `error` prop) and delete the two
              caller-owned paragraphs.
      traces: FR-002, FR-025, SC-006

- [ ] MINOR F3 — The one test named for `measureHeight`'s row-height fallback still exercises neither branch of
      it. (First review's F5, unfixed.)
      where:  src/components/ui/textarea-sizing.test.ts:89
      why:    "falls back to rowHeightRem × 16 when lineHeightPx is null, matching the composer's row height"
              makes two assertions and neither reaches `input.lineHeightPx ?? rowHeightRem * rootPx`
              (`src/components/ui/textarea-sizing.ts:94`). The first passes `scrollHeight: 0`, which returns at
              `src/components/ui/textarea-sizing.ts:89` before any row height is read. The second passes
              `maxRows: null` with `scrollHeight: 10000`, which is above any floor and below no ceiling, so the
              result is 10000 whatever the row height is — the assertion would still hold if `rowHeightRem`
              were ignored entirely. `rowHeightRem`'s effect on the floor is therefore unasserted, which is the
              half of FR-038 that matters for the composer and the same parameter the first review's F2 got
              wrong.
      owed:   Assert a case where the fallback decides the answer, e.g.
              `measureHeight({ scrollHeight: 50, lineHeightPx: null }, { minRows: 3, rowHeightRem: 1.625 })`
              giving `3 × 26 + 16 = 94`, and the same input with `lineHeightPx: 20` giving `76`.
      traces: FR-038

- NOTE F4 — `specs/034-prompt-text-fields/data-model.md:73` (row 2 of section 2) still says the composer's post
  text "Keeps `min-h-40 text-base leading-relaxed`". The remediation deliberately deleted `min-h-40` and
  changed `text-base` to `!text-base` (`src/app/p/[projectSlug]/compose/Composer.tsx:376`), which
  `docs/decisions.md:1390-1397` records under "Review remediation (F1–F3)". The code and the decision log
  agree; only the plan artifact is stale. This phase's write scope is `review.md` and `tasks.md`, so it is
  recorded rather than corrected.

- NOTE F5 — `!text-base` is the only `!important` Tailwind utility anywhere in `src/` (a grep over all `.tsx`
  returns one hit, `src/app/p/[projectSlug]/compose/Composer.tsx:376`). It works — the built stylesheet carries
  the `!important`, and `leading-relaxed` still wins the line-height through `--tw-leading` — and T034 offered
  it as one of two acceptable resolutions. Worth knowing that the convention-clean alternative (a size-free
  `controlStyles` variant) is still available if a second long-form field ever needs the same escape. Tailwind
  4's canonical form for this is also the trailing `text-base!` rather than the v3 leading `!`.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Prior blocking findings re-checked (old F1, F2, F3) | 3 | 3 fixed | 0 | 0 | 0 |
| Prior MINOR findings re-checked (old F4, F5) | 2 | 0 fixed | 2 still open | 0 | 0 |
| Obligations in the remediation's blast radius (FR-002, 003, 006, 007, 008, 009, 010, 011, 012, 013, 014, 016, 022, 025, 036, 038) | 16 | 15 | 1 | 0 | 0 |
| Adoption / classification / scope re-greps (FR-018, 019, 023, 024, 027; SC-004, 005, 009, 011) | 9 | 9 | 0 | 0 | 0 |
| Per-site bounds in `data-model.md` section 2 (all 16 rows) | 16 | 16 | 0 | 0 | 0 |
| Constitution re-review process rules (`:112-114`, `:125-128`) | 2 | 2 | 0 | 0 | 0 |

The one partial is **FR-008** ("grow to fit its content between the floor and the ceiling, without an internal
scrollbar in that range"), satisfied on the primary CSS path and 2 px short on the scripted fallback — F1
above. Carried over from the first review's sweep and deliberately not re-asserted here: FR-001, FR-004,
FR-005, FR-015, FR-017, FR-020, FR-021, FR-026, FR-028–FR-035, FR-037, FR-039, FR-040, SC-003, SC-006, SC-007,
SC-008.

Verified by running or grepping on the committed tree, not by reading alone:

- `DOCKET_SKIP_DB_SETUP=1 pnpm vitest run src/components/ui/textarea-sizing.test.ts
  src/components/ui/TextareaField.test.tsx src/app/p/[projectSlug]/voice/voice.test.tsx
  src/app/p/[projectSlug]/compose/Composer.test.ts tests/lint/ui-limit-literals.test.ts` — 73 passed, 8 failed,
  and **all 8 failures are `Docket configuration error: DATABASE_URL: required`**; zero assertion failures.
- `voice.test.tsx` alone — 17 tests, 9 passed and 8 failed; every failure is in the DB-backed `voice list` and
  `pages` groups, and the whole `voice editor` group passes, including both FR-041 assertions ("shows a linked
  hint under each voice field…", which expects `aria-describedby="<hintId> <errorId>"` at
  `src/app/p/[projectSlug]/voice/voice.test.tsx:161`, and "still shows a field error beside its hint", which
  expects `aria-describedby="x-hint x-error"` at `:170`).
- `DOCKET_SKIP_DB_SETUP=1 pnpm vitest run tests/lint/` — 11 files, 102 tests, all passed, so none of the repo's
  own structural lint rules objects to the remediation's docs or markup changes.
- The remediation pass's own run, read from its transcript (session `e052efd0`): `pnpm lint` → 0 errors,
  21 warnings, all pre-existing `_`-prefixed unused vars under `tests/`; `pnpm typecheck` → clean;
  `pnpm build` → clean through all five esbuild bundles; the two new test files → 24/24.
- F2's cascade claim, settled against the built stylesheet rather than reasoned about:
  `.\!text-base{font-size:var(--text-base)!important;line-height:var(--tw-leading,var(--text-base--line-height))!important}`,
  `.leading-relaxed{--tw-leading:var(--leading-relaxed);line-height:var(--leading-relaxed)}`,
  `--text-base:1rem`, `--leading-relaxed:1.625`. So the composer field is 16 px with a 26 px row, which is
  exactly `ROW_REM_COMPOSER`, making the inline floor 6 real rows and the inline ceiling 14 real rows — the
  numbers `data-model.md` section 2 row 2 asks for.
- F3's `aria-describedby` claim: `describedBy` is built from `[hint, counter, errorId]` only
  (`src/components/ui/TextareaField.tsx:68`) and `{beforeControl}` is rendered as a sibling at
  `src/components/ui/TextareaField.tsx:102`, so no chip label can enter the description. `beforeControl` is
  destructured out of the props, so it also cannot leak into the `...rest` spread onto the `<textarea>`.
- `box-sizing:border-box` is present in the built stylesheet (Tailwind preflight), which is what makes F1 above
  an arithmetic fact rather than a guess.
- SC-005: `grep -rn "<textarea" src --include=*.tsx` outside the primitive returns only the regex literal at
  `src/app/p/[projectSlug]/voice/voice.test.tsx:161`.
- SC-004 / FR-018 / FR-019: 17 `<TextareaField` elements across 12 source files (the 13 sites as the spec counts
  them — `GenerateForm`'s wrapper is 3 fields, `VoiceEditor`'s 5 call sites are 1 site) and 10 `mono` call sites
  (the 6 mono sites), unchanged by the remediation.
- No regression surface in the DB-backed suites the remediation could have touched:
  `tests/integration/jobs/ui.test.tsx` contains no assertion on the template field, its chip row, its hint id
  or its counter id (grepped for `template`, `chip`, `{{`, `Available fields`, `aria-describedby`), and
  `src/app/p/[projectSlug]/compose/Composer.test.ts`'s only `aria-describedby` assertions are on buttons and
  radios, not on the post-text field — and that file passes here.
- `tests/integration/accounts-ui.test.ts`'s posting-instructions assertions (`<textarea`, `12 / 2,000`,
  "How posts for this account are written", the slots-before-instructions order, the read-only no-textarea
  branch) are unaffected: the remediation did not touch `PostingInstructionsForm.tsx`.

## What I could not check

- **The CSS and scripted growth paths, by observation.** `field-sizing: content`, the floor, the ceiling turning
  scrolling back on, the shrink that the old F1 was raised for, the `Dialog` cases and the collapsed
  `<details>` are all browser behaviour that no `environment: "node"` test can see, and this phase has no
  browser. T032 is still honestly recorded as **NOT RUN** with its reason (the Chrome extension driving that
  environment has no `localhost` permission) and is still unchecked. So the old F1's fix is verified by reading
  the code and reasoning about `height: auto` on a `<textarea>`, **not by seeing a field shrink** — and this
  review's new F1 is a defect in exactly that same unobserved region, which is the second piece of evidence
  that the walk-through matters.
- **`pnpm test` in full, on the committed tree.** There is no `DATABASE_URL` and no reachable Postgres here, so
  the DB-backed tests cannot run. Every failure in what I did run is environmental with zero assertion
  failures, but `tests/integration/accounts-ui.test.ts` and `tests/integration/jobs/ui.test.tsx` — the only
  integration coverage of an adopted field — were read and grepped, not observed passing. The 5010-passed
  `pnpm test` recorded under T032 predates the remediation and does not cover it; CI on the PR is the first run
  that will.
- **Hydration.** Whether the server-rendered markup and the first client render agree with no mismatch warning
  needs a real page; `renderToStaticMarkup` cannot show it.
- **Visual outcomes.** The composer's post text actually looking like 16 px on a 26 px row, the chip row sitting
  on its own line again, and the accepted visual changes recorded in `docs/decisions.md` were read and computed
  from the built stylesheet, not seen.
- **The first review's full sweep, re-run.** By constitutional design
  (`.specify/memory/constitution.md:125-128`) this pass did not re-open the obligations listed as carried over
  under "Coverage". If a human wants those re-confirmed on the committed tree rather than on the working tree
  the first review read, that is a fresh exhaustive review, not this one.
