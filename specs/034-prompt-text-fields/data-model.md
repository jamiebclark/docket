# Phase 1 data model: Auto-growing, monospace prompt and instruction fields

**Feature**: `034-prompt-text-fields` | **Date**: 2026-10-10 | **Spec**: [spec.md](./spec.md)

## No persistent change

There is **no** entity, table, column, migration, index, enum or stored value in this entry. FR-027 and SC-009
forbid it: no server action, validation schema, service or DAL method is touched, and every form submits the
same payload to the same action. `pnpm db:check` is therefore not part of the final pass (see
[quickstart.md](./quickstart.md)).

What follows is the entry's real "model": the primitive's prop contract, the sizing values it derives, and the
two inventories that decide the work — thirteen fields and seven paragraphs. Signatures are in
[contracts/component.md](./contracts/component.md).

---

## 1. `TextareaFieldProps` — the shape every site passes

| Prop | Type | Default | Meaning | Requirement |
|---|---|---|---|---|
| `id` | `string` | — (required) | Owns `${id}-hint`, `${id}-count` and `${id}-error` | FR-002 |
| `label` | `ReactNode` | — (required) | Associated through `htmlFor` | FR-002 |
| `hideLabel` | `boolean` | `false` | Renders the label `sr-only`; the only user is the per-account variant field | R9 |
| `hint` | `ReactNode` | absent | Help paragraph, linked | FR-002 |
| `error` | `string` | absent | Error text; the `aria-live="polite"` line is reserved whether or not it is set | FR-002 |
| `counter` | `ReactNode` | absent | Counter text; the primitive wraps it in `<p id="${id}-count">` between the control and the error, and links the id | FR-021, R7 |
| `counterClassName` | `string` | `"text-right text-xs text-muted-foreground"` | Classes for that paragraph, for the one site whose counter is left-aligned | FR-021 |
| `mono` | `boolean` | `false` | Adds `font-mono`; changes face only, never size | FR-017, FR-021 |
| `minRows` | `number` | `3` | Floor, in rows | FR-006, FR-007 |
| `maxRows` | `number \| null` | `20` | Ceiling, in rows; `null` means no ceiling | FR-006, FR-009 |
| `rowHeightRem` | `number` | `1.25` | One row of the control's own type size; only a field that overrides `text-sm` passes it | R2 |
| `className` | `string` | `""` | Appended after `controlStyles`, as in `Field` | FR-003, FR-004 |
| `ref` | `Ref<HTMLTextAreaElement>` | — | Forwarded to the `<textarea>` | FR-004 |
| …rest | `TextareaHTMLAttributes` | — | `name`, `value`, `defaultValue`, `onChange`, `onBlur`, `required`, `readOnly`, `disabled`, `maxLength`, `placeholder`, `aria-invalid`, … spread **last**, as in `Field` | FR-004, FR-005, R8 |

**Omitted from `rest` deliberately**: `id` (required above) and `rows` (derived from `minRows`; a caller passing
both would be two sources of truth for the floor).

### Derived values, all from the pure helper

| Value | Expression | Why |
|---|---|---|
| `rows` | `minRows` | The floor with no CSS and no script |
| `style.minHeight` | `calc(<minRows × rowHeightRem>rem + 0.875rem + 2px)` | The floor once `field-sizing: content` is in effect |
| `style.maxHeight` | `calc(<maxRows × rowHeightRem>rem + 0.875rem + 2px)`, omitted when `maxRows` is `null` | The ceiling, in CSS, so it holds with scripting unavailable |
| `aria-describedby` | `[hint && "${id}-hint", counter && "${id}-count", "${id}-error"].filter(Boolean).join(" ")` | FR-002; the error id is always present, as in `Field` |
| `aria-invalid` | `error ? true : undefined`, overridable through `rest` | FR-002, R8 |
| class string | `controlStyles` + `field-sizing-content` + `overflow-y-auto` + (`font-mono` when `mono`) + `className` | FR-003, FR-014, FR-017 |

`0.875rem` is `py-[0.4375rem]` doubled and `2px` is the 1 px border doubled, both fixed by `controlStyles`
(`src/components/ui/controls.ts:5`).

### Scripted-fallback state (no CSS `field-sizing`)

| Value | From | Notes |
|---|---|---|
| `scrollHeight` | the element | `0` when the element is not rendered |
| `lineHeightPx` | `getComputedStyle(el).lineHeight` | Falls back to `rowHeightRem × 16` when it reports `normal` |
| `height` | helper output | `null` when `scrollHeight` is `0`, so the CSS floor stands and nothing collapses |
| `overflowY` | helper output | `"auto"` always; the ceiling, not a class switch, is what starts the scrolling |

---

## 2. The thirteen fields

