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
} {
  const rawMinRows = b?.minRows ?? DEFAULT_MIN_ROWS;
  const minRows = Number.isFinite(rawMinRows) && rawMinRows >= 1 ? rawMinRows : 1;
  const rawMaxRows = b?.maxRows === undefined ? DEFAULT_MAX_ROWS : b.maxRows;
  const maxRows = rawMaxRows === null ? null : Math.max(minRows, rawMaxRows);
  const rowHeightRem = b?.rowHeightRem ?? ROW_REM_SM;
  return { minRows, maxRows, rowHeightRem };
}

/** Rows → a CSS length for that many rows plus the control's chrome. */
export function rowsToLength(rows: number, rowHeightRem: number): string {
  return `calc(${rows * rowHeightRem}rem + ${CONTROL_CHROME.padRem}rem + ${CONTROL_CHROME.borderPx}px)`;
}

/** The three server-rendered values. Pure: same input, same output, no measurement. */
export function sizingStyle(b?: RowBounds): SizingStyle {
  const { minRows, maxRows, rowHeightRem } = resolveBounds(b);
  return {
    rows: minRows,
    minHeight: rowsToLength(minRows, rowHeightRem),
    maxHeight: maxRows === null ? undefined : rowsToLength(maxRows, rowHeightRem),
  };
}

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
export function measureHeight(input: MeasureInput, b?: RowBounds): Measurement {
  if (input.scrollHeight === 0) {
    return { height: null, overflowY: "auto", atCeiling: false };
  }
  const { minRows, maxRows, rowHeightRem } = resolveBounds(b);
  const rootPx = input.rootPx ?? 16;
  const lineHeightPx = input.lineHeightPx ?? rowHeightRem * rootPx;
  const chromePx = CONTROL_CHROME.padRem * rootPx + CONTROL_CHROME.borderPx;
  const floorPx = minRows * lineHeightPx + chromePx;
  const ceilingPx = maxRows === null ? null : maxRows * lineHeightPx + chromePx;

  let height = Math.max(input.scrollHeight, floorPx);
  let atCeiling = false;
  if (ceilingPx !== null && height > ceilingPx) {
    height = ceilingPx;
    atCeiling = true;
  }
  return { height, overflowY: "auto", atCeiling };
}
