# Feature Specification: Auto-growing, monospace prompt and instruction fields

**Feature Branch**: `034-prompt-text-fields`

**Created**: 2026-10-10

**Status**: Draft

**Input**: User description: "Entry 1 of 2 in the UI tweaks roadmap (`.specify/roadmaps/ui-tweaks.json`): readable prompt and instruction text fields. The shared-primitive and typography work; entry 2 (week-slot-grid) builds the weekly posting-slot grid and must inherit the type scale this entry settles. The reported problem, in the user's words: 'We're doing a lot of textareas to describe instructions or prompts. Since prompts can be in markdown we should at least display that as monospace font. I think all of the copy could stand to be smaller text as well. I'm looking at spots like under "voice" and it seems like we should do text fields that grow with the copy so you don't have to do internal scrolling.' Three things to fix, in order of importance: (1) a shared auto-growing textarea primitive `TextareaField` in `src/components/ui/` matching `Field`'s contract, with a `minRows` floor and optional `maxRows` ceiling; (2) a `mono` option turned on for the fields that hold prompts, instructions or markdown; (3) smaller supporting copy on form-heavy screens, per `docs/design-system.md` section 4, with the voice screen as the reference. Adopt the primitive at all 13 textarea sites, delete VoiceEditor's private wrapper, and document it in `docs/design-system.md`. Change presentation and one shared component only — not a single server action, validation schema or service. Not included: a markdown preview pane or split editor; syntax highlighting; a rich-text or CodeMirror/Monaco editor; changing what any prompt field stores or validates; a project-wide font or token change in `globals.css`; a density or compact-mode preference. Entry 2 owns the posting-slot week grid and all slot behaviour."

## Context

Docket asks people to write a lot of free text that is not a post: a brand voice's tone and audience, an
account's posting instructions, a generation brief, source text, per-post instructions, a jobs instructions
template, a series angle's description. All of it goes through a `<textarea>`, and today every one of those is
hand-rolled.

What is there now, verified in the tree:

- **No textarea primitive.** `src/components/ui/` has `Field.tsx` for `<input>` and `Select.tsx` for `<select>`,
  but nothing for `<textarea>`. `docs/design-system.md` §7 points raw `<textarea>` callers at the
  `controlStyles` / `labelStyles` / `hintStyles` / `errorStyles` class strings in
  `src/components/ui/controls.ts` and leaves the wiring to each caller.
- **Thirteen hand-rolled sites**, each with its own label markup, its own `aria-describedby` string and its own
  guessed `rows` value (`rows={2}` through `rows={6}`):
  `accounts/PostingInstructionsForm.tsx:54`, `compose/Composer.tsx:369` and `:416`,
  `generate/GenerateForm.tsx:71`, `generate/SeriesPlanEditor.tsx:74`,
  `generate/result/[postId]/RegenerateDialog.tsx:42`, `generate/result/[postId]/VariantEditor.tsx:110`,
  `jobs/new/JobForm.tsx:169`, `media/MediaEditDialog.tsx:39`, `review/RejectDialog.tsx:45`,
  `voice/TryItPanel.tsx:102`, `voice/VoiceEditor.tsx:68`, `components/media/MediaPicker.tsx:41`.
- **Two private wrappers have already grown.** `voice/VoiceEditor.tsx:47-81` exports an `Area` component with
  its own `box` class string (`rounded-md`, not the `rounded-lg` every other control uses) and its own
  hint/error wiring; `generate/GenerateForm.tsx:51-86` has a near-identical `TextArea` with a character
  counter. The duplication is already spreading, and the two have already diverged from each other and from
  `Field`.
- **The wiring differs field to field.** `Field` always lists both the hint id and the error id in
  `aria-describedby` and always renders the error paragraph (`min-h-4`, `aria-live="polite"`) so the line
  reserves its space. `Area` lists the hint only when there is no error and renders no error line at all when
  there is no error. `VariantEditor`, `RegenerateDialog` and `RejectDialog` describe by a counter id only.
  `Composer` (both fields), `SeriesPlanEditor`, `MediaEditDialog`, `TryItPanel` and `MediaPicker` — six of the
  thirteen — have no `aria-describedby` at all.