Floors are each site's current `rows` value, so nothing gets shorter (FR-025, spec Assumptions). "Site" is the
`<textarea>` line on this branch; a wrapper row covers every field that renders through it.

| # | Field (rendered label) | Site | rows today | `minRows` | `maxRows` | `mono` | counter | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | Posting instructions for *account* | `accounts/PostingInstructionsForm.tsx:54` | 5 | 5 | 20 | **yes** | yes | Hint id moves `-help` → `-hint` (R8). Passes `aria-invalid` for `tooLong` |
| 2 | Post text | `compose/Composer.tsx:369` | 6 | 6 | **14** | no | no | Keeps `min-h-40 text-base leading-relaxed`; `rowHeightRem: 1.625` (FR-022, R2) |
| 3 | Text for *account* | `compose/Composer.tsx:416` | 4 | 4 | 20 | no | no | Passes `aria-invalid` for over-limit |
| 4 | Brief | `generate/GenerateForm.tsx:71` (wrapper) | 4 | 4 | 20 | **yes** | yes | `required` |
| 5 | Source text | same wrapper | 6 | 6 | 20 | **yes** | yes | Inside a collapsed `<details>` (FR-013) |
| 6 | Instructions for this post | same wrapper | 3 | 3 | 20 | **yes** | yes | |
| 7 | Angle *N* description | `generate/SeriesPlanEditor.tsx:74` | 2 | 2 | **10** | **yes** | no | Repeated per angle; a modest ceiling keeps the list walkable |
| 8 | Extra instruction (optional) | `generate/result/[postId]/RegenerateDialog.tsx:42` | 3 | 3 | **12** | **yes** | yes | In a `Dialog` (FR-013) |
| 9 | *provider*: *accounts* text | `generate/result/[postId]/VariantEditor.tsx:110` | 5 | 5 | 20 | no | yes | `hideLabel` (R9) |
| 10 | Instructions template | `jobs/new/JobForm.tsx:169` | 5 | 5 | 20 | **yes** | yes | `required`, hint, `aria-invalid`, forwarded ref (`insertField` writes into it) |
| 11 | Alt text | `media/MediaEditDialog.tsx:39` | 3 | 3 | **10** | no | no | In a `Dialog` (FR-013) |
| 12 | Reason (optional) | `review/RejectDialog.tsx:45` | 3 | 3 | **10** | no | yes | In a `Dialog` (FR-013) |
| 13 | Brief (Try it) | `voice/TryItPanel.tsx:102` | 3 | 3 | **12** | no | no | `required`. Proportional per FR-019 and the spec's Assumptions |
| 14 | Voice and tone / Audience / Topics and pillars / Avoid | `voice/VoiceEditor.tsx:68` (wrapper) | 3 | 3 | 20 | **yes** | no | Hint each; `readOnly` without manage rights; `maxLength` stays `max × 2` |
| 15 | Example *N* | same wrapper | 3 | 3 | 20 | **yes** | no | **Classification contradiction, kept as specified** — see R12 and FR-020 |
| 16 | Alt text (picker) | `components/media/MediaPicker.tsx:41` | 2 | 2 | **8** | no | no | Label grows `text-xs` → `labelStyles` (allowed; R9) |

