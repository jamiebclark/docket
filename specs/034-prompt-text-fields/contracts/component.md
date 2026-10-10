# Contract: `TextareaField` and `textarea-sizing`

**Feature**: `034-prompt-text-fields` | **Date**: 2026-10-10

This is the interface the design system exposes to every screen. Nothing else in the entry is a public
interface: no HTTP endpoint, no CLI, no server action signature and no schema changes (FR-027).

Signatures are the contract; bodies belong to the implement phase.

---

## 1. `src/components/ui/textarea-sizing.ts` — pure, no DOM, no React

Imported by the component and by its test. No `@/server` import, no DOM API, so a `environment: "node"` Vitest
test calls it directly (FR-016, `docs/decisions.md:551`).

```ts
/** One row of a `text-sm` control (Tailwind `--text-sm--line-height`, node_modules/tailwindcss/theme.css:350). */
export const ROW_REM_SM = 1.25;
/** One row of the composer's `text-base leading-relaxed` field (theme.css:351,394). */
export const ROW_REM_COMPOSER = 1.625;
/** `controlStyles` vertical padding (`py-[0.4375rem]` doubled) plus its 1px borders. */
export const CONTROL_CHROME = { padRem: 0.875, borderPx: 2 } as const;

export const DEFAULT_MIN_ROWS = 3;
export const DEFAULT_MAX_ROWS = 20;

export interface RowBounds {
  minRows?: number;
  /** `null` means no ceiling; `undefined` takes DEFAULT_MAX_ROWS. */
  maxRows?: number | null;
  rowHeightRem?: number;
}

export interface SizingStyle {
  /** The `rows` attribute: the floor with no CSS and no script. */
  rows: number;
  /** CSS `min-height`, e.g. "calc(6.25rem + 0.875rem + 2px)". */
  minHeight: string;
  /** CSS `max-height`, or `undefined` when `maxRows` is null. */
  maxHeight?: string;
}

/**
 * Resolve the bounds a caller asked for.
 * - A missing `minRows` becomes DEFAULT_MIN_ROWS; a missing `maxRows` becomes DEFAULT_MAX_ROWS.
 * - `maxRows: null` means no ceiling and survives as `null`.
 * - A floor above the ceiling raises the ceiling to the floor (documented, not an error).
 * - A non-finite or sub-1 `minRows` becomes 1.
 */
export function resolveBounds(b?: RowBounds): {
  minRows: number;
  maxRows: number | null;
  rowHeightRem: number;
};

/** The three server-rendered values. Pure: same input, same output, no measurement. */
export function sizingStyle(b?: RowBounds): SizingStyle;

/** Rows → a CSS length for that many rows plus the control's chrome. */
export function rowsToLength(rows: number, rowHeightRem: number): string;

export interface MeasureInput {
  /** `el.scrollHeight`; 0 when the element is not being rendered. */
  scrollHeight: number;
  /** Computed line height in px; `null` when it reads `normal`. */
  lineHeightPx: number | null;
  /** Assumed root font size for the rem → px conversion. */
  rootPx?: number;
}

export interface Measurement {
  /** px height to assign, or `null` to leave the CSS floor alone (hidden element). */
  height: number | null;
  /** Always "auto": the ceiling, not a class switch, starts the scrolling. */
  overflowY: "auto";
  /** True once the content needs more than the ceiling. For tests and for the ceiling assertion. */
  atCeiling: boolean;
}

/**
 * Clamp a measured content height between the floor and the ceiling.
 * - `scrollHeight` 0 → `{ height: null, atCeiling: false }`: never collapse a hidden field.
 * - content ≤ ceiling → grows to content (`atCeiling` false); the boundary is inclusive.
 * - content > ceiling → stops at the ceiling and `atCeiling` is true.
 * - content < floor → the floor.
 * Uses the same `resolveBounds` as `sizingStyle`, so the CSS path and this path cannot disagree.
 */
export function measureHeight(input: MeasureInput, b?: RowBounds): Measurement;
```

### Invariants a test must hold

| Invariant | Requirement |
|---|---|
| `sizingStyle({ minRows: n }).rows === n` | FR-007 |
| `sizingStyle()` uses rows 3 and ceiling 20 | FR-006 |
| `sizingStyle({ maxRows: null }).maxHeight === undefined` | FR-006, "ceiling absent" edge case |
| `resolveBounds({ minRows: 9, maxRows: 4 }).maxRows === 9` | "floor above ceiling" edge case |
| `measureHeight({ scrollHeight: 0, … }).height === null` | "zero-height measurement" edge case, FR-013 |
| content exactly at the ceiling → `atCeiling === false` | "value at exactly the ceiling" edge case |
| one px more → `atCeiling === true` and the height equals the ceiling | FR-009 |
| content below the floor → the floor | FR-010 |
| `measureHeight` never returns a height above `sizingStyle().maxHeight` | FR-014 |

