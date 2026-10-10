# Phase 0 research: Auto-growing, monospace prompt and instruction fields

**Feature**: `034-prompt-text-fields` | **Date**: 2026-10-10 | **Spec**: [spec.md](./spec.md)

Every external fact below is cited to the installed package in `node_modules` or to a file in this repo, per
constitution principle I. Nothing here comes from memory, and nothing needed the web.

## Unknowns carried into this phase

The spec left four things to planning and marked nothing `NEEDS CLARIFICATION`:

1. the exact `minRows` / `maxRows` defaults (spec Assumptions: "the exact numbers are a planning decision");
2. how the CSS path and the scripted path are kept from fighting (FR-014);
3. where the counter line goes once the primitive owns the markup order (implied by FR-021 + FR-002);
4. the rule that decides which paragraph drops to caption size (FR-028 says "explanatory … paragraphs", which
   needs a testable definition).

All four are resolved below. No `NEEDS CLARIFICATION` remains, and no `NEEDS RESEARCH` or `NEEDS DEPENDENCY`
is raised.

---

## R1 — Tailwind 4.3.3 ships `field-sizing-content`; no dependency is needed

**Decision**: use the Tailwind utility `field-sizing-content` as the primary growth mechanism.

**Rationale**: verified in the installed package — `node_modules/tailwindcss/dist/lib.js` contains the utility
names `field-sizing`, `field-sizing-content` and `field-sizing-fixed`. `node_modules/tailwindcss/package.json`
reports version `4.3.3`. The repo uses no `tailwind.config`; tokens come from `src/app/globals.css` via
`@import "tailwindcss"`, so an arbitrary-value utility and a named utility both compile with no config change.
The spec's assumption that the CSS-first path needs no new dependency holds.

**Alternatives considered**: a hand-written `@utility` in `globals.css` — rejected, the spec's "Not included"
list forbids touching `globals.css`. A `contenteditable` div — rejected, it is not a form control and would
change what every form submits (FR-027).

## R2 — One row is `1.25rem` for a `text-sm` control, `1.625rem` for the composer

**Decision**: row height is a parameter, defaulting to `1.25` rem, with the composer's long-form field passing
`1.625`.

**Rationale**: `node_modules/tailwindcss/theme.css:349-350` sets `--text-sm: 0.875rem` and
`--text-sm--line-height: calc(1.25 / 0.875)`, so one line box of `text-sm` is exactly `1.25rem` (20 px at the
default root size). `controlStyles` (`src/components/ui/controls.ts:5`) fixes `text-sm`, so every adopting field
except one is `1.25rem` per row. The exception is the composer's post text, which adds
`text-base leading-relaxed` (`src/app/p/[projectSlug]/compose/Composer.tsx:375`):
`theme.css:351` gives `--text-base: 1rem` and `theme.css:394` gives `--leading-relaxed: 1.625`, so one row there
is `1.625rem`. FR-022 requires that size to survive, so the primitive cannot assume a single row height.

**Alternatives considered**: the CSS `lh` unit, which would resolve per element and need no parameter —
rejected, its browser support cannot be verified from `node_modules` or `docs/research/`, and principle I
forbids asserting it from memory. Reading the computed line height in script — kept, but only inside the
scripted fallback (R4), because FR-015 needs the floor and ceiling to hold with scripting unavailable, which
rules out a script-only ceiling.

## R3 — Floor and ceiling are expressed three ways, all from one helper

**Decision**: the primitive emits, for every field:

- `rows={minRows}` — the floor with no CSS and no script at all;
- inline `style.minHeight` — the floor when `field-sizing: content` is in effect, where the `rows` attribute no
  longer drives height;
- inline `style.maxHeight` — the ceiling, plus `overflow-y: auto` so the field scrolls from there (FR-009);

with all three values produced by one pure function so they cannot disagree.

**Rationale**: inline styles are server-rendered markup, so they satisfy FR-015 (no scripting) and FR-040 (no
keystroke needed) without a measurement. The chrome to add to `rows × rowHeight` is fixed by `controlStyles`:
`py-[0.4375rem]` top and bottom (`0.875rem` together) plus a 1 px border top and bottom. So
`height(rows) = calc(rows × rowHeightRem + 0.875rem + 2px)`.

**Alternatives considered**: `max-h-*` Tailwind classes — rejected, the ceiling depends on two runtime props and
would need a class per combination. A CSS variable plus `calc()` in a class — equivalent but harder to assert in
a markup test than a plain inline style.

## R4 — The two growth paths are chosen by a feature test, so they never both run

**Decision**: the scripted fallback runs only when `CSS.supports("field-sizing", "content")` is false. When the
CSS capability is present, the component never writes `style.height`.

