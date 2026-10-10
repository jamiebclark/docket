---

description: "Task list for Auto-growing, monospace prompt and instruction fields"
---

# Tasks: Auto-growing, monospace prompt and instruction fields

**Input**: Design documents from `/specs/034-prompt-text-fields/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/component.md](./contracts/component.md),
[contracts/ui.md](./contracts/ui.md), [quickstart.md](./quickstart.md)

**Tests**: Not explicitly requested as TDD, but the spec and plan require a sizing-helper test and a
primitive-markup test as part of building the primitive (FR-037–FR-040), so those are included as part of
Foundational rather than as an optional add-on.

**Organization**: Tasks are grouped by user story (US1 growth, US2 mono, US3 supporting copy), matching the
spec's priorities. `[US1][US2]` marks a task that lands both in the same file edit, which is how the plan's
adoption step is scoped (mono is one prop set alongside the floor/ceiling at the same site).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- File paths are exact, taken from [data-model.md](./data-model.md) §2 and [contracts/ui.md](./contracts/ui.md)

---

## Phase 1: Foundational (Blocking Prerequisites)

**Purpose**: The pure sizing helper and the shared primitive. No user story's adoption work can begin until
both exist and are tested — all thirteen sites consume the same two files.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T001 Create `src/components/ui/textarea-sizing.ts` — `ROW_REM_SM`, `ROW_REM_COMPOSER`,
  `CONTROL_CHROME`, `DEFAULT_MIN_ROWS`, `DEFAULT_MAX_ROWS`, `resolveBounds`, `sizingStyle`, `rowsToLength`,
  `measureHeight`, exactly per [contracts/component.md](./contracts/component.md) §1 (FR-016, FR-006, R1–R6)
- [X] T002 [P] Create `src/components/ui/textarea-sizing.test.ts` covering the invariant table in
  [contracts/component.md](./contracts/component.md) §1: default floor/ceiling, `rows === minRows`, content
  between floor and ceiling, one px past the ceiling, exactly at the ceiling, below the floor, `scrollHeight: 0`,
  `maxRows: null`, floor above ceiling, and the composer's `rowHeightRem` (FR-038) — depends on T001
- [X] T003 Create `src/components/ui/TextareaField.tsx` (`"use client"`) per
  [contracts/component.md](./contracts/component.md) §2: `Field`'s accessibility contract (label, hint, error,
  `aria-describedby`, `aria-invalid` with `Field`'s spread order per R8), `controlStyles` chrome, the counter
  slot at `${id}-count` (R7), `mono`, `hideLabel` (R9), `field-sizing-content` as the primary growth path with
  the `CSS.supports("field-sizing", "content")` feature test gating a scripted fallback (layout effect +
  `onInput` + one-shot `ResizeObserver`) per R3/R4 (FR-001–FR-017) — depends on T001
- [X] T004 [P] Create `src/components/ui/TextareaField.test.tsx` via `renderToStaticMarkup`, asserting the
  table in [quickstart.md](./quickstart.md) §2: label/`sr-only`, hint presence, the three `aria-describedby`
  values, the reserved `aria-live="polite"` error line, `aria-invalid` and a caller override winning, the
  counter paragraph and its id, `font-mono` present/absent, `rows`/`min-height`/`max-height`/
  `field-sizing-content` all present for a long `defaultValue` (FR-037, FR-039, FR-040), and pass-through
  attributes (FR-004) — depends on T003

**Checkpoint**: Run `pnpm vitest run src/components/ui/textarea-sizing.test.ts src/components/ui/TextareaField.test.tsx`
and `pnpm typecheck`. Once both pass, adoption (US1/US2) can begin.

---

## Phase 2: User Story 1 - Write a long prompt without scrolling inside the box (Priority: P1) 🎯 MVP

**Goal**: All thirteen sites render through `TextareaField`, each with its floor/ceiling from
[data-model.md](./data-model.md) §2, growing to content and stopping at a ceiling that keeps the submit control
reachable.

**Independent Test**: Open any of the thirteen fields with a short, a medium and a very long value; the
rendered height follows the content between floor and ceiling, the ceiling turns scrolling back on, and a
server-rendered saved value arrives already at its grown height (quickstart §6).

Six of these adoption tasks also turn on `mono` in the same edit (data-model §2), so they carry a `[US2]` tag
too — splitting the mono prop into a second pass over the same file would be pure churn with no independent
value.

### Implementation for User Story 1

- [X] T005 [P] [US1] Adopt `TextareaField` in `src/components/media/MediaPicker.tsx:41` — alt text (picker),
  `minRows={2}` `maxRows={8}`, proportional; grow the label `text-xs` → `labelStyles` (R9)
- [X] T006 [P] [US1] Adopt `TextareaField` in `src/app/p/[projectSlug]/media/MediaEditDialog.tsx:39` — alt
  text, `minRows={3}` `maxRows={10}`, proportional, inside a `Dialog` (FR-013)
- [X] T007 [P] [US1] Adopt `TextareaField` in `src/app/p/[projectSlug]/review/RejectDialog.tsx:45` — reason
  (optional), `minRows={3}` `maxRows={10}`, proportional, counter via `counter` slot, inside a `Dialog`
  (FR-013)
- [X] T008 [P] [US1] Adopt `TextareaField` in `src/app/p/[projectSlug]/voice/TryItPanel.tsx:102` — Brief,
  `minRows={3}` `maxRows={12}`, proportional per FR-019 and the spec's Assumptions, `required`
- [X] T009 [P] [US1][US2] Adopt `TextareaField` in `src/app/p/[projectSlug]/generate/SeriesPlanEditor.tsx:74`
  — Angle *N* description, `minRows={2}` `maxRows={10}`, `mono`
- [X] T010 [P] [US1][US2] Adopt `TextareaField` in
  `src/app/p/[projectSlug]/generate/result/[postId]/RegenerateDialog.tsx:42` — Extra instruction (optional),
  `minRows={3}` `maxRows={12}`, `mono`, counter via `counter` slot, inside a `Dialog` (FR-013), sized to its
  current value when the dialog first opens
- [X] T011 [P] [US1] Adopt `TextareaField` in
  `src/app/p/[projectSlug]/generate/result/[postId]/VariantEditor.tsx:110` — per-account variant text,
  `minRows={5}` `maxRows={20}`, proportional, `hideLabel` (R9), counter via `counter` slot
- [X] T012 [P] [US1][US2] Adopt `TextareaField` in
  `src/app/p/[projectSlug]/accounts/PostingInstructionsForm.tsx:54` — Posting instructions for *account*,
  `minRows={5}` `maxRows={20}`, `mono`, counter via `counter` slot with `counterClassName` for its existing
  left alignment, hint id moves `-help` → `-hint` (R8), `aria-invalid` passed through for `error || tooLong`
- [X] T013 [P] [US1][US2] Adopt `TextareaField` in `src/app/p/[projectSlug]/jobs/new/JobForm.tsx:169` —
  Instructions template, `minRows={5}` `maxRows={20}`, `mono`, `required`, hint, counter via `counter` slot,
  `aria-invalid` passed through, forwarded `ref` (so `insertField` keeps inserting at the caret)
- [X] T014 [US1] Adopt `TextareaField` in `src/app/p/[projectSlug]/compose/Composer.tsx:369` — Post text,
  `minRows={6}` `maxRows={14}`, `rowHeightRem={ROW_REM_COMPOSER}` (FR-022, R2), proportional, keeps
  `min-h-40 text-base leading-relaxed`, `aria-invalid` passed through for the over-limit state
- [X] T015 [US1] Adopt `TextareaField` in `src/app/p/[projectSlug]/compose/Composer.tsx:416` — Text for
  *account* (per-account override), `minRows={4}` `maxRows={20}`, proportional, `aria-invalid` passed through
  for the over-limit state (same file as T014; land after it)
- [X] T016 [US1][US2] Reduce `generate/GenerateForm.tsx:51-86`'s private `TextArea` to a counter shell per
  [contracts/component.md](./contracts/component.md) §3: unchanged `{ id, label, hint, value, max, rows,
  required, onChange }` signature, renders exactly one `TextareaField` with `minRows={props.rows}` `mono`
  `name={props.id}` and `counter={counterLabel(...)}` with its over-limit colour via `counterClassName`,
  restating no label/hint/error/chrome (FR-024). Covers Brief (`:71`, `required`, `maxRows={20}`), Source text
  (`maxRows={20}`, inside the collapsed `<details>`, FR-013) and Instructions for this post (`maxRows={20}`)
- [X] T017 [US1][US2] Delete `voice/VoiceEditor.tsx:44-81`'s private `box`/`Area` and move its five call sites
  (Voice and tone, Audience, Topics and pillars, Avoid, Example *N*) onto `TextareaField` directly, each
  `minRows={3}` `maxRows={20}` `mono`, `readOnly` preserved for an editor without manage rights, `maxLength`
  stays `FIELD_MAX × 2` (FR-024, R14#1)
- [X] T018 [US1] Update `src/app/p/[projectSlug]/voice/voice.test.tsx` in the same commit as T017: the
  line-160 hint assertion moves from `aria-describedby="<hintId>"` to `aria-describedby="<hintId> <errorId>"`
  (FR-041), and the field-error test's `Area` import becomes a `TextareaField` import while its asserted value
  `"x-hint x-error"` stays byte-identical — depends on T017
- [X] T019 [US1] Run the SC-005 grep check — `grep -rn "<textarea" src/ --include=*.tsx | grep -v
  src/components/ui/TextareaField.tsx` — confirming no output (no hand-rolled `<textarea>` left outside the
  primitive and outside test files); fix any site the grep still finds — depends on T005–T018

**Checkpoint**: `pnpm vitest run "src/app/p/[projectSlug]/voice/voice.test.tsx" src/app/p/\[projectSlug\]/ui-conventions.test.ts tests/integration/accounts-ui.test.ts`
all pass (quickstart §3). User Story 1 is independently testable per quickstart §6 (desktop walk-through,
390 px, no-JavaScript pass).

---

## Phase 3: User Story 2 - Read markdown in a prompt as markdown (Priority: P2)

**Goal**: Exactly the 6 fields in FR-018 render monospace and exactly the 7 in FR-019 stay proportional, with
every counter beside a monospace field unchanged.

**Independent Test**: Render each of the thirteen fields and confirm the monospace face is present on exactly
the classified set and absent on the rest, and every character counter beside a monospace field still reads
correctly and stays aligned (covered by T004's `font-mono` assertion plus this phase's verification tasks).

Mono itself was already turned on in T009, T010, T012, T013, T016 and T017 above (Phase 2), because it is one
prop set in the same edit as the floor/ceiling — a second pass over the same six files would touch nothing new.
What remains here is the classification check and the counter-regression check the spec calls out by name.

### Implementation for User Story 2

- [X] T020 [US2] Verify FR-020: check each of the 13 fields' mono/proportional choice against its rendered
  label and purpose; confirm the one contradiction (`Example N` in `VoiceEditor` — mono per FR-018, though an
  example post is post copy per FR-019's rule, R12) is applied as specified, not silently reclassified, and
  note it for T029's `docs/decisions.md` entry — depends on T009, T010, T012, T013, T016, T017
- [X] T021 [US2] Verify FR-021/SC-008: all 8 counters (6 beside a mono field from T009, T010, T012, T013,
  T016; 2 beside a proportional field from T007, T011) read the same count and limit, and sit in the same
  position, as before adoption — depends on T009, T010, T011, T012, T013, T016, T007

**Checkpoint**: SC-004 (6 mono / 7 proportional) and SC-008 (8/8 counters unchanged) hold.

---

## Phase 4: User Story 3 - Forms that explain themselves without shouting (Priority: P3)

**Goal**: The seven explanatory paragraphs in [data-model.md](./data-model.md) §4 drop to `text-xs
text-muted-foreground`; nothing a reader types, and no label or control text, changes size; nothing goes below
12 px.

**Independent Test**: Screen by screen, confirm each explanatory paragraph renders at caption size in the
muted colour while every label, control and typed value stays at body size, with the voice screen as the
reference (FR-031).

### Implementation for User Story 3

- [X] T022 [US3] Drop to `text-xs text-muted-foreground` the three voice-screen paragraphs per
  [data-model.md](./data-model.md) §4: `voice/VoiceEditor.tsx:187` ("Version *N* · Default profile"),
  `:218` ("No examples."), `:247` ("Per-platform guidance now lives on each account. Edit it on Accounts") —
  the reference screen, done first per FR-031
- [X] T023 [P] [US3] Drop to `text-xs text-muted-foreground`
  `src/app/p/[projectSlug]/voice/[profileId]/history/page.tsx:80` ("Guidance is now set per account. Go to
  Accounts")
- [X] T024 [P] [US3] Drop to `text-xs text-muted-foreground`
  `src/app/p/[projectSlug]/compose/Composer.tsx:444` ("Choose an account to see what it will receive.")
- [X] T025 [P] [US3] Drop to `text-xs text-muted-foreground`
  `src/app/p/[projectSlug]/generate/SeriesPlanEditor.tsx:57` ("Edit, reorder, remove or add angles. One post is
  written for each, in this order.")
- [X] T026 [P] [US3] Drop to `text-xs text-muted-foreground` `src/components/media/MediaPicker.tsx:98` ("No
  images attached.")

**Checkpoint**: SC-007 holds (nothing below 12 px, nothing in a control shrinks) on every screen this entry
touches, voice screen matched against first.

---

## Phase 5: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, the final full-suite pass, and the one human-owned browser verification the
constitution's principle II requires to be reported honestly rather than assumed.

- [X] T027 [P] Update `docs/design-system.md` §7: add a `TextareaField` row immediately after the `Field`/
  `Select` row and before the `controlStyles` row, naming `label`, `hint`, `error`, `counter`, `mono`,
  `minRows`, `maxRows`, `hideLabel` and the floor/ceiling behaviour (FR-033); update the `controlStyles` row's
  "For raw `<input>`, `<textarea>`, checkboxes" to drop `<textarea>` and point callers at `TextareaField`
  instead (FR-035)
- [X] T028 [P] Update `docs/design-system.md` §4: add a line under the type table recording that the monospace
  face applies to a text field holding a prompt, an instruction or a source document, not to post copy or
  short prose (FR-034)
- [X] T029 Append a `## 034 — …` entry to `docs/decisions.md` recording: the `Example N` classification
  contradiction (R12, confirmed in T020); the `-help` → `-hint` id change and the `aria-describedby` error-id
  change (R8/FR-041, from T012/T018); the three-clause supporting-copy rule (R13); and the two accepted visual
  changes — the voice fields' chrome change and the six fields gaining a describedby/error line (R14) (FR-036)
  — depends on T012, T017, T018, T020