---

## 2. `src/components/ui/TextareaField.tsx` — `"use client"`

```tsx
export function TextareaField({
  id, label, hideLabel, hint, error, counter,
  counterClassName, mono, minRows, maxRows, rowHeightRem,
  className, ref, ...rest
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id" | "rows"> & {
  id: string;
  label: ReactNode;
  hideLabel?: boolean;
  hint?: ReactNode;
  error?: string;
  /** Counter / limit text between the control and the error line. Gets `${id}-count` and is linked. */
  counter?: ReactNode;
  /** Classes for the counter paragraph; defaults to "text-right text-xs text-muted-foreground". */
  counterClassName?: string;
  mono?: boolean;
  minRows?: number;
  maxRows?: number | null;
  rowHeightRem?: number;
  ref?: Ref<HTMLTextAreaElement>;
}): ReactElement;
```

### Rendered markup contract

In this order, inside `<div className="flex flex-col gap-1.5">` — `Field`'s own wrapper:

1. `<label htmlFor={id}>` with `labelStyles`, or `sr-only` when `hideLabel`;
2. `<p id="${id}-hint" className={hintStyles}>` — only when `hint` is set;
3. `<textarea id={id} rows … style={{ minHeight, maxHeight }} …>`;
4. `<p id="${id}-count" className={counterClassName ?? "text-right text-xs text-muted-foreground"}>{counter}</p>`
   — only when `counter` is set. The primitive owns the paragraph and its id; `counter` is the text inside it, so
   a caller never nests a `<p>` in a `<p>`. A site whose counter is coloured or aligned differently today passes
   `counterClassName` (only `PostingInstructionsForm`, which is left-aligned);
5. `<p id="${id}-error" aria-live="polite" className={errorStyles}>` — **always**, so the line is reserved.

### Attribute contract

| Attribute | Value |
|---|---|
| `aria-describedby` | `"${id}-hint"` when `hint`, then `"${id}-count"` when `counter`, then always `"${id}-error"`, space-joined |
| `aria-invalid` | `true` when `error`, otherwise absent; a caller-supplied `aria-invalid` in `...rest` wins (spread order, as `Field`) |
| `rows` | `resolveBounds(...).minRows` |
| `style` | `minHeight`, and `maxHeight` unless `maxRows` is `null` |
| `class` | `controlStyles`, then `field-sizing-content overflow-y-auto`, then `font-mono` when `mono`, then `className` |

### Behaviour contract

| Rule | Requirement |
|---|---|
| Works controlled (`value` + `onChange`) and uncontrolled (`defaultValue`), and sizes in both | FR-005 |
| Passes `name`, `value`, `defaultValue`, `onChange`, `onBlur`, `required`, `readOnly`, `disabled`, `maxLength`, `placeholder` and the ref through untouched | FR-004 |
| With `field-sizing: content` supported, the component never writes `style.height` | FR-014, R4 |
| Without it, a layout effect, an `onInput` handler and a one-shot `ResizeObserver` each re-measure through `measureHeight` | FR-011, FR-012, FR-013 |
| A caller's `onInput` still runs; the primitive's handler calls it | FR-004 |
| `mono` changes the face only; the field stays `text-sm` from `controlStyles`, and the counter is never mono | FR-021 |
| No scripting: the `rows` attribute, `min-height` and `max-height` are all in the server-rendered markup | FR-015, FR-040 |

### Consumer contract (what the thirteen sites may rely on)

- Passing `counter` is the only supported way to put a counter under the control. Rendering one after the
  component puts it below the reserved error line and changes its position, which FR-021 forbids.
- Passing `aria-describedby` is **not** supported: it would replace the primitive's wiring. No site does.
- Passing `rows` is a type error; pass `minRows`.
- A field that overrides the control's type size must pass the matching `rowHeightRem` or its ceiling will be
  wrong. Only the composer's post text does (`ROW_REM_COMPOSER`).

---

## 3. `GenerateForm`'s local `TextArea` — reduced, not removed

Its signature is unchanged, so its three call sites do not move (FR-024):

```tsx
function TextArea(props: {
  id: string; label: string; hint: string; value: string;
  max: number; rows: number; required?: boolean;
  onChange: (v: string) => void;
}): ReactElement;
```

It now renders exactly one `TextareaField` with `minRows={props.rows}`, `mono`, `name={props.id}` and
`counter={counterLabel(props.value.length, props.max)}` with `counterClassName` carrying its over-limit colour, and declares no label, hint,
error or chrome of its own. `VoiceEditor`'s `Area` has no equivalent and is deleted.
