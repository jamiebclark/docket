# Quickstart: validating auto-growing, monospace prompt fields

**Feature**: `034-prompt-text-fields` | **Date**: 2026-10-10

How to prove this entry works. Constitution principle II applies: nothing below may be reported as working
unless the command ran and passed, and anything that could not run is reported as not run.

## Prerequisites

| Need | Why | Check |
|---|---|---|
| Node 24 LTS, pnpm, dependencies installed | the repo's stack | `node -v`, `pnpm -v` |
| Postgres reachable | `tests/setup/global-setup.ts` clones a database per Vitest worker | `docker compose up -d postgres`, or `DATABASE_URL` pointing at Neon |
| **No new dependency** | FR-016 and spec Assumptions: the sizing tests go through a pure helper, so no DOM library is needed | `git diff package.json` must be empty |

The unit tests for the pure helper and the component markup need no database, but `pnpm test` runs the whole
suite and does. Run a single file with `pnpm vitest run <path>`.

## 1. The pure sizing helper — no DOM, no database

```bash
pnpm vitest run src/components/ui/textarea-sizing.test.ts
```

Proves, per the invariant table in [contracts/component.md](./contracts/component.md) §1:

| Expected | Spec |
|---|---|
| default floor 3 rows, default ceiling 20 rows | FR-006 |
| `rows` equals `minRows`, and a floor of *n* yields a `min-height` of *n* rows plus the control's chrome | FR-007 |
| content between the floor and the ceiling returns that content's height | FR-008 |
| content one px past the ceiling returns the ceiling height and `atCeiling` true | FR-009 |
| content at exactly the ceiling returns `atCeiling` false | "value at exactly the ceiling" edge case |
| content below the floor returns the floor | FR-010 |
| `scrollHeight: 0` returns `height: null` | "zero-height measurement" edge case, FR-013 |
| `maxRows: null` yields no `max-height` | "ceiling absent" edge case |
| `minRows: 9, maxRows: 4` yields a ceiling of 9 | "floor above ceiling" edge case |
| a `rowHeightRem` of 1.625 scales both bounds | FR-022 |

## 2. The primitive's markup

```bash
pnpm vitest run src/components/ui/TextareaField.test.tsx
```

Rendered with `renderToStaticMarkup`, as every component test in this repo is
(`src/components/ui/SetupNotice.test.tsx:13`). Expected:

| Expected | Spec |
|---|---|
| `<label for="x">` with `labelStyles`; `sr-only` when `hideLabel` | FR-002, R9 |
| a hint only when `hint` is set, at `${id}-hint` | FR-002 |
| `aria-describedby="x-error"` with no hint and no counter; `"x-hint x-error"` with a hint; `"x-hint x-count x-error"` with both | FR-002, FR-037 |
| the `aria-live="polite"` error paragraph present with and without an `error` | FR-002 |
| `aria-invalid="true"` only when `error` is set, and a caller's `aria-invalid` winning over it | FR-002, R8 |
| the counter paragraph between the control and the error, with id `${id}-count` | FR-021, R7 |
| `font-mono` with `mono`, and absent without it | FR-039 |
| `controlStyles`' own classes present and not restated | FR-003 |
| `rows`, `min-height` and `max-height` all in the markup for a field given a long `defaultValue`, so the grown height needs no keystroke and no hydration | **FR-040** |
| `field-sizing-content` present | FR-014 |
| `name`, `maxLength`, `required`, `readOnly`, `placeholder` passed through | FR-004 |

**On FR-040**: the server-rendered markup cannot carry a measured pixel height — measuring text needs a DOM, and
there is none (`vitest.config.ts`, `environment: "node"`). What the test proves is the thing FR-040 is after:
the sizing contract is entirely in the first paint — the `rows` floor, the `min-height`, the `max-height` and
`field-sizing-content` — so a saved value is at its full height before any script runs. The pixel height itself
is the browser's job and is confirmed in §6.

## 3. The screens that already have tests

```bash
pnpm vitest run "src/app/p/[projectSlug]/voice/voice.test.tsx"
pnpm vitest run src/app/p/\[projectSlug\]/ui-conventions.test.ts
pnpm vitest run tests/integration/accounts-ui.test.ts
```

