# Implementation Plan: Auto-growing, monospace prompt and instruction fields

**Branch**: `034-prompt-text-fields` | **Date**: 2026-10-10 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/034-prompt-text-fields/spec.md`

## Summary

Entry 1 of 2 in the UI tweaks roadmap. It adds the multi-line text field the design system never had, moves all
thirteen hand-rolled `<textarea>` sites onto it, and applies the type scale `docs/design-system.md` §4 already
defines. Presentation only: no server action, validation schema, service, column or stored value changes.

| Area | Change |
|---|---|
| New primitive | `src/components/ui/TextareaField.tsx` beside `Field.tsx` — `Field`'s accessibility contract exactly, `controlStyles` for the chrome, plus `minRows` / `maxRows` growth, a `mono` option, a `counter` slot and `hideLabel` |
| New pure module | `src/components/ui/textarea-sizing.ts` — the floor/ceiling/clamp arithmetic, callable with no DOM |
| Growth | CSS `field-sizing: content` first (Tailwind's `field-sizing-content`), with a scripted fallback chosen by one feature test so the two paths never both run |
| Monospace | `font-mono` on the 6 sites holding a prompt, an instruction or a source document; the other 7 keep the proportional face. 8 counters unchanged |
| Adoption | 13 sites, 12 files. `VoiceEditor`'s private `Area` deleted; `GenerateForm`'s private `TextArea` reduced to a counter shell |
| Supporting copy | 7 explanatory paragraphs drop from `text-sm` to `text-xs text-muted-foreground`, by a stated three-clause rule, with the voice screen as the reference |
| Docs | `docs/design-system.md` §4 and §7, `docs/decisions.md`, and the `docket-ui` skill (an owed edit if the sandbox refuses it) |

**Technical approach** (decisions and citations in [research.md](./research.md)):

- **The floor and the ceiling are server-rendered, three ways from one helper.** `rows={minRows}` (works with no
  CSS and no script), inline `min-height` (the floor once `field-sizing: content` is in effect, where `rows` no
  longer drives height) and inline `max-height` plus `overflow-y: auto` (the ceiling). One pure function
  produces all three, so they cannot disagree, and all three are in the first paint — which is what makes a
  saved value appear at full height with no keystroke and no hydration (FR-011, FR-015, FR-040).
- **One growth path runs at a time.** `CSS.supports("field-sizing", "content")` picks it. When the CSS
  capability is there, the component never writes `style.height` — an assigned height is exactly what would
  override content sizing. When it is not, a layout effect (every render: initial value, programmatic change,
  a `Dialog` opening), an `onInput` handler (typing, shrinking) and a one-shot `ResizeObserver` (becoming
  visible with no React render, i.e. the collapsed `<details>`) each re-measure through the same clamp.
- **A hidden field never collapses.** `scrollHeight` is 0 for an element that is not being rendered, and the
  clamp returns no height for that, so the CSS floor stands until the element has a real box.
- **Row height is a parameter, not a constant.** One row is `1.25rem` for a `text-sm` control and `1.625rem`
  for the composer's `text-base leading-relaxed` field, both read from
  `node_modules/tailwindcss/theme.css`. The composer is the only caller that passes its own.
- **The counter is a slot on the primitive, not caller markup after it.** `Field`'s order ends with the
  reserved error line; a caller-rendered counter would land below it and move visibly, which FR-021 forbids. All
  eight counters already use exactly the id `${id}-count`, so the primitive can own that id and nothing changes.
- **`Field`'s spread order is copied verbatim**, so the two sites that compute invalidity from something other
  than `error` keep working by passing `aria-invalid` through, with no new prop.
- **The sizing tests go through the pure module.** `vitest.config.ts` is `environment: "node"` and there is no
  DOM test library; the markup tests assert what the helper produced through `renderToStaticMarkup`, the pattern
  every component test in this repo already uses. No dependency is added and none is requested.

## Technical Context

**Language/Version**: TypeScript (strict), Node 24 LTS.

**Primary Dependencies** (all already installed; **no new runtime or dev dependency**):

- **Tailwind 4.3.3** — provides `field-sizing-content` and `field-sizing-fixed`, verified in
  `node_modules/tailwindcss/dist/lib.js`; `node_modules/tailwindcss/package.json` confirms the version.
- **Type scale** from `node_modules/tailwindcss/theme.css:349-351,394`: `--text-sm: 0.875rem` with line height
  `calc(1.25 / 0.875)` (so `1.25rem` a row), `--text-base: 1rem`, `--leading-relaxed: 1.625`.
- **React 19.2.8** — `ref` is a plain prop on a function component, so no `forwardRef`; the installed
  `@types/react@19.3.0` says as much at `index.d.ts:262-275` ("You only need this type if you manually author
  the types of props that need to be compatible with legacy refs … it's simpler to directly use `Ref`").
- **Next.js 16.3.8**, App Router. The primitive is a `"use client"` module; every adopting file is already one.
- Vitest, Zod unchanged. No new icon, no font, no `globals.css` edit.

**Storage**: PostgreSQL — **no change at all**. No table, column, migration, index or stored preference, and no
new query. `pnpm db:check` is not part of the final pass. See [data-model.md](./data-model.md).

**Testing**: Vitest, `environment: "node"` (see [quickstart.md](./quickstart.md)):

- **Pure unit test** — `src/components/ui/textarea-sizing.test.ts`: the floor, growth, the ceiling turning
  scrolling back on, the inclusive boundary, shrink, zero-height, absent ceiling, floor-above-ceiling, and the
  composer's row height (FR-038).
- **Markup test** — `src/components/ui/TextareaField.test.tsx` via `renderToStaticMarkup`: label, hint, error,
  the exact `aria-describedby` value, `aria-invalid`, the counter slot and its id, `font-mono` present and
  absent, `field-sizing-content`, and the full sizing contract present for a long `defaultValue` (FR-037,
  FR-039, FR-040).
- **Updated on purpose** — `src/app/p/[projectSlug]/voice/voice.test.tsx`: the hint assertion at line 160 moves
  from `aria-describedby="<hintId>"` to `"<hintId> <errorId>"`, and the field-error test imports
  `TextareaField` instead of the deleted `Area` while its asserted value `"x-hint x-error"` stays byte-identical
  (FR-041).
- **Expected to keep passing unchanged** — `src/app/p/[projectSlug]/ui-conventions.test.ts` (it finds no raw
  textarea in those files and still passes), `tests/integration/accounts-ui.test.ts:235,302` (the primitive still
  renders a `<textarea>`).
- **A grep check** that no hand-rolled `<textarea>` is left outside the primitive (SC-005).
- **A browser walk-through** at desktop width and 390 px, with JavaScript disabled for one pass. The CSS growth
  path cannot be proven by a node test, so this is reported as run or not run, never assumed (principle II).

**Target Platform**: the self-hosted web app (Docker Compose or Neon), desktop and phone-width browsers, with
and without `field-sizing` support and with and without scripting.

**Project Type**: a single Next.js web application (`src/app`, `src/components`, `src/lib`, `src/server`).

**Performance Goals**: no query, no network call and no new render path. The CSS path costs nothing at runtime.
The fallback path's layout effect reads `scrollHeight` and `getComputedStyle` once per render of a field that is
already re-rendering, and its `ResizeObserver` disconnects after one useful callback.

**Constraints**:

- No server action, validation schema, service, DAL method, column or limit constant may change (FR-027).
- No new dependency, no `globals.css` edit, no new token or size (FR-030, spec "Not included").
- Nothing in a control may shrink and nothing may go below 12 px (FR-029).
- Every field keeps its accessible name, hint, error, limit, counter and read-only behaviour word for word
  (FR-025); no field gains invented copy.
- Entry 2's territory — `accounts/SlotEditor.tsx`, the posting-slot table, `src/server/services/slots.ts` — is
  untouched.
- Full keyboard use, visible focus, labelled controls; the `docket-ui` skill governs the UI work.

**Scale/Scope**: 2 new source files and 1 new test file; 12 existing component files edited for adoption, 4 of
them also for supporting copy (plus 2 more files for copy alone); 2 docs files and 1 skill file; 1 existing test
file updated on purpose. About 22 files.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|---|---|---|
| I. Verified facts over memory | **PASS** | Every external fact is cited to an installed package: the `field-sizing` utilities to `node_modules/tailwindcss/dist/lib.js`, the row heights to `theme.css:349-351,394`, ref-as-prop to `@types/react/index.d.ts:262-275`. The CSS `lh` unit was *rejected* precisely because its support cannot be verified from `node_modules` or `docs/research/` (research R2). No platform API is touched, so `docs/research/` has nothing to contribute |
| II. Nothing is "working" unless it ran | **PASS** | Every requirement maps to a command in [quickstart.md](./quickstart.md). The browser walk-through and the no-JavaScript pass are the only proof of the CSS growth path and are reported as run or not run, never assumed |
| III. Project isolation in one place | **PASS** | No data access of any kind is added. No DAL method, no raw DB client, no scope call, no role check — role behaviour stays exactly where the server already decides it (spec Assumptions) |
| IV. One service layer | **PASS** | No service is touched. The duplication this entry removes is in the UI: 2 divergent private wrappers plus 11 bespoke sites become 1 primitive (SC-011) |
| V. Providers are plug-ins | **PASS** | No provider, scheduler, composer or schema change |
| VI. Boring, few dependencies | **PASS** | Zero new dependencies. `field-sizing` is already in the installed Tailwind; the monospace face is already a system stack in `globals.css:126`. No DOM test library is requested: the pure-helper split makes one unnecessary (research R6), so no `NEEDS DEPENDENCY` is raised |
| VII. Secrets never leak | **PASS** | No credential, token, env var or log path is involved |
| Engineering: accessibility | **PASS — and improves** | 13 of 13 fields get a label, a linked hint when they have one and a reserved `aria-live` error region, up from 7 of 13. Focus rings reach the voice fields, which had their own weaker ring. Nothing is conveyed by colour alone |
| Engineering: server components by default | **PASS, with a reason** | `TextareaField.tsx` is `"use client"` because the scripted fallback is interactivity and has no server-only form. All thirteen adopting files are already client components, so no boundary moves. `textarea-sizing.ts` has no directive and imports nothing |
| Workflow: docs and decisions | **PASS** | `docs/design-system.md` §4 and §7 and a `## 034` entry in `docs/decisions.md` are planned (FR-033–FR-036). The `docket-ui` skill edit takes the established owed-edit route if the sandbox refuses the write, as in entries 028, 029 and 033 |
| Workflow: proportional checks | **PASS** | Per task: the affected test files plus `pnpm typecheck` when types changed. Once at the end: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`. No `pnpm db:check` — nothing schema-shaped changed |

No violations, so **Complexity Tracking is empty**.

**Post-design re-check**: **PASS.** Phase 1 added one client component, one pure module and one test file, and
no dependency, table, service, provider or role check. Two judgement calls go to `docs/decisions.md` rather than
being made silently: the one classification contradiction (`Example N` stays monospace per FR-018 although an
example post is post copy — research R12, as FR-020 requires) and the `aria-describedby` / hint-id changes the
shared contract forces (research R8, already anticipated as FR-041). Both are recorded, neither is a
constitution violation.

## Project Structure

### Documentation (this feature)

```text
specs/034-prompt-text-fields/
├── plan.md              # This file
├── research.md          # Phase 0: decisions R1–R14, risks
├── data-model.md        # Phase 1: props, the 13 fields, the 7 paragraphs (no persistent change)
├── quickstart.md        # Phase 1: commands, expectations, the browser walk-through
├── contracts/
│   ├── component.md     # TextareaField and textarea-sizing signatures and invariants
│   └── ui.md            # Screen-by-screen behaviour, copy and keyboard rules
├── checklists/          # Pre-existing
└── tasks.md             # Phase 2 (/speckit-tasks; not created here)
```

### Source Code (repository root)

```text
src/
├── components/
│   ├── ui/
│   │   ├── textarea-sizing.ts            # NEW  pure: resolveBounds, sizingStyle, measureHeight
│   │   ├── textarea-sizing.test.ts       # NEW  node test, no DOM
│   │   ├── TextareaField.tsx             # NEW  "use client"; Field's contract + growth + mono + counter
│   │   ├── TextareaField.test.tsx        # NEW  renderToStaticMarkup
│   │   └── controls.ts                   # unchanged (the primitive consumes it)
│   └── media/MediaPicker.tsx             # adopt (alt text); "No images attached." → caption
└── app/p/[projectSlug]/
    ├── accounts/PostingInstructionsForm.tsx   # adopt; mono; counter slot; aria-invalid passthrough
    ├── compose/Composer.tsx                   # adopt ×2; rowHeightRem for the post text; 1 paragraph
    ├── generate/
    │   ├── GenerateForm.tsx                   # TextArea reduced to a counter shell; mono ×3
    │   ├── SeriesPlanEditor.tsx               # adopt; mono; 1 paragraph
    │   └── result/[postId]/
    │       ├── RegenerateDialog.tsx           # adopt; mono; counter slot
    │       └── VariantEditor.tsx              # adopt; hideLabel; counter slot
    ├── jobs/new/JobForm.tsx                   # adopt; mono; ref forwarded for insertField
    ├── media/MediaEditDialog.tsx              # adopt
    ├── review/RejectDialog.tsx                # adopt; counter slot
    └── voice/
        ├── VoiceEditor.tsx                    # Area DELETED; 5 call sites adopt; mono; 3 paragraphs
        ├── TryItPanel.tsx                     # adopt (stays proportional)
        ├── voice.test.tsx                     # :160 updated on purpose; Area import → TextareaField
        └── [profileId]/history/page.tsx       # 1 paragraph