- [X] T030 Add `TextareaField` to `.claude/skills/docket-ui/SKILL.md`'s reusable-components list — "multi-line
  text uses `TextareaField`, never a raw `<textarea>`" — or, if the sandbox refuses the write (as in entries
  028, 029 and 033), record it as an **Open item (needs a human)** in `docs/decisions.md` instead (FR-036)
- [X] T031 Run the final pass once: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`. Fix any failure
  in a screen this entry did not set out to change by updating the assertion to the new markup — never
  deleting or skipping it (FR-042, SC-010). Confirm via `git diff --name-only origin/main...HEAD` that no file
  under `src/server/`, no `actions.ts`, no `src/lib/validation/`, no migration, no `package.json`, no
  `src/app/globals.css` and nothing under `accounts/SlotEditor.tsx` appears in the diff (SC-009) — depends on
  T001–T030

---

## Dependencies & Execution Order

### Phase Dependencies

- **Foundational (Phase 1)**: No dependencies — can start immediately. **Blocks every other phase**: the
  primitive and the helper are what every site adopts.
- **User Story 1 (Phase 2)**: Depends on Phase 1. The MVP — delivers value (readable, growing fields) on its
  own even with no mono and no copy pass.
- **User Story 2 (Phase 3)**: Mono itself lands inside Phase 2's per-file tasks (T009, T010, T012, T013, T016,
  T017); Phase 3's own tasks (T020, T021) depend on those specific tasks, not on all of Phase 2.
- **User Story 3 (Phase 4)**: Independent of Phases 2 and 3 — touches paragraphs in files already visited, but
  the size change itself does not depend on growth or mono landing first. Can run in parallel with Phase 2/3
  once Phase 1 is done, though T022 (voice screen) is naturally done once `VoiceEditor.tsx` is stable (after
  T017) to avoid a merge conflict in the same file.
- **Polish (Phase 5)**: Depends on all of Phases 2–4 being complete; T031 (final pass) depends on everything;
  T032 (browser walk-through) depends on the stories whose behaviour it checks.

### Within User Story 1

- T005–T013 are each a different file and have no dependency on one another beyond Phase 1 — fully parallel.
- T014 and T015 share `Composer.tsx` — T015 after T014.
- T016 (`GenerateForm`) and T017 (`VoiceEditor`) are each a self-contained file.
- T018 depends on T017 (same commit, per FR-041).
- T019 (the grep check) depends on every adoption task landing.

### Parallel Opportunities

- T002 and T004 (tests) can be written alongside T001/T003 being finished by a different contributor, though
  each strictly needs its subject file to assert against.
- T005–T013 (9 files, no shared file, no shared dependency beyond Phase 1) — the largest parallel batch.
- T023–T026 (4 files, Phase 4) are fully parallel once Phase 1 is done.
- T027 and T028 (both `docs/design-system.md`, different sections) can be done together then committed as one
  docs change to avoid two agents editing the same file at once in practice, even though they are logically
  independent.

---

## Parallel Example: User Story 1's first batch

```bash
Task: "Adopt TextareaField in src/components/media/MediaPicker.tsx:41"
Task: "Adopt TextareaField in src/app/p/[projectSlug]/media/MediaEditDialog.tsx:39"
Task: "Adopt TextareaField in src/app/p/[projectSlug]/review/RejectDialog.tsx:45"
Task: "Adopt TextareaField in src/app/p/[projectSlug]/voice/TryItPanel.tsx:102"
Task: "Adopt TextareaField in src/app/p/[projectSlug]/generate/SeriesPlanEditor.tsx:74"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Foundational (the primitive and its tests)
2. Complete Phase 2: User Story 1 — all thirteen sites grow, no internal scrolling below the ceiling
3. **STOP and VALIDATE**: `pnpm vitest run` the touched test files plus the quickstart §6 walk-through's
   growth-only rows