**Rationale**: FR-014 requires the paths not to fight. `field-sizing: content` sizes the element from its own
content; an assigned `style.height` would override exactly that and pin the field. A single feature test at the
top of the layout effect makes the choice once per element and keeps one path authoritative. Both paths clamp
through the same helper, so "the same content" cannot produce two heights.

**The fallback's three triggers** cover FR-011, FR-012 and FR-013 in turn:

| Trigger | Covers |
|---|---|
| A `useLayoutEffect` with no dependency array, so it runs after every render | a server-rendered initial value (FR-011), a programmatic or parent-driven value change (FR-012), and a `Dialog` opening, because `Dialog`'s parent re-renders when `open` flips |
| `onInput` | typing and pasting, growth and shrink (FR-008, FR-010) |
| A one-shot `ResizeObserver` that disconnects the first time the element reports a non-zero box | becoming visible with no React render at all — the generation form's collapsed `<details>` (FR-013) |

**Zero-height rule**: when `scrollHeight` is 0 (not rendered: a closed `<dialog>`, a closed `<details>`,
`display: none`), the helper returns no height at all, so the element keeps its CSS floor and never collapses.
This is the spec's "Zero-height measurement" edge case.

**Alternatives considered**: always run the script and never use the CSS path — rejected, it loses the no-script
and pre-hydration behaviour FR-015 asks for. A persistent `ResizeObserver` — rejected, our own height writes
would re-enter it; the one-shot form has no loop.

## R5 — Defaults: `minRows` 3, `maxRows` 20, and no site gets shorter

**Decision**: `minRows` defaults to `3`, `maxRows` defaults to `20`, and `maxRows: null` means no ceiling. Each
adopting site passes `minRows` equal to its current `rows` value, so no field is visibly shorter than today.

**Rationale**: `3` is the most common `rows` value at the thirteen sites and matches the spec's assumption. The
ceiling: `20 × 1.25rem + 0.875rem` is `25.875rem` ≈ 414 px, so on the 900 px viewport of SC-002 a field at its
ceiling leaves roughly half the viewport for the rest of the form and its submit control. The composer's
`1.625rem` rows make its own ceiling taller, which is why it gets `maxRows: 14`
(`14 × 1.625rem + 0.875rem` ≈ 378 px) rather than the default.

**Per-site floors and ceilings** are listed in [data-model.md](./data-model.md); they are derived from each
site's current `rows` attribute, read from the tree on this branch.

**Boundary (spec edge case "value at exactly the ceiling")**: the field grows while content height is **less
than or equal to** the ceiling and scrolls only once it is strictly greater. `overflow-y: auto` is set
unconditionally, so a field at exactly its ceiling shows no scrollbar.

**Floor above ceiling (spec edge case)**: the helper raises the ceiling to the floor —
`maxRows = max(minRows, maxRows)` — so the field is exactly `minRows` tall and scrolls past that. It is a
defined result, it is documented in the contract, and a unit test pins it. It is not an error throw, because a
thrown error in a shared primitive would take a whole screen down for a styling mistake.

## R6 — Clamping lives in `textarea-sizing.ts`, a pure module with no DOM

**Decision**: a new `src/components/ui/textarea-sizing.ts` exports the constants and two pure functions; the
component holds no arithmetic.

