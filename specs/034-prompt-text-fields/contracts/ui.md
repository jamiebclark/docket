# Contract: screens, copy and keyboard behaviour

**Feature**: `034-prompt-text-fields` | **Date**: 2026-10-10

What a reader sees after this entry, screen by screen. Every row is presentation: no copy is invented, no form
submits anything different, and no role check moves (FR-025, FR-027). Per-field floors, ceilings and `mono` are
in [data-model.md](./data-model.md) §2; the paragraph changes are §4.

## Every adopted field, after the change

| Aspect | Before | After |
|---|---|---|
| Height when empty | a guessed `rows` | the same number of rows, now a documented floor |
| Height with a long value | five rows and an inner scrollbar | grows to the content up to the ceiling, then scrolls |
| Height of a saved value on first paint | the floor | the content's height, with no keystroke and no hydration |
| Label | hand-written per site, `text-sm font-medium` or `text-xs` or `sr-only` | `labelStyles` from the primitive; `sr-only` only where `hideLabel` is passed |
| Hint | present at 7 of 13 sites, wired three different ways | unchanged copy, one wiring |
| Error | present at 3 sites, two of them only when set | a reserved `min-h-4` `aria-live="polite"` line at all 13 |
| Counter | 8 sites, caller-owned `<p>` | same text, same place, same limit; the id comes from the primitive |
| Chrome | `controlStyles` at 11 sites, a private `rounded-md` box at the voice fields | `controlStyles` at 13 |
| Face | proportional everywhere | monospace at the 6 prompt/instruction/source sites |

## Screen notes

| Screen | What changes | What must not change |
|---|---|---|
| **Accounts** → posting instructions | Mono; grows; hint id `-help` → `-hint`; the counter keeps its left alignment through `counterClassName` | The `12 / 2,000` text and its over-limit colouring; the `Save` button; the `LiveRegion` "Saved." / "No changes."; the read-only `whitespace-pre-wrap` paragraph for an editor, which has no textarea at all (`accounts-ui.test.ts:302`); the posting-slot table and `SlotEditor`, which belong to entry 2 |
| **Compose** | Both fields grow and gain a linked error line; the post text keeps `text-base leading-relaxed min-h-40`; "Choose an account to see what it will receive." drops to caption size | Neither field becomes monospace (FR-022); the per-account `<details>` and its Clear button; the over-limit `aria-invalid` |
| **Generate** | Brief, Source text and Instructions are mono and grow; the private `TextArea` becomes a counter shell; Source text inside the collapsed `<details>` reaches its height when opened | The three hints and counters word for word; `required` on Brief; the `role="note"` warnings at body size; the sticky `ActionBar` |
| **Generate → series plan** | Angle descriptions are mono and grow; the list intro drops to caption size | Angle titles stay a single-line `Field`; the move/remove buttons; `DESCRIPTION_MAX` |
| **Generate → result** | Regenerate's extra instruction is mono and sized at its current value when the dialog first opens; the per-account variant keeps its hidden label through `hideLabel` | Both counters; the Regenerate button's disabled rule; the variant issue lists |
| **Batch jobs → new** | The instructions template is mono and grows; the forwarded ref keeps `insertField` inserting at the caret | The field-chip row, the hint, the counter, the unknown-field and empty-value notes, the preview `<pre>` |
| **Media** → edit dialog, and the picker's alt text | Both grow and gain a linked error line; the picker's label grows from `text-xs` to `text-sm`; "No images attached." drops to caption size | Neither becomes monospace; `maxLength={2000}`; the picker's `onBlur` save and its `aria-live` "Saved" line |
| **Review** → reject dialog | The reason grows and is sized when the dialog opens | Not monospace; the counter; the dialog's own body copy at body size |
| **Brand voice** → editor | All five field kinds are mono, grow, and get the shared chrome and a reserved error line; `Area` is gone; the three named paragraphs drop to caption size | Every hint word for word; `readOnly` for a reader without manage rights, which still shows the whole saved value at its grown height; `maxLength` `FIELD_MAX × 2`; the Save / Make default / Archive row; the conflict banner |
| **Brand voice** → Try it | The brief grows and gains a linked error line | It stays proportional (FR-019); `required`; the generated samples stay at body size |
| **Brand voice** → history | "Guidance is now set per account." drops to caption size | The version table, the `<dd>` saved values at body size, the `PageHeader` description |

## Keyboard and accessibility

| Rule | How |
|---|---|
| Every field has a programmatic name | `<label htmlFor>` at 13 of 13, `sr-only` only where it already was |
| Every hint and error is announced | one `aria-describedby`, one `aria-live="polite"` region, from the primitive |
| Tab order is unchanged | the markup order is label, hint, control, counter, error — no focusable element is added |
| Focus is visible | `controlStyles`' `focus-visible:ring-2` now applies at the voice fields too, which had their own weaker ring |
| Nothing is conveyed by colour alone | the counter still spells out "`n / limit`" and "too long"; `aria-invalid` carries the invalid state |
| No scripting | the floor, the ceiling and every label and hint are in the server-rendered markup |
| Nothing below 12 px, nothing in a control shrinks | the only size changes are `text-sm` → `text-xs` on seven paragraphs, and one label `text-xs` → `text-sm` |

## Out of contract

`accounts/SlotEditor.tsx`, the posting-slot table, `src/server/services/slots.ts` and its actions are entry 2's
(spec "Not included"). None holds a textarea, and none holds a paragraph the supporting-copy rule selects, so
this entry does not touch them at all.
