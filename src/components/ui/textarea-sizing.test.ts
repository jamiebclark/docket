import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_ROWS,
  DEFAULT_MIN_ROWS,
  measureHeight,
  resolveBounds,
  ROW_REM_COMPOSER,
  rowsToLength,
  sizingStyle,
} from "./textarea-sizing";

describe("resolveBounds", () => {
  it("defaults to 3 rows floor and 20 rows ceiling", () => {
    expect(resolveBounds()).toEqual({ minRows: DEFAULT_MIN_ROWS, maxRows: DEFAULT_MAX_ROWS, rowHeightRem: 1.25 });
  });
  it("raises a ceiling below the floor to the floor", () => {
    expect(resolveBounds({ minRows: 9, maxRows: 4 }).maxRows).toBe(9);
  });
  it("keeps maxRows: null as no ceiling", () => {
    expect(resolveBounds({ maxRows: null }).maxRows).toBeNull();
  });
});

describe("sizingStyle", () => {
  it("echoes minRows as rows", () => {
    expect(sizingStyle({ minRows: 6 }).rows).toBe(6);
  });
  it("uses the defaults with no bounds given", () => {
    const s = sizingStyle();
    expect(s.rows).toBe(DEFAULT_MIN_ROWS);
    expect(s.maxHeight).toBe(rowsToLength(DEFAULT_MAX_ROWS, 1.25));
  });
  it("omits max-height when maxRows is null", () => {
    expect(sizingStyle({ maxRows: null }).maxHeight).toBeUndefined();
  });
  it("scales both bounds with a custom rowHeightRem", () => {
    const s = sizingStyle({ minRows: 6, maxRows: 14, rowHeightRem: ROW_REM_COMPOSER });
    expect(s.minHeight).toBe(rowsToLength(6, ROW_REM_COMPOSER));
    expect(s.maxHeight).toBe(rowsToLength(14, ROW_REM_COMPOSER));
  });
});

describe("measureHeight", () => {
  const bounds = { minRows: 3, maxRows: 20 };

  it("never collapses a hidden field (scrollHeight: 0)", () => {
    expect(measureHeight({ scrollHeight: 0, lineHeightPx: 20 }, bounds)).toEqual({
      height: null,
      overflowY: "auto",
      atCeiling: false,
    });
  });

  it("grows to content between the floor and the ceiling", () => {
    const result = measureHeight({ scrollHeight: 150, lineHeightPx: 20 }, bounds);
    expect(result.height).toBe(150);
    expect(result.atCeiling).toBe(false);
  });

  it("returns the floor when content is below it", () => {
    const result = measureHeight({ scrollHeight: 10, lineHeightPx: 20 }, bounds);
    const floor = 3 * 20 + 0.875 * 16 + 2;
    expect(result.height).toBe(floor);
    expect(result.atCeiling).toBe(false);
  });

  it("is not at the ceiling when content lands exactly on it", () => {
    const ceiling = 20 * 20 + 0.875 * 16 + 2;
    const result = measureHeight({ scrollHeight: ceiling, lineHeightPx: 20 }, bounds);
    expect(result.height).toBe(ceiling);
    expect(result.atCeiling).toBe(false);
  });

  it("clamps to the ceiling and reports atCeiling once content exceeds it by one px", () => {
    const ceiling = 20 * 20 + 0.875 * 16 + 2;
    const result = measureHeight({ scrollHeight: ceiling + 1, lineHeightPx: 20 }, bounds);
    expect(result.height).toBe(ceiling);
    expect(result.atCeiling).toBe(true);
  });

  it("never returns a height above sizingStyle's max-height", () => {
    const style = sizingStyle(bounds);
    const ceilingPx = 20 * 20 + 0.875 * 16 + 2;
    expect(style.maxHeight).toBe(rowsToLength(20, 1.25));
    const result = measureHeight({ scrollHeight: 100000, lineHeightPx: 20 }, bounds);
    expect(result.height).toBeLessThanOrEqual(ceilingPx);
  });

  it("falls back to rowHeightRem × 16 when lineHeightPx is null, matching the composer's row height", () => {
    const result = measureHeight({ scrollHeight: 0, lineHeightPx: null }, { rowHeightRem: ROW_REM_COMPOSER });
    expect(result).toEqual({ height: null, overflowY: "auto", atCeiling: false });
    const grown = measureHeight({ scrollHeight: 10000, lineHeightPx: null }, { rowHeightRem: ROW_REM_COMPOSER, maxRows: null });
    expect(grown.height).toBe(10000);
  });
});