**Rationale**: FR-016 and `docs/decisions.md:551` (P10 of entry 014, "logic sits in pure helpers because there
is no DOM test library"). `vitest.config.ts` sets `environment: "node"`, and `jsdom`, `happy-dom` and
`@testing-library/*` are absent from `package.json` and `node_modules`, so a node test can exercise the helper
directly while the markup tests assert what it produced through `renderToStaticMarkup`. This is the pattern
every component test in the repo already uses (`src/components/ui/ui-atoms.test.ts:14`,
`src/components/ui/SetupNotice.test.tsx:13`).

**No `NEEDS DEPENDENCY` is raised**: the split above makes a DOM environment unnecessary, so `jsdom` is neither
needed nor requested.

## R7 — The counter is a slot on the primitive, not caller markup after it

**Decision**: the primitive takes a `counter?: ReactNode`, renders it between the control and the error line,
gives it the id `${id}-count`, and appends that id to `aria-describedby` when it is present.

**Rationale**: `Field`'s markup order is label, hint, control, error, and FR-002 requires the error line to be
last and always reserved. Eight of the thirteen sites render a counter directly under the control today. If the
caller rendered it after the primitive it would land below the error line — a visible reordering FR-021 forbids
("the position of any counter … must not change"). A slot keeps the order.

The id costs nothing: all eight sites already use exactly `${id}-count` —
`PostingInstructionsForm.tsx:67`, `GenerateForm.tsx:62`, `RegenerateDialog.tsx:50`, `VariantEditor.tsx:119`,
`RejectDialog.tsx:53`, and `JobForm.tsx:180` (whose field id is `${uid}-template`, so its count id
`${uid}-template-count` is `${id}-count`). No test pins any of them (checked: no `-count"` literal in any test
file). The primitive owning the id removes six hand-written strings.

This is also what lets FR-024 be satisfied the gentle way: `GenerateForm`'s private `TextArea` becomes a
six-line shell that passes `counter={…}` and restates no label, hint, error or chrome.

**Alternatives considered**: a general `footer` slot (as `Checklist` gained in entry 033) — rejected as less
specific; the only use is a counter, and a named prop is what gets wired into `aria-describedby`.

## R8 — `aria-describedby` and `aria-invalid` keep `Field`'s spread order

**Decision**: copy `Field.tsx:34-39` exactly — `aria-invalid` and `aria-describedby` are set first and
`{...rest}` is spread last, so a caller can override `aria-invalid` and does not have to.

**Rationale**: two sites compute invalidity from something other than `error`:
`PostingInstructionsForm.tsx:60` (`error || tooLong`) and `Composer.tsx:421` (`over`). With `Field`'s spread
order they keep working by passing `aria-invalid` through, with no new prop. FR-025 is satisfied and the
contract stays identical to `Field`'s, which is what FR-002 asks for.

The describedby value is `[hint && hintId, counter && countId, errorId].filter(Boolean).join(" ")`. The error
id is always present, as in `Field`. The consequence the spec already recorded as FR-041 is exactly this: the
voice fields go from `aria-describedby="…-hint"` to `aria-describedby="…-hint …-error"`.

**One id does change**: `PostingInstructionsForm`'s hint is `${id}-help` today and becomes `${id}-hint`. Nothing
asserts `-help` for that field (the two `-help` assertions in the suite,
`src/app/p/[projectSlug]/generate/policy.test.tsx:42` and `src/components/compose/posting-ui.test.ts:50-51`,
belong to the policy picker and the posting-fields helper and are untouched). Recorded as a judgement call for
`docs/decisions.md` under FR-036.

## R9 — `hideLabel` for the one visually hidden label; no `className` escape hatch for labels

**Decision**: the primitive takes `hideLabel?: boolean`, which renders the label `sr-only`. There is no
`labelClassName`.

**Rationale**: `VariantEditor.tsx:107-109` is the only site with an `sr-only` label. `hideLabel` is the name
`SegmentedControl` already uses for the same thing (`src/components/ui/SegmentedControl.tsx:39,54,70`), so the
design system gains no new vocabulary. `MediaPicker.tsx:38` labels its field `text-xs font-medium` today and
moves to the standard `labelStyles` (`text-sm`): a label getting *larger* is allowed — FR-029 only forbids text
getting smaller — and it removes the last reason for a label override.

## R10 — `"use client"`, and why that is not a constitution violation

**Decision**: `TextareaField.tsx` carries `"use client"`. `textarea-sizing.ts` does not and stays importable
anywhere.

**Rationale**: the constitution's "server components by default; client components only for interactivity"
applies — the scripted fallback of R4 is interactivity, and there is no server-only path to it. The cost is
nil in practice: all thirteen adopting sites are already `"use client"` files. Tests still render it with
`renderToStaticMarkup`, as the repo's other client components are tested.

## R11 — Mono is `font-mono`, which is already the type scale's own face

**Decision**: `mono` adds the `font-mono` class and nothing else. No font is added, vendored or fetched.

**Rationale**: `docs/design-system.md:118` already assigns "Code, slugs, keys" to `font-mono`, and
`src/app/globals.css:126` defines `--font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas,
"Liberation Mono", monospace` — a system stack, so nothing loads at build or run time and decision #16 (no font
downloads) is untouched. `globals.css` is not edited, as the spec's "Not included" list requires.

Mono changes the face only, not the size: the field stays `text-sm` from `controlStyles`, so no counter moves
and no limit changes (FR-021). The counter itself is never mono — it is caller markup passed into the `counter`
slot and keeps its own `text-xs` classes.

## R12 — One classification contradiction found, kept as specified, and recorded

**Decision**: apply FR-018 and FR-019 exactly as written. One field contradicts the stated rule, and FR-020
says to record rather than reclassify it.

| Field | Spec says | The rule would say | Resolution |
|---|---|---|---|
| **`Example N`** in the voice editor (`VoiceEditor.tsx:205`, through the shared wrapper FR-018 puts in mono) | mono | proportional — an example post *is* post copy, which FR-019 keeps proportional | **Mono**, per FR-018. The voice editor's five textareas share one wrapper, and splitting it to make `Example N` proportional would re-introduce the per-site divergence this entry exists to remove. Recorded for `docs/decisions.md` so a later review can revisit it as a decision, not an oversight |

