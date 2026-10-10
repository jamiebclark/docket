# Review: Auto-growing, monospace prompt and instruction fields

Reviewed 21 implementation files (17 modified, 4 new) **in the working tree**, plus the 2 committed spec
commits (`127f61e`, `37e4678`) against `2c0b8e6...HEAD`. The implementation is **not committed**: the diff
`2c0b8e6...HEAD` contains only `specs/034-prompt-text-fields/*`, so this review read the present state of the
working tree (`git status` plus `git diff` on the unstaged changes plus the four untracked source files), not a
branch diff. Those are different evidence and the difference is recorded here deliberately.

Read in full: `src/components/ui/TextareaField.tsx`, `src/components/ui/textarea-sizing.ts`,
`src/components/ui/TextareaField.test.tsx`, `src/components/ui/textarea-sizing.test.ts`,
`src/components/ui/controls.ts`, `src/components/ui/Field.tsx`, and the complete unstaged diff of all 17
modified files, with surrounding context read in full for `jobs/new/JobForm.tsx`,
`accounts/PostingInstructionsForm.tsx`, `voice/VoiceEditor.tsx`, `compose/Composer.tsx` and
`generate/GenerateForm.tsx`. Also read: this feature's `spec.md`, `plan.md`, `tasks.md`, `data-model.md`,
`research.md` and `contracts/component.md`, `contracts/ui.md`; `.specify/memory/constitution.md`;
`docs/design-system.md` sections 4 and 7; and the `## 034` entry in `docs/decisions.md`.

Sampled: `tests/integration/accounts-ui.test.ts` (the posting-instructions assertions at `:228-305` only),
`node_modules/tailwindcss/theme.css` and `node_modules/tailwindcss/dist/lib.js` (the `field-sizing` utilities
and the type scale), and the built stylesheet under `.next/static/chunks/` (the `field-sizing` and `text-*`
output).

Not reviewed: the rest of the repository, which this entry does not touch; and the DB-backed integration suite,
which this environment cannot run (no `DATABASE_URL`) — see "What I could not check".

## Verdict

The feature is built, and built as designed: one primitive, one pure sizing module, all thirteen sites adopted,
both private wrappers gone, exactly 6 monospace sites and 7 proportional ones, seven paragraphs moved to the
caption scale, and the documentation and decisions entries complete. `pnpm lint` (0 errors), `pnpm typecheck`
and `pnpm build` pass on this tree, and the DB-less part of the suite shows 2386 passing with **zero assertion
failures** — including both `voice.test.tsx` assertions FR-041 required to be updated. The grep checks for
SC-005 (no hand-rolled `<textarea>`) and SC-009 (no server action, schema, service, migration, `package.json`
or `globals.css` in the change set) are both clean. Nothing here corrupts data, leaks a secret or moves a
server boundary.

Three things block the merge, and all three sit at a seam between passes rather than inside one file. The
scripted growth fallback cannot shrink — `resize()` measures `scrollHeight` while the height it assigned last
time is still on the element, so on any browser without `field-sizing: content` a field that has grown stays
grown, which is the spec's "Shrinking" edge case verbatim; the pure helper handles shrink correctly, so no test
in the suite can see it. The composer passes `rowHeightRem={ROW_REM_COMPOSER}` (1.625rem, a 16 px row) to a
field that actually renders at 14 px, because `controlStyles`' `text-sm` beats the caller's `text-base` in the
cascade — so FR-022's "the long-form composer size section 4 prescribes" is not met, and the field's floor and
ceiling come out about 14% taller than data-model section 2 specifies. And `JobForm`'s `{{field}}` chip row was
folded inside the hint paragraph, which `contracts/ui.md` names under *what must not change* and which makes
every chip label part of the textarea's accessible description. None is hard to fix; all three want a code
change, which is why they are tasks and not notes.