4. This alone resolves the user's primary complaint even before mono or the copy pass land

### Incremental Delivery

1. Foundational → the primitive exists and is tested
2. User Story 1 → every field grows; demo-able (mono is already riding along on six of the files, since it is
   one prop set in the same edit — see Phase 2 note)
3. User Story 2's remaining verification (T020, T021) → classification and counters confirmed
4. User Story 3 → the copy pass, voice screen first
5. Polish → docs, the final pass, the browser walk-through

### Commits

Conventional Commits, explicit paths only, per the constitution: `feat(ui):` for T001–T004, `refactor(ui):` for
each adoption task (T005–T019) — `style(ui):` acceptable for T017 if preferred — `docs:` for T027–T030, and no
commit for verification-only tasks (T020, T021, T031, T032) that touch no file. Every commit message ends with
the `Co-Authored-By` trailer the constitution requires.
</content>

---

## Phase 6: Review remediation

**Purpose**: The blocking findings from [review.md](./review.md). F1 and F2 are code defects in the growth
path; F3 is a structural change that contradicts [contracts/ui.md](./contracts/ui.md). Each task carries its
finding id and location so it can be traced back without re-reading the review.

- [X] T033 Release the assigned height before measuring in `resize()` so the scripted fallback can shrink: set
  `el.style.height = "auto"` (or `""`) immediately before reading `el.scrollHeight`, then apply the clamp.
  Add a node-assertable guard for the ordering (extract the measure-then-assign step, or pin the precondition
  in [contracts/component.md](./contracts/component.md) §1) and add the shrink row to the quickstart §6
  walk-through — review F1 (MAJOR), src/components/ui/TextareaField.tsx:15