docs/
├── design-system.md                      # §4 monospace line; §7 TextareaField row + controlStyles row edit
└── decisions.md                          # ## 034 entry, plus an Open item if the skill write is refused

.claude/skills/docket-ui/SKILL.md         # TextareaField convention (owed edit if refused)
```

**Structure Decision**: the existing single Next.js app layout, unchanged. The primitive goes in
`src/components/ui/` beside `Field.tsx` and `Select.tsx`, which is where the spec puts it and where every other
shared control lives. The arithmetic goes in a sibling `.ts` rather than being exported from the component (the
repo's other pure UI helpers, `fitsSegmented` and `filterOptions`, are exported from their components) for one
reason: `TextareaField.tsx` is `"use client"`, and FR-016 wants the arithmetic callable from anywhere with no
DOM and no directive. `src/components/ui/controls.ts` is the existing precedent for a non-component module in
that directory. No directory is created and no boundary moves.

## Implementation order (for /speckit-tasks)

The order follows the spec's priorities (P1 growth, P2 monospace, P3 copy) and keeps every step independently
verifiable.

1. **The pure module and its test.** `textarea-sizing.ts` plus `textarea-sizing.test.ts`. No UI dependency, and
   it pins every edge case before anything consumes it (FR-016, FR-038).
2. **The primitive and its test.** `TextareaField.tsx` plus `TextareaField.test.tsx`: `Field`'s contract, the
   counter slot, `mono`, `hideLabel`, both growth paths (FR-001–FR-005, FR-037, FR-039, FR-040).
3. **US1 + US2 adoption, one file at a time**, each with its floor, ceiling and `mono` from
   [data-model.md](./data-model.md) §2 and its per-site notes from [contracts/ui.md](./contracts/ui.md).
   Suggested order, cheapest and least-tested first, so surprises surface where they are easy to read:
   1. `MediaPicker`, `MediaEditDialog`, `RejectDialog`, `TryItPanel`, `SeriesPlanEditor` — no counter or a
      simple one, no hint;
   2. `RegenerateDialog`, `VariantEditor`, `PostingInstructionsForm`, `JobForm` — counters,
      `aria-invalid` passthrough, a forwarded ref;
   3. `Composer` ×2 — the one site with its own type size and `rowHeightRem`;
   4. `GenerateForm` — reduce the private `TextArea` to a counter shell (FR-024);
   5. `VoiceEditor` — delete `Area`, move its five call sites, and update `voice.test.tsx` in the same
      commit so the suite is never left red (FR-024, FR-041).
4. **The SC-005 grep check**, as a task in its own right: no hand-rolled `<textarea>` outside the primitive.
5. **US3 supporting copy**, the voice screen first as FR-031 requires, then the other five paragraphs
   (data-model §4).
6. **Docs**: `docs/design-system.md` §4 and §7, the `docket-ui` skill, and the `## 034` entry in
   `docs/decisions.md` carrying the four judgement calls.
7. **The final pass**: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`, fixing any assertion a shared
   style broke in a screen this entry did not set out to change — updated to the new markup, never deleted or
   skipped (FR-042) — then the browser walk-through if a browser is available.

**Commits**: Conventional Commits, explicit paths only, one per step or tightly related group, each ending with
the `Co-Authored-By` trailer the constitution requires. Step 1–2 are `feat(ui):`, step 3 `refactor(ui):` per
file, step 5 `style(ui):` or `refactor(ui):`, step 6 `docs:`.