- **Every field scrolls internally.** A posting-instructions value near its `POSTING_INSTRUCTIONS_MAX` budget,
  or a jobs instructions template with a dozen lines, is read five rows at a time through a scrollbar.
- **Markdown is displayed as prose.** Prompts and instructions may contain markdown, and all of them render in
  Inter at `text-sm` via `controlStyles`, so list markers, fences and indentation do not line up.
- **Supporting copy sits at body size.** `docs/design-system.md` §4 already sets 14 px `text-sm` for body and
  12 px `text-xs` for "Caption, hint, table header", and `hintStyles` is already `text-xs text-muted-foreground`.
  But the form-heavy screens mix the two: `VoiceEditor.tsx:187` ("Version N"), `:218` ("No examples.") and
  `:247` ("Per-platform guidance now lives on each account.") are explanatory copy rendered at `text-sm`,
  sitting beside hints already at `text-xs`. The voice screen is the one the user named.

This entry adds the missing primitive, moves all thirteen sites onto it, and applies the type scale the docs
already define. It is deliberately a presentation change: no server action, validation schema, service or
stored value changes, so entry 2 can build the week grid on a settled primitive and a settled type scale.

Two facts about the codebase constrain how this is specified and must be respected rather than discovered
during planning:

1. **`Dialog` keeps its children mounted while closed.** `src/components/ui/Dialog.tsx` always renders
   `{children}` inside a native `<dialog>` and calls `showModal()` from an effect. A textarea inside a closed
   dialog is therefore in the document but not rendered, so any height measured from it is zero. Three of the
   thirteen sites (`RegenerateDialog`, `MediaEditDialog`, `RejectDialog`) are inside a `Dialog`.
2. **There is no DOM test library.** `vitest.config.ts` sets `environment: "node"`, and `jsdom`,
   `happy-dom` and `@testing-library/*` are absent from `package.json` and from `node_modules`. Every
   component test in the repo asserts over `renderToStaticMarkup` output. `docs/decisions.md` P10 records the
   standing consequence: "logic sits in pure helpers because there is no DOM test library." Height and row
   clamping must therefore live in a pure helper that a node test can exercise directly, with the markup tests
   asserting the attributes and classes that helper produces.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Write a long prompt without scrolling inside the box (Priority: P1)

A project owner opens a voice profile and types a paragraph into "Voice and tone", then opens the account's
posting instructions and pastes in a long set of rules. In both places the box starts at a sensible height,
grows downward line by line as the text gets longer, and stops growing once it is tall enough that the page
itself scrolls instead — the Save button is still reachable. Reopening the page shows the already-saved text at
its full height straight away, not collapsed into a five-row window.

**Why this priority**: This is the complaint in the user's own words, and it is the one that makes long prompts
practically unreadable today. It delivers value on its own even if nothing else in this entry ships: the same
boxes, now readable.

**Independent Test**: Fully testable by opening any of the thirteen fields with a short, a medium and a very
long value and confirming the rendered height follows the content between its floor and its ceiling, that the
ceiling turns scrolling back on, and that a server-rendered saved value arrives already at its grown height.

**Acceptance Scenarios**:

1. **Given** an empty prompt field with a floor of N rows, **When** the page renders, **Then** the field is N
   rows tall and shows no scrollbar.
2. **Given** that field, **When** the reader types enough text to exceed N rows but stay under the ceiling,
   **Then** the field grows to fit the text and still shows no scrollbar.
3. **Given** that field, **When** the content exceeds the ceiling, **Then** the field stops at the ceiling
   height and scrolls internally from that point on, and the form's submit control stays on screen.
4. **Given** a saved posting-instructions value forty lines long, **When** the page is loaded fresh, **Then**
   the field is already at its grown height before the reader interacts with it.