Checked and **not** contradictions, with the label read in the tree:

- `Angle N description` (`SeriesPlanEditor.tsx:71-74`) — mono is right; it is a generator input.
- `Brief (Try it)` (`TryItPanel.tsx:102`) — proportional, per FR-019; the spec already records the reasoning in
  its Assumptions and this phase adds nothing.
- The composer's two fields, `Alt text` ×2, `Reason (optional)`, the per-account variant — all post copy, alt
  text or a short note. Proportional.
- The generation form's three fields all come through one wrapper, so `Brief`, `Source text` and
  `Instructions for this post` are mono together, as FR-018's single row for `GenerateForm.tsx:71` intends.

Result: 6 mono, 7 proportional — SC-004 holds.

## R13 — The supporting-copy rule, in three testable clauses

**Decision**: a paragraph drops to `text-xs text-muted-foreground` when **all** of these hold: it is inside a
form or a field group; it explains a field, a group or a list; and the reader never typed or generated it.
Everything else keeps `text-sm`:

- labels, control text, and any typed, saved or generated value or preview;
- a dialog's own body copy (the message the dialog exists to deliver);
- anything carrying `role="alert"`, `role="status"` or `role="note"`, and `LiveRegion` messages — being loud is
  their job, and shrinking a warning is a regression dressed as consistency;
- `PageHeader` descriptions, table typography, headings and `loading.tsx` (FR-032 and the spec's exclusions).

**Rationale**: FR-028's "explanatory, descriptive and helper paragraphs" needs an edge a reviewer can check. The
clauses above are mechanical, they keep FR-029 (nothing in a control shrinks, nothing below 12 px) true by
construction, and they introduce no size that `docs/design-system.md:107-119` does not already define (FR-030).

Applying them to the spec's scope — the twelve files holding the thirteen fields, plus
`src/app/p/[projectSlug]/voice/` in full — yields **six paragraphs**, listed in
[data-model.md](./data-model.md). The three the spec itself names (`VoiceEditor.tsx:187`, `:218`, `:247`) are
among them, which is the check that the rule matches the user's intent on the screen they pointed at.

## R14 — Two visual changes fall out of adoption and are intended

**Decision**: accept both and note them in the implementation notes.

1. **The voice fields gain the shared chrome.** `VoiceEditor`'s private `box`
   (`VoiceEditor.tsx:44-45`) is `rounded-md` with `py-1.5` and no hover, no invalid and no disabled styling.
   `controlStyles` is `rounded-lg` with `py-[0.4375rem]`, a hover border, a focus ring, `aria-invalid` colours
   and disabled styling. FR-003 requires the shared string, so the voice fields change shape slightly and gain
   the states. This is the divergence the entry set out to end.
2. **Six fields gain an error line and a describedby.** `Composer` ×2, `SeriesPlanEditor`, `MediaEditDialog`,
   `TryItPanel` and `MediaPicker` have no `aria-describedby` today and gain the reserved `min-h-4` error
   paragraph. FR-026 says so explicitly and calls it an improvement. It adds 16 px under each of those six
   fields.

## Risks and how each is handled

| Risk | Handling |
|---|---|
| A browser without `field-sizing` behaves differently | R4's feature test picks exactly one path; both clamp through the same helper, so the heights agree |
| A test elsewhere asserts the old textarea markup | Only three test files mention `textarea`. `tests/integration/accounts-ui.test.ts:235,302` assert `<textarea` is present / absent, and the primitive still renders a `<textarea>`, so both hold. `src/app/p/[projectSlug]/ui-conventions.test.ts:49-62` requires every raw control to be labelled; after adoption it finds no textarea in those files and still passes. `voice.test.tsx` changes as FR-041 prescribes |
| Deleting `Area` breaks its test import | `voice.test.tsx:166-169` imports `Area` from `./VoiceEditor`. It is re-pointed at `TextareaField`; its assertion `aria-describedby="x-hint x-error"` is exactly what the primitive emits for a field with a hint and an error, so the asserted value stays unchanged, as FR-041 requires |
| The `docket-ui` skill file cannot be written | The sandbox refused writes to `.claude/skills/docket-ui/SKILL.md` in entries 028, 029 and 033 (`docs/decisions.md`). If it is refused again, the edit is recorded as an **Open item (needs a human)** in `docs/decisions.md`, which is this repo's established route |
| Scope creep into entry 2 | `accounts/SlotEditor.tsx`, the slot table and `src/server/services/slots.ts` are untouched. None of them holds a textarea, and none holds a paragraph the R13 rule selects |