One process point that is not a finding but must not be lost: **the entire implementation is uncommitted**, and
`specs/034-prompt-text-fields/tasks.md` is untracked. The constitution asks for a commit after each task
(`.specify/memory/constitution.md:84-92`) and the plan's own commit plan lists the type per step. Nothing can be
merged, opened as a PR, or reviewed as a diff until that happens.

## Findings

- [ ] MAJOR F1 — The scripted growth fallback can never shrink a field, because it measures `scrollHeight`
      without first releasing the height it previously assigned.
      where:  src/components/ui/TextareaField.tsx:15, src/components/ui/TextareaField.tsx:105
      why:    `resize()` reads `el.scrollHeight` while `el.style.height` still holds the value written by the
              previous call (line 17). `scrollHeight` is the scrolling-area height, floored at the element's
              own padding-box height — so once the field has grown to, say, 400 px, deleting text leaves
              `scrollHeight` reporting 400 px, `measureHeight` returns 400 px, and the field is pinned at its
              tallest for the rest of the session. Concretely: in any browser where
              `CSS.supports("field-sizing","content")` is false, type 30 lines into the voice editor's "Voice
              and tone", select all, delete — the box stays at its 20-row ceiling around an empty value, and
              neither typing further nor a re-render recovers it. This is FR-010 and the spec's "Shrinking"
              edge case word for word ("Deleting text must shrink the field back toward the floor, not leave it
              stuck at its tallest"), and research R4 names `onInput` as the trigger that covers "growth and
              shrink". The defect is invisible to the suite by construction: `measureHeight` is handed a
              `scrollHeight` and clamps it correctly (`src/components/ui/textarea-sizing.test.ts:60` proves the
              floor), so the pure-helper split of FR-016/FR-038 stops exactly at this measurement boundary.
      owed:   Release the height before measuring — set `el.style.height = "auto"` (or `""`) immediately before
              reading `el.scrollHeight` in `resize()`, then apply the clamp. Add a guard that a node test can
              hold: extract the measure-then-assign step so the "released height" precondition is assertable,
              or pin the ordering in `contracts/component.md`, and add the shrink row to the quickstart section
              6 walk-through as a must-see.
      traces: FR-010, FR-012, FR-038, spec edge case "Shrinking", research R4

- [ ] MAJOR F2 — The composer's post text does not render at the size FR-022 requires, and the `rowHeightRem`
      it passes assumes the size it does not have, so its floor and ceiling are about 14% too tall.
      where:  src/app/p/[projectSlug]/compose/Composer.tsx:372, src/app/p/[projectSlug]/compose/Composer.tsx:376
      why:    `TextareaField` composes `controlStyles` + `field-sizing-content overflow-y-auto` + `className`
              (`src/components/ui/TextareaField.tsx:101`), and `controlStyles` contains `text-sm`
              (`src/components/ui/controls.ts:5`). The caller appends `text-base`. Both are plain class
              selectors of equal specificity, so source order in the generated stylesheet decides, and Tailwind
              emits the `text-*` utilities alphabetically: in the built CSS `.text-base` precedes `.text-sm`, so
              **`text-sm` wins** and the field is 14 px, not the 16 px `docs/design-system.md:116` prescribes for
              "Long-form / composer text". FR-022 says the field "MUST keep the long-form composer size
              `docs/design-system.md` section 4 prescribes"; it does not. (The cascade conflict predates this
              entry — the old markup was the same `controlStyles` + `text-base` composition — but FR-022 is this
              entry's requirement, and this entry is what made the size load-bearing.) The new consequence is
              this entry's alone: `leading-relaxed` is a unitless 1.625, so one row is 1.625 x 14 px = 22.75 px,
              not the 1.625rem = 26 px that `ROW_REM_COMPOSER` assumes. The inline floor is therefore
              `calc(9.75rem + 0.875rem + 2px)` = 172 px where 6 real rows need 152 px, and the ceiling is
              `calc(22.75rem + 0.875rem + 2px)` = 380 px, which is about 16 rows of content rather than the
              `maxRows={14}` data-model section 2 specifies. SC-002 still holds (380 px on a 900 px viewport),
              so this misses the spec's numbers rather than its outcome.
      owed:   Pick one and make it true: either make the field actually render at `text-base` (for example
              `!text-base`, or a size-free `controlStyles` variant), after which `ROW_REM_COMPOSER` is correct
              and FR-022 is met; or drop `rowHeightRem` so the bounds are computed from the 14 px row the field
              really has. Either way the choice is a judgement call FR-036 requires in `docs/decisions.md`.
      traces: FR-022, FR-006, data-model section 2 row 2, research R2

- [ ] MAJOR F3 — `JobForm`'s `{{field}}` chip row was moved inside the hint paragraph, which `contracts/ui.md`
      names as must-not-change and which appends every chip label to the field's accessible description.
      where:  src/app/p/[projectSlug]/jobs/new/JobForm.tsx:162
      why:    The chips were a block-level `<ul className="flex flex-wrap gap-1" aria-label="Available fields">`
              of `<li><button>` sitting between the hint and the control. They are now
              `<span role="list" aria-label="Available fields" className="inline-flex flex-wrap gap-1">` with
              `<span role="listitem">` children, nested inside the `hint` node — that is, inside
              `<p id="…-template-hint">`, which is a target of the textarea's `aria-describedby`
              (`src/components/ui/TextareaField.tsx:58`). Two consequences: the field's computed description
              becomes "Written once, used for every item. Available fields: {{…}} {{…}} …" with every chip
              label read out on focus, instead of the one-sentence hint; and the chips now flow inline after
              the colon instead of on their own row. `contracts/ui.md`'s "Batch jobs -> new" row lists "The
              field-chip row" under *What must not change*, and its keyboard table states the markup order is
              "label, hint, control, counter, error". No task asked for the restructure, no test covers it
              (nothing in `src/` or `tests/` references `Available fields` or `insertField` outside this file),
              and it is not among the four judgement calls recorded in `docs/decisions.md`. The likely cause is
              real and worth naming: the primitive renders label -> hint -> control with no slot between the
              hint and the control, so a caller cannot keep a block between them.
      owed:   Restore the chip row as its own element between the hint and the control. That needs a seam in the
              primitive — for example a `beforeControl` slot rendered after the hint and before the `<textarea>`
              and deliberately kept out of `aria-describedby`. If the inline form is kept instead, record it in
              `docs/decisions.md` per FR-036 and update `contracts/ui.md` so the contract and the code agree.
              `insertField`'s forwarded ref already works either way
              (`src/app/p/[projectSlug]/jobs/new/JobForm.tsx:68`, `:153`).
      traces: FR-025, FR-036, contracts/ui.md "Batch jobs -> new" and "Keyboard and accessibility"

- [ ] MINOR F4 — Two sites render a field error outside the primitive's reserved `aria-live` region while three
      pass it in, so the same job is done two ways inside one feature.
      where:  src/app/p/[projectSlug]/jobs/new/JobForm.tsx:182, src/app/p/[projectSlug]/generate/GenerateForm.tsx:194
      why:    `src/app/p/[projectSlug]/accounts/PostingInstructionsForm.tsx:58` and the five `VoiceEditor` call
              sites pass `error` into `TextareaField`, so the message lands in
              `<p id="…-error" aria-live="polite">` and is linked through `aria-describedby`. `JobForm`
              (`fieldErrors.template`) and `GenerateForm` (`fieldErrors.brief`) still render their own
              `<p className="text-xs text-danger">` after the component, leaving the primitive's error line
              rendering empty above it. The user-visible cost is a reserved blank 16 px line (`errorStyles`'
              `min-h-4`) between the counter and the real error, and an error that is still neither announced
              nor linked. Not a regression — both were unlinked before — which is why this is MINOR rather than
              blocking; it is recorded because it is exactly the divergence this entry exists to remove, and
              the next pass over these files should converge them.
      owed:   Pass `error={fieldErrors.template}` and `error={fieldErrors.brief}` (the latter through
              `GenerateForm`'s `TextArea` shell, which would need an `error` prop) and delete the caller-owned
              paragraphs.
      traces: FR-002, FR-025, SC-006

- [ ] MINOR F5 — The one test named for `measureHeight`'s row-height fallback exercises neither branch of it.
      where:  src/components/ui/textarea-sizing.test.ts:89
      why:    "falls back to rowHeightRem x 16 when lineHeightPx is null, matching the composer's row height"
              makes two assertions, and neither reaches the `input.lineHeightPx ?? rowHeightRem * rootPx` line
              (`src/components/ui/textarea-sizing.ts:98`). The first passes `scrollHeight: 0`, which returns at
              `src/components/ui/textarea-sizing.ts:88` before any row height is read. The second passes
              `maxRows: null` with `scrollHeight: 10000`, which is above any floor and below no ceiling, so the
              result is 10000 whatever the row height is — the assertion would hold if `rowHeightRem` were
              ignored entirely. `rowHeightRem`'s effect on `measureHeight`'s floor is therefore unasserted,
              which is the half of FR-038's "the composer's `rowHeightRem`" that matters, and it is the same
              parameter F2 gets wrong.
      owed:   Assert a case where the fallback decides the answer, for example
              `measureHeight({ scrollHeight: 50, lineHeightPx: null }, { minRows: 3, rowHeightRem: 1.625 })`
              giving `3 * 26 + 16 = 94`, and the same input with `lineHeightPx: 20` giving `76`.
      traces: FR-038

- NOTE F6 — `min-h-40` on the composer's post text (`src/app/p/[projectSlug]/compose/Composer.tsx:376`) is now
  dead: the primitive's inline `min-height` of 172 px always exceeds it, and inline styles beat classes.
  Harmless today; worth deleting alongside F2 so the floor has one source.

- NOTE F7 — `Measurement.atCeiling` (`src/components/ui/textarea-sizing.ts:77`) is never read by
  `TextareaField`; only the helper's own test consumes it. That is what `contracts/component.md` says it is for,
  so it is not a defect — but it does mean the ceiling is asserted only in the helper and never in the
  component, which is a gap F1's walk-through row should cover.

- NOTE F8 — `PostingInstructionsForm`'s `HELP` paragraph moved from *below* the textarea to *above* it, because
  `Field`'s contract (FR-002) puts the hint between the label and the control
  (`src/app/p/[projectSlug]/accounts/PostingInstructionsForm.tsx:55`). This is forced and correct, and it also
  shifts the counter up by one paragraph. The `## 034` entry in `docs/decisions.md` records the `-help` to
  `-hint` **id** change but not this **position** change, which is the part a reader of that screen actually
  sees. One sentence in that entry would close it.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-042) | 42 | 37 | 5 | 0 | 0 |
| Success criteria (SC-001–SC-011) | 11 | 10 | 1 | 0 | 0 |
| Constitution principles (I–VII plus engineering/workflow gates) | 11 | 10 | 1 | 0 | 0 |
| Spec edge cases | 12 | 11 | 1 | 0 | 0 |

Partial, named: **FR-010** and **FR-038** (F1); **FR-022** (F2); **FR-025** and **FR-036** (F3, F8).
**SC-010** — `pnpm lint`, `pnpm typecheck` and `pnpm build` were re-run here and pass; `pnpm test` cannot run in
this environment, so its DB-backed part is carried over from T031's report rather than observed. **Workflow:
commits** — the implementation is uncommitted (see Verdict). **Edge case "Shrinking"** — F1.

Verified by running or grepping, not by reading alone:

- `pnpm lint` — 0 errors, 21 warnings, all pre-existing `_`-prefixed unused vars under `tests/`.
- `pnpm typecheck` — clean. `pnpm build` — clean, including the five esbuild bundles.
- `DOCKET_SKIP_DB_SETUP=1 pnpm vitest run src/` — 2386 passed, 3 skipped, 36 failed; every failure is
  `Docket configuration error: DATABASE_URL: required` and **0** are assertion failures.
- FR-041 specifically: in `src/app/p/[projectSlug]/voice/voice.test.tsx`, both "shows a linked hint under each
  voice field, in edit and read-only modes" and "still shows a field error beside its hint" pass.
- SC-005: `grep -rn "<textarea" src/ --include=*.tsx` outside the primitive returns only the regex literal at
  `src/app/p/[projectSlug]/voice/voice.test.tsx:161`.
- SC-009: no changed path matches `src/server/`, `actions.ts`, `src/lib/validation/`, `migrations`,
  `package.json`, `globals.css` or `SlotEditor`.
- SC-004: 17 `<TextareaField` elements across 12 files, which is the 13 sites the spec counts (GenerateForm's
  wrapper covers 3 fields; VoiceEditor's 5 call sites are 1 site). 6 mono sites and 7 proportional, checked
  field for field against FR-018 and FR-019.
- SC-011: no `Area`, and no private `TextArea` label, hint, error or chrome, remains; grep finds no stale `Area`
  importer anywhere in `src/` or `tests/`.
- Tailwind 4.3.3 really does emit `field-sizing-content` as `field-sizing: content`
  (`node_modules/tailwindcss/dist/lib.js`), and the built stylesheet contains `field-sizing:content`, so the
  primary growth path is live and not a silent no-op.
- Row heights: `--text-sm--line-height: calc(1.25 / 0.875)` gives 1.25rem and `--leading-relaxed: 1.625`
  (`node_modules/tailwindcss/theme.css:350`, `:394`). `ROW_REM_SM` is right; `ROW_REM_COMPOSER` is right only
  for a 16 px field, which is F2.
- `CONTROL_CHROME` matches `controlStyles`: `py-[0.4375rem]` doubled is 0.875rem, and the 1 px border doubled is
  2px.
- The eight counters read character for character as before, including `PostingInstructionsForm`'s
  `counterClassName` keeping its left alignment and over-limit colour, and `VariantEditor`'s fragment counter
  staying truthy so its paragraph still always renders.
- `tests/integration/accounts-ui.test.ts:233-240` and `:302` still hold by reading: `<textarea`, `12 / 2,000`,
  "How posts for this account are written", `Save`, the slots-before-instructions order, and the editor's
  no-textarea read-only branch.

## What I could not check

- **The CSS growth path, by observation.** `field-sizing: content`, the floor, the ceiling turning scrolling
  back on, shrink, the `Dialog` cases and the collapsed `<details>` are all browser behaviour that no
  `environment: "node"` test can see. T032 is honestly recorded as **NOT RUN** with its reason (the Chrome
  extension driving that environment has no `localhost` permission), and this phase has no browser either. So
  FR-008, FR-013, FR-015, SC-001 and SC-003 are satisfied **by construction and by reading**, never by seeing.
  F1 is a defect in exactly that unobserved region, which is evidence that the walk-through matters.
- **`pnpm test` in full.** This environment has no `DATABASE_URL` and no reachable Postgres, so 36 DB-backed
  tests cannot run. I confirmed every failure is environmental, with zero assertion failures, but I did not
  observe `tests/integration/accounts-ui.test.ts` passing — and that file is the only integration coverage of
  an adopted field.
- **Hydration.** Whether the server-rendered markup and the first client render agree, with no mismatch warning,
  needs a real page; `renderToStaticMarkup` cannot show it.
- **Visual outcomes.** The accepted visual changes recorded in `docs/decisions.md` (the voice fields' new
  chrome, the reserved error line adding roughly 16 px under six fields, the caption-size paragraphs, and F3's
  inline chip row) were read, not seen. SC-007's "nothing below 12 px" is verified from class names, not from
  rendered type.
- **`pnpm db:check`** was correctly not run, since nothing schema-shaped changed, and this phase did not run it
  either.