- [X] T034 Resolve the composer post text size and its row height: either make the field actually render at
  `text-base` (so `ROW_REM_COMPOSER` is correct and FR-022 holds) or drop `rowHeightRem` so the floor and
  ceiling are computed from the 14 px row the field really has. `controlStyles`' `text-sm` currently wins over
  the caller's `text-base` in the cascade, making the floor 172 px and the ceiling ~16 rows instead of 14.
  Record the choice in `docs/decisions.md` per FR-036 and delete the now-dead `min-h-40` (review F6)
  — review F2 (MAJOR), src/app/p/[projectSlug]/compose/Composer.tsx:372
- [X] T035 Restore `JobForm`'s `{{field}}` chip row as its own element between the hint and the control,
  outside the hint paragraph so the chip labels leave the textarea's `aria-describedby` description. This
  needs a seam in the primitive (e.g. a `beforeControl` slot rendered after the hint and before the
  `<textarea>`, excluded from `aria-describedby`); if the inline form is kept deliberately instead, record it
  in `docs/decisions.md` (FR-036) and update [contracts/ui.md](./contracts/ui.md) so contract and code agree
  — review F3 (MAJOR), src/app/p/[projectSlug]/jobs/new/JobForm.tsx:162

**Checkpoint**: `pnpm vitest run src/components/ui/textarea-sizing.test.ts src/components/ui/TextareaField.test.tsx`
plus `pnpm lint && pnpm typecheck && pnpm test && pnpm build`, then re-review. The two MINOR findings (F4, F5)
and the three NOTEs (F6, F7, F8) do not block and are not tasks here.