Sixteen rows, **thirteen sites**, as the spec counts them: rows 4–6 are one site (`GenerateForm`'s wrapper) and
rows 14–15 are one site (`VoiceEditor`'s wrapper).

**Totals, which are the success criteria**

| Count | Value | Criterion |
|---|---|---|
| Sites rendered by the primitive | 13 of 13 | SC-005 |
| Sites in the monospace face | 6 (1, 4–6, 7, 8, 10, 14–15 → sites 1, GenerateForm, SeriesPlanEditor, RegenerateDialog, JobForm, VoiceEditor) | SC-004 |
| Sites in the proportional face | 7 (Composer ×2, VariantEditor, MediaEditDialog, RejectDialog, TryItPanel, MediaPicker) | SC-004 |
| Counters, all unchanged | 8 — six beside a mono field (1, 4, 5, 6, 8, 10), two beside a proportional one (9, 12) | FR-021, SC-008 |
| Sites with a label, hint-when-present and a linked error region | 13 of 13, up from 7 | SC-006 |
| Fields that gain `aria-describedby` | 6 — sites 2, 3, 7, 11, 13, 16 | FR-026 |

## 3. Two wrappers removed

| Wrapper | Today | After |
|---|---|---|
| `voice/VoiceEditor.tsx:44-81` — `box` + exported `Area` | Its own `rounded-md` chrome, its own hint/error wiring, no error line when there is no error | **Deleted.** Its five call sites pass `TextareaField` props directly, including `mono` and `readOnly`. `voice.test.tsx:165-169` imports `TextareaField` instead; the value it asserts, `aria-describedby="x-hint x-error"`, is unchanged (FR-041) |
| `generate/GenerateForm.tsx:51-86` — `TextArea` | Label, hint, control, counter, all hand-wired | **Reduced to a counter shell**: it keeps its `{ id, label, hint, value, max, rows, required, onChange }` signature, passes `minRows`, `mono` and `counter={…}` to the primitive, and restates no label, hint, error or chrome (FR-024) |

## 4. The seven paragraphs that drop to caption size

Selected by the R13 rule: inside a form or field group, explains a field or group, never typed by the reader.
All move to `text-xs text-muted-foreground` — sizes that `docs/design-system.md:107-119` already defines, so
FR-030 holds.

| # | File:line | Copy | Why it qualifies |
|---|---|---|---|
| 1 | `voice/VoiceEditor.tsx:187` | "Version *N* · Default profile" | Metadata about the profile, named by the spec |
| 2 | `voice/VoiceEditor.tsx:218` | "No examples." | Field-group empty note, named by the spec |
| 3 | `voice/VoiceEditor.tsx:247` | "Per-platform guidance now lives on each account. Edit it on Accounts" | Explains where a field went, named by the spec |
| 4 | `voice/[profileId]/history/page.tsx:80` | "Guidance is now set per account. Go to Accounts" | The same sentence on the same screen; FR-031 reads `voice/` in full |
| 5 | `compose/Composer.tsx:444` | "Choose an account to see what it will receive." | Explains the preview column |
| 6 | `generate/SeriesPlanEditor.tsx:57` | "Edit, reorder, remove or add angles. One post is written for each, in this order." | Explains the angle list |
| 7 | `components/media/MediaPicker.tsx:98` | "No images attached." | Field-level empty note |

### Checked and deliberately left at body size

| What | Where | Why |
|---|---|---|
| Dialog body copy | `RegenerateDialog.tsx:38`, `RejectDialog.tsx:39`, `VoiceEditor.tsx:289` | The message the dialog exists to deliver, not helper text |
| `role="note"` / `role="alert"` / `role="status"` lines | `GenerateForm.tsx:177,277`, `JobForm.tsx:118,217`, `SeriesPlanEditor.tsx:106,111`, `TryItPanel.tsx:94,117`, `VoiceEditor.tsx:154,256`, `ArchivedBanner.tsx:13` | Being loud is their job; shrinking a warning is a regression |
| Values and previews | `JobForm.tsx:197` (`<pre>`), `TryItPanel.tsx:125` (samples), `history/page.tsx:23` (`<dd>`), `Composer.tsx:386`, `MediaPicker.tsx:105` | Generated or typed content (FR-029) |
| Prerequisite and status lines | `MediaPicker.tsx:88,243`, `VariantEditor.tsx:154`, `voice/loading.tsx:5` | A gate, a status or a loading line, not form helper copy |
| Labels, legends, control text | everywhere, incl. `VoiceEditor`'s `Group` legend and `TryItPanel.tsx:81` checkbox labels | FR-029 |
| `PageHeader` descriptions, tables | all screens | FR-032 |
| Already `text-xs` | `PostingInstructionsForm.tsx:64,67`, `GenerateForm.tsx:68,81`, `JobForm.tsx:152,180`, `MediaEditDialog.tsx:58`, `VoiceEditor.tsx:202`, and every other hint and counter | No change needed; they are already on the scale |

## 5. Documentation rows

| File | Change | Requirement |
|---|---|---|
| `docs/design-system.md` §7 | A `TextareaField` row, placed immediately after the `Field`, `Select` row and before the `controlStyles` row, naming `label`, `hint`, `error`, `counter`, `mono`, `minRows`, `maxRows`, `hideLabel` and the floor/ceiling behaviour | FR-033 |
| `docs/design-system.md` §7 | The `controlStyles` row's "For raw `<input>`, `<textarea>`, checkboxes" loses `<textarea>` and gains "use `TextareaField` for multi-line text" | FR-035 |
| `docs/design-system.md` §4 | A line under the type table: the monospace face applies to a text field holding a prompt, an instruction or a source document, not to post copy or short prose | FR-034 |
| `docs/decisions.md` | A `## 034 — …` entry: the classification contradiction (R12), the `-help` → `-hint` id change and the `aria-describedby` error id (R8/FR-041), the supporting-copy rule (R13), and the two accepted visual changes (R14) | FR-036 |
| `.claude/skills/docket-ui/SKILL.md` | `TextareaField` added to the reusable components, with "multi-line text uses `TextareaField`, never a raw `<textarea>`" — recorded as an **Open item (needs a human)** in `docs/decisions.md` if the sandbox refuses the write, as in entries 028, 029 and 033 | FR-036, research Risks |