| Expected | Spec |
|---|---|
| `voice.test.tsx` hint test passes with `aria-describedby="…-hint …-error"` — updated on purpose, still proving the link | **FR-041** |
| `voice.test.tsx`'s field-error test imports `TextareaField` instead of the deleted `Area`, and still asserts `aria-describedby="x-hint x-error"` unchanged | FR-041, FR-024 |
| `ui-conventions.test.ts` still passes: it finds no raw `<textarea>` in those files and every remaining control is still labelled | SC-005 |
| `accounts-ui.test.ts:235` still finds `<textarea` (the primitive renders one) and `:302` still finds none in the read-only view | FR-025 |

## 4. No hand-rolled textarea is left

```bash
grep -rn "<textarea" src/ --include=*.tsx | grep -v "src/components/ui/TextareaField.tsx"
```

Expected: **no output** (SC-005). Test files are excluded by the glob; if one needs a raw element, it is listed
here with a reason.

## 5. The full suite — once, at the end

Per the constitution's "run checks in proportion to the change", once per implement phase:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

| Expected | Spec |
|---|---|
| all four pass | SC-010 |
| `pnpm db:check` is **not** run: no schema change | FR-027, SC-009 |
| any failure in a screen this entry did not set out to change is fixed by updating the assertion to the new markup, never by deleting or skipping it | **FR-042** |

And the diff itself is a check:

```bash
git diff --name-only origin/main...HEAD
```

Expected: no file under `src/server/`, no `actions.ts`, no `src/lib/validation/`, no migration, no
`package.json`, no `src/app/globals.css`, and nothing under `accounts/SlotEditor.tsx` (SC-009, spec
"Not included").

## 6. Browser walk-through — the part only a browser can prove

`pnpm dev`, then sign in to a project with one account and one voice profile. Report each line as pass, fail or
**not run**; do not report a pass that was not seen.

| Step | Expected | Spec |
|---|---|---|
| Brand voice → a profile. Type a paragraph into "Voice and tone" | the box grows line by line, no inner scrollbar | US1 ✓1–2, FR-008 |
| Paste 400 lines into it | it stops at its ceiling, scrolls inside from there, and **Save** is still on screen | US1 ✓3, SC-002 |
| Delete most of it | it shrinks back toward three rows | FR-010 |
| Reload the page on a long saved value | it is already at its full height before you touch it | US1 ✓4, SC-003 |
| Accounts → Posting instructions, with a long saved value | same, and the `n / 2,000` counter reads the same number as before the change | US1 ✓4, SC-008 |
| Generate → open "Add source text" | the field is at the height its value needs, not zero and not stuck at the floor | FR-013 |
| Generate → result → Regenerate…, open the dialog | same, in a `Dialog` | US1 ✓6, FR-013 |
| Look at Posting instructions, the three generation fields, Angle descriptions, the jobs template and the voice fields | monospace: list markers and `{{field}}` placeholders line up | US2 ✓1 |
| Look at Post text, both alt texts, the reject reason, the variant text and Try it's brief | proportional, and Post text is still the larger composer size | US2 ✓2, ✓4, FR-022 |
| Open the voice editor as an editor without manage rights | every field is read-only **and** at its full saved height | "read-only" edge case |
| Read the voice screen | explanatory lines are caption-size and muted; labels and typed text are body size; nothing is smaller than 12 px | US3 ✓1–2, SC-007 |
| Tab through each changed form | visible focus on every field, hint and error announced, tab order unchanged | constitution accessibility |
| At 390 px width | no sideways scroll on any changed screen | `docs/design-system.md` §12 |
| With JavaScript disabled | every field is at least its floor, never past its ceiling, and still typable | FR-015 |

**If a browser is not available in this environment**, say so plainly: the §1–§5 commands are what ran, and the
rows above are reported as not run rather than assumed. The CSS growth path in particular cannot be proven by a
node test.

## What "done" means

- §1–§4 pass per file, as each task lands.
- §5 passes once, at the end of implement.
- §6 is run if a browser is available, and reported honestly either way.
- `docs/design-system.md` §4 and §7 and `docs/decisions.md` carry the new rows (FR-033–FR-036), and the
  `docket-ui` skill edit is either made or recorded as an Open item.