5. **Given** a field whose value is replaced by the application rather than typed (a reset, a loaded draft, a
   cleared form), **When** the new value renders, **Then** the height matches the new value.
6. **Given** a prompt field inside a `Dialog`, **When** the dialog is opened for the first time, **Then** the
   field is at the height its current value needs, not at the floor and not at zero.

---

### User Story 2 - Read markdown in a prompt as markdown (Priority: P2)

Someone writing an account's posting instructions or a jobs instructions template uses markdown — a bulleted
list of rules, a `{{field}}` placeholder, an indented example. The field shows that text in a monospace face,
so the markers line up and the placeholders are legible as tokens. The field they use to write the post itself,
or an image's alt text, or a rejection reason, stays in the proportional face it is today, because none of that
is markdown and post copy should look like the post.

**Why this priority**: Second in the user's own ordering. It depends on the primitive from story 1 existing but
is independently visible and independently testable.

**Independent Test**: Testable by rendering each of the thirteen fields and confirming the monospace face is
present on exactly the fields classified as prompt/instruction/source text and absent on the rest, and that
every character counter beside a monospace field still reads correctly and stays aligned.

**Acceptance Scenarios**:

1. **Given** a field classified as holding a prompt, instruction or source document, **When** it renders,
   **Then** its text is in the monospace face named in `docs/design-system.md` §4 ("Code, slugs, keys").
2. **Given** a field classified as holding post copy, alt text or a short note, **When** it renders, **Then**
   its text is in the proportional face it uses today.
3. **Given** a monospace field with a character counter or limit beside it (posting instructions, the
   generation brief/source/instructions, the jobs template), **When** the field is near its limit, **Then** the
   counter still shows the same count and limit and is still aligned where it was.
4. **Given** the composer's post text, **When** it renders, **Then** it is still at the long-form composer size
   `docs/design-system.md` §4 prescribes and is not monospace.

---

### User Story 3 - Forms that explain themselves without shouting (Priority: P3)

A newcomer opens the voice editor. The field labels and the text they type are at body size; the explanatory
lines under and around them — what a field is for, how many examples are allowed, where per-platform guidance
lives now — are at caption size and in the muted colour, so the form reads as a form rather than a wall of
equally loud sentences. Nothing is smaller than 12 px and nothing they type got smaller.

**Why this priority**: The third of the user's three asks, and the lowest-risk. It also settles the type scale
entry 2's week grid must inherit, which is why it belongs in this entry rather than a later one.

**Independent Test**: Testable screen by screen by confirming each explanatory paragraph renders at caption
size in the muted colour while every label, control and typed value stays at body size, with the voice screen
as the agreed reference.

**Acceptance Scenarios**:

1. **Given** the voice editor, **When** it renders, **Then** every explanatory or helper paragraph inside the
   form is at caption size in the muted colour, and every label and field value is at body size.
2. **Given** any screen touched by this entry, **When** it renders, **Then** no text is below 12 px and no text
   inside a control got smaller.
3. **Given** a `PageHeader` description or a table, **When** it renders, **Then** its typography is unchanged
   from today.

---

### Edge Cases