---

## Phase 7: Human-owned verification (runs last; cannot be completed headlessly)

**Purpose**: Kept after Phase 6 deliberately. The `implement` loop always picks the earliest task group with
unchecked work, so while this task sat in Phase 5 it starved the Phase 6 review remediation of every pass. It
is unreachable by any headless phase and is parked here so it blocks nothing.

- [ ] T032 Human-owned verification: run the browser walk-through in [quickstart.md](./quickstart.md) §6 —
  needs a running `pnpm dev` server and a signed-in browser session, plus one pass with JavaScript disabled.
  Survey every row in that table in one pass (growth, ceiling/scroll, shrink, saved-value-at-load, the
  collapsed `<details>`, the `Dialog` cases, monospace vs. proportional, read-only full height, the voice
  screen's caption-size copy, keyboard/focus, 390 px width, no-JS) and report each as pass, fail, or **not
  run** with the reason (e.g. "no browser available in this environment") — never report a pass that was not
  seen. If no browser is available in this execution environment, record the whole task as not run, not as
  done — depends on T019, T021, T022–T026

  **NOT RUN** (2026-10-10, recorded by the pipeline front end, deliberately left unchecked). Every row of
  quickstart.md §6 is **not run**; none is reported as pass. Reason: the app was brought up successfully on
  `http://localhost:3000` (see below), but the Chrome extension driving this environment has no site
  permission for `localhost`, so every navigation reverted to `chrome://newtab/` and no page could be read or
  screenshotted. Granting the extension access to `localhost` is a human action; it cannot be done from here.
  Two incidental findings from the attempt, neither caused by this feature:
  - `pnpm dev` is broken on Windows, independently of this branch: `scripts/next-with-env.mjs` hands a `c:\…`
    absolute path to the ESM loader instead of a `file://` URL, giving `ERR_UNSUPPORTED_ESM_URL_SCHEME`.
    `npx next dev` works, since Next loads `.env` itself. `scripts/` is untouched by this branch.
  - There is no seed script, so §6 also needs a user, project, connected account and voice profile created by
    hand before the walk-through can start.
  What *was* verified without a browser, on this branch: `pnpm lint` (0 errors), `pnpm typecheck` (clean),
  `pnpm test` (5010 passed, 55 skipped, 0 failed across 533 files) and `pnpm build` (clean) — quickstart §1–§5.
  The CSS growth path of FR-008/FR-010/FR-013/FR-015 remains unproven by observation and is the specific risk
  this leaves open.