- **Zero-height measurement.** A field inside a closed `Dialog`, inside a collapsed `<details>` (the
  generation form's "Add source text"), or in any element that is not being rendered, measures as zero height.
  The field must fall back to its floor in that case and must take its real height once it becomes visible —
  never collapse to zero and never stay at the floor with content overflowing.
- **No scripting.** With scripting unavailable or before hydration, the field must still be at least its floor,
  never taller than its ceiling, and must still be usable; growth in that state comes from the CSS capability
  alone where the browser supports it.
- **Browser without the CSS sizing capability.** The field must grow by the scripted path instead, with the
  same floor and ceiling.
- **A 400-line paste.** The field stops at its ceiling; the page, not the field, is what grows, and the submit
  control stays reachable.
- **Floor above ceiling.** A caller that passes a floor larger than the ceiling must get a defined, documented
  result rather than a field that is both.
- **Ceiling absent.** A field with no ceiling grows without bound; this is allowed only where a caller
  deliberately chooses it, and the default for an unspecified ceiling must be documented.
- **Read-only and disabled fields.** The voice editor renders every field read-only for an editor without
  manage rights. A read-only field must still show its full saved value at its grown height.
- **A field that is a controlled value vs. one that is not.** Both must size correctly; the primitive cannot
  require one or the other.
- **Shrinking.** Deleting text must shrink the field back toward the floor, not leave it stuck at its tallest.
- **Monospace and a character budget.** A monospace face has different metrics; the counter and limit text
  beside a field must not reflow or mis-align, and the limit itself must not change.
- **Value at exactly the ceiling.** The boundary between "grows" and "scrolls" must be defined, not
  off-by-one.

## Requirements *(mandatory)*

### Functional Requirements

**The shared primitive**

- **FR-001**: The design system MUST provide one shared labelled multi-line text field primitive
  (`TextareaField`) in `src/components/ui/`, alongside `Field.tsx`, and it MUST be the only way any screen in
  this entry renders a multi-line text field.
- **FR-002**: The primitive MUST match `Field`'s accessibility contract exactly: a required `id`; a `label`
  associated with the control; an optional `hint` and an optional `error`, both linked through
  `aria-describedby`; the error rendered inside an `aria-live="polite"` region that reserves its line whether
  or not there is an error; and `aria-invalid` set from the presence of `error`.
- **FR-003**: The primitive MUST take its chrome (border, radius, background, focus ring, invalid styling,
  disabled styling) from the shared `controlStyles` string, so it matches `Field` and `Select` without
  restating any of it.
- **FR-004**: The primitive MUST accept the same arbitrary pass-through attributes a raw `<textarea>` takes
  today at the thirteen sites — at minimum `name`, `value`, `defaultValue`, `onChange`, `onBlur`, `required`,
  `readOnly`, `disabled`, `maxLength`, `placeholder` and a forwarded ref — so no site loses behaviour by
  adopting it.
- **FR-005**: The primitive MUST work both as a controlled field (value supplied every render) and as an
  uncontrolled field (initial value only), and MUST size correctly in both.

**Growth**

- **FR-006**: The primitive MUST accept a `minRows` floor and an optional `maxRows` ceiling, and MUST document
  the default for each.
- **FR-007**: The field MUST render at least `minRows` rows tall at all times, including when empty.
- **FR-008**: The field MUST grow to fit its content between the floor and the ceiling, without an internal
  scrollbar in that range.
- **FR-009**: Once content exceeds `maxRows`, the field MUST stop growing, MUST scroll internally from that
  point, and MUST NOT push the form's submit control out of reach.
- **FR-010**: The field MUST shrink back toward the floor when content is removed.
- **FR-011**: The field MUST be at its correct height for a value that was present at first render (a
  server-rendered saved value), not only after the first keystroke.
- **FR-012**: The field MUST re-size when its value changes without a keystroke — programmatically, by a reset,
  or by a parent re-render with a different value.
- **FR-013**: The field MUST reach its correct height when it becomes visible after being rendered while
  hidden, which covers the three sites inside a `Dialog` and the generation form's collapsed source-text
  `<details>`.
- **FR-014**: Growth MUST prefer the CSS content-sizing capability, with a scripted fallback that produces the
  same floor and ceiling where that capability is unavailable; the two paths MUST NOT fight each other or
  produce two different heights for the same content.
- **FR-015**: With scripting unavailable, the field MUST still honour its floor and ceiling and MUST still be
  usable.
- **FR-016**: The clamping arithmetic (content height, floor, ceiling, and whether to scroll) MUST live in a
  pure helper that is callable and assertable without a DOM, per `docs/decisions.md` P10.

**Monospace**

- **FR-017**: The primitive MUST accept a `mono` option that renders the field's text in the monospace face
  named in `docs/design-system.md` §4, and MUST render the proportional face when the option is absent.
- **FR-018**: The monospace option MUST be on for exactly these fields, which hold a prompt, an instruction or
  a source document the generator reads and where markdown may be meaningful:

  | Field | Site |
  |---|---|
  | Posting instructions for an account | `accounts/PostingInstructionsForm.tsx:54` |
  | Brief, Source text, Instructions for this post (the form's shared wrapper) | `generate/GenerateForm.tsx:71` |
  | Angle N description | `generate/SeriesPlanEditor.tsx:74` |
  | Extra instruction (optional) | `generate/result/[postId]/RegenerateDialog.tsx:42` |
  | Instructions template | `jobs/new/JobForm.tsx:169` |
  | Voice and tone, Audience, Topics and pillars, Avoid, Example N (the editor's shared wrapper) | `voice/VoiceEditor.tsx:68` |

- **FR-019**: The monospace option MUST be off for exactly these fields, which hold post copy, alt text or a
  short note:

  | Field | Site |
  |---|---|
  | Post text | `compose/Composer.tsx:369` |
  | Text for *account* (per-account override) | `compose/Composer.tsx:416` |
  | Per-account variant text (visually hidden label) | `generate/result/[postId]/VariantEditor.tsx:110` |
  | Alt text | `media/MediaEditDialog.tsx:39` |
  | Reason (optional) | `review/RejectDialog.tsx:45` |
  | Brief (Try it) | `voice/TryItPanel.tsx:102` |
  | Alt text (picker) | `components/media/MediaPicker.tsx:41` |

- **FR-020**: Each of the thirteen classifications MUST be checked against the field's rendered label and
  purpose before it is applied, and any field whose label contradicts the classification above MUST be
  recorded in the implementation notes rather than silently reclassified.
- **FR-021**: Turning on monospace MUST NOT change any character count, any character limit, or the position of
  any counter or limit text beside the field. Six counters sit beside a field that becomes monospace —
  `PostingInstructionsForm` (1), the generation form's Brief, Source text and Instructions (3),
  `RegenerateDialog` (1) and `JobForm` (1) — and each MUST be checked specifically. The two counters beside
  fields that stay proportional (`VariantEditor`, `RejectDialog`) MUST also be unchanged.
- **FR-022**: The composer's post text MUST keep the long-form composer size `docs/design-system.md` §4
  prescribes and MUST NOT become monospace.

**Adoption**

- **FR-023**: All thirteen hand-rolled `<textarea>` sites listed in Context MUST render through the primitive.
- **FR-024**: `VoiceEditor`'s private `Area` wrapper MUST be deleted, and the generation form's private
  `TextArea` wrapper MUST either be deleted or reduced to a thin counter-adding shell over the primitive that
  restates none of the label, hint, error or chrome.
- **FR-025**: Every field's existing accessible name, hint text, error text, character limit, read-only
  behaviour, counter and submit behaviour MUST be preserved. Fields that have no hint or error today MUST NOT
  gain invented copy.
- **FR-026**: The six fields that have no `aria-describedby` today (`Composer` ×2, `SeriesPlanEditor`,
  `MediaEditDialog`, `TryItPanel`, `MediaPicker`) MUST gain the primitive's wiring; this is an accessibility
  improvement and is expected to change their rendered markup.
- **FR-027**: No server action, validation schema, service, database column or stored value MAY change. Every
  form MUST submit the same payload to the same action as it does today.

**Supporting copy**

- **FR-028**: Explanatory, descriptive and helper paragraphs inside the forms on the screens this entry
  touches MUST render at the 12 px caption size in the muted colour that `docs/design-system.md` §4 already
  defines.
- **FR-029**: Labels, control text, and any text a person typed MUST stay at the 14 px body size. No text
  inside a control may shrink, and no text may go below 12 px.
- **FR-030**: No new size, token or scale may be introduced; only the two sizes §4 already defines may be used.
- **FR-031**: The voice screen (`src/app/p/[projectSlug]/voice/`, read in full) MUST be brought fully onto the
  scale first and MUST be the reference the other screens are matched against.
- **FR-032**: The `PageHeader` description convention and table typography MUST NOT change.

**Documentation**

- **FR-033**: `docs/design-system.md` §7 MUST gain a `TextareaField` row in the components table, placed beside
  the `controlStyles` row, naming its props and its floor/ceiling and monospace behaviour.
- **FR-034**: `docs/design-system.md` §4 MUST gain a line recording when the monospace face applies to a text
  field: prompts, instructions and source documents, not post copy or short prose.
- **FR-035**: The `docs/design-system.md` guidance that sends raw `<textarea>` callers to `controlStyles` MUST
  be updated to point at the primitive instead, so the next screen does not hand-roll a fourteenth.
- **FR-036**: Any judgement call made while classifying a field or resolving the `aria-describedby` change
  MUST be appended to `docs/decisions.md`, per the constitution.

**Testing**

- **FR-037**: A component test MUST cover the primitive's label, hint and error wiring, the exact
  `aria-describedby` value it produces, and `aria-invalid` following the presence of `error`.
- **FR-038**: Tests MUST cover the floor, growth past the floor, and the ceiling turning internal scrolling
  back on, exercised through the pure helper of FR-016 since there is no DOM environment.
- **FR-039**: A test MUST assert the monospace option emits the monospace face and that a field without the
  option does not.
- **FR-040**: A test MUST assert that a value present at first render produces a field already sized for that
  value in the server-rendered markup, so the grown height does not depend on a keystroke or on hydration.
- **FR-041**: `src/app/p/[projectSlug]/voice/voice.test.tsx` MUST still assert that each voice field's hint is
  linked through `aria-describedby`. Its line-160 regex expects `aria-describedby="<hintId>"` with the hint id
  alone; adopting `Field`'s contract (FR-002) makes that value `"<hintId> <errorId>"`, so the assertion MUST be
  updated to match the new value while still proving the link. The same file's neighbouring assertion of
  `aria-describedby="x-hint x-error"` MUST keep passing unchanged.
- **FR-042**: The full test suite MUST pass. Because this changes shared styles and introduces a shared
  primitive, failures are expected in screens this entry did not set out to change; those assertions MUST be
  updated to the new markup, not deleted or skipped.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A person reading a saved prompt of any length up to the field's ceiling can read all of it
  without scrolling inside the field — zero internal scrollbars below the ceiling, on all thirteen fields.
- **SC-002**: With a 400-line value pasted into any prompt field, the form's submit control is still reachable
  on a 900 px-tall viewport without the reader having to scroll inside the field to find it.
- **SC-003**: A saved value is shown at its full height on first paint; the number of keystrokes or clicks
  needed before a long saved prompt is fully visible drops from "scroll to read" to zero.
- **SC-004**: Exactly 6 of the 13 fields render in the monospace face and exactly 7 do not, matching the
  classification in FR-018 and FR-019 field for field.
- **SC-005**: All 13 fields are rendered by the one shared primitive; a search of `src/` finds no hand-rolled
  `<textarea>` element outside the primitive and outside test files.
- **SC-006**: Every field exposes a label, a hint when it has one, and an error region, all linked through
  `aria-describedby` — 13 of 13, up from 7 of 13 today.
- **SC-007**: No text on any screen this entry touches renders below 12 px, and no text inside a control is
  smaller than it was before.
- **SC-008**: Every character count and limit shown beside a field reads the same value before and after the
  change — 8 of 8 counters unchanged (6 beside monospace fields, 2 beside proportional ones).
- **SC-009**: Every form still submits the same payload to the same server action: no server action,
  validation schema or service file appears in this entry's diff.
- **SC-010**: `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` all pass.
- **SC-011**: The two private textarea wrappers are gone or reduced to a counter shell, so the
  duplication count drops from 2 divergent wrappers plus 11 bespoke sites to 1 primitive.

## Assumptions

- **Scope of the supporting-copy pass.** "Form-heavy screens" is read as: the twelve files containing the
  thirteen adopted fields, plus `src/app/p/[projectSlug]/voice/` in full (the screen the user named). It is not
  an app-wide typography sweep. Screens outside that set are left alone except where a shared component they
  import changes.
- **`aria-describedby` gains the error id everywhere.** The input says both "match `Field`'s contract exactly"
  and "keep `voice.test.tsx:160` passing". These conflict: `Field` always lists the error id, the current voice
  `Area` does not when there is no error. `Field`'s contract wins, because it is the named authority and
  because the reserved error line is what keeps a form from jumping when an error appears. The consequence is
  recorded as FR-041: that one assertion is updated. This is a genuine change to the attribute's value, not
  merely its order.
- **Floor and ceiling defaults.** The primitive is assumed to default to a small floor (around 3 rows, the most
  common `rows` value at the thirteen sites today) and a ceiling in the region of 20–24 rows — tall enough that
  ordinary prompts never scroll, short enough that a 400-line paste cannot bury the submit control. The exact
  numbers are a planning decision; each adopting site keeps a floor no smaller than its current `rows` so no
  field gets visibly shorter.
- **The monospace face is the one already in the type scale.** `docs/design-system.md` §4's "Code, slugs, keys"
  row is used as-is. No font is added, vendored or fetched, and `globals.css` is not touched.
- **Tailwind 4.3.3 is installed** (verified in `node_modules`) and provides the CSS content-sizing utility, so
  the CSS-first path in FR-014 needs no new dependency.
- **No new dependency is needed and none may be added.** In particular no DOM test library: per
  `docs/decisions.md` P10 and `vitest.config.ts` (`environment: "node"`), the sizing tests go through a pure
  helper and the wiring tests go through `renderToStaticMarkup`, as every other component test in the repo
  does. If planning concludes a DOM environment is genuinely required, that is a `NEEDS DEPENDENCY: jsdom` to
  be raised, not installed — pipeline phases cannot reach the npm registry.
- **`TryItPanel`'s Brief stays proportional** even though it is a brief, like the generation form's Brief which
  becomes monospace. The reason: it is a one-line throwaway input in a sample panel whose output is not saved,
  not a stored prompt. This is the one place where the classification rule and the field's kind pull in
  different directions; the classification in FR-019 is the authority and the reason is recorded here so a
  later review can revisit it rather than treat it as an oversight.
- **Line counts drift.** The line numbers in Context and in FR-018/FR-019 were re-verified against the tree on
  this branch (the input's `Composer.tsx:366`/`:413` are in fact `:369`/`:416`). They are a locator, not a
  contract; the field's label and purpose identify it.
- **Read-only fields are in scope for growth.** The voice editor renders every field read-only for a reader
  without manage rights, and that reader is exactly the person who most needs to see the whole saved prompt.
- **Role and permission behaviour is untouched.** Who may edit what is decided on the server today and is not
  part of this entry.

## Not included

Nothing in this list is owned by a later entry in the UI tweaks roadmap either — it is out of the roadmap, not
merely deferred:

- A markdown preview pane, a split editor, or any rendering of markdown as formatted output. Monospace display
  only.
- Syntax highlighting of markdown or of `{{field}}` placeholders.
- A rich-text editor, CodeMirror, Monaco, or any editor component beyond a native multi-line text field.
- Any change to what a prompt field stores, validates, trims or limits — no schema, no service, no action, no
  column, no limit constant.
- A project-wide font change or any new token in `globals.css`.
- A density or compact-mode preference, or any user-facing typography setting.
- Resizable field handles, drag-to-resize, or a remembered per-field height.
- The `PageHeader` description convention and table typography.

Owned by entry 2 (`week-slot-grid`), and not to be touched here:

- `src/app/p/[projectSlug]/accounts/SlotEditor.tsx`, the posting-slot table on the accounts page, and all slot
  behaviour — beyond the supporting-copy pass of FR-028.
- The slots service (`src/server/services/slots.ts`) and its server actions.
