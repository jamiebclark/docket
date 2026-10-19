import { describe, expect, it } from "vitest";
import { firstEngagementFigure, type FirstEngagementRow } from "./first-engagement";

const publishedAt = new Date("2026-01-01T10:00:00.000Z");

function row(overrides: Partial<FirstEngagementRow>): FirstEngagementRow {
  return {
    publishedAt,
    exactFirstAt: null,
    boundBeforeAt: null,
    boundAfterAt: null,
    scannedThrough: null,
    frozenReason: null,
    ...overrides,
  };
}

describe("firstEngagementFigure", () => {
  it("prefers an exact inbox figure over everything else", () => {
    const exactFirstAt = new Date(publishedAt.getTime() + 14 * 60_000);
    const figure = firstEngagementFigure(
      row({
        exactFirstAt,
        boundBeforeAt: new Date(publishedAt.getTime() + 2 * 3_600_000),
        boundAfterAt: new Date(publishedAt.getTime() + 3_600_000),
      }),
    );
    expect(figure).toEqual({ kind: "exact", afterMs: 14 * 60_000 });
  });

  it("reports a bound with both ends as an interval, no exact minute", () => {
    const boundAfterAt = new Date(publishedAt.getTime() + 3_600_000);
    const boundBeforeAt = new Date(publishedAt.getTime() + 2 * 3_600_000);
    const figure = firstEngagementFigure(row({ boundBeforeAt, boundAfterAt }));
    expect(figure).toEqual({ kind: "bounded", afterAtLeastMs: 3_600_000, afterAtMostMs: 2 * 3_600_000 });
  });

  it("reports engagement present in the very first reading as an upper bound only", () => {
    const boundBeforeAt = new Date(publishedAt.getTime() + 3_600_000);
    const figure = firstEngagementFigure(row({ boundBeforeAt, boundAfterAt: null }));
    expect(figure).toEqual({ kind: "within_first_reading", afterAtMostMs: 3_600_000 });
  });

  it("reports no engagement yet, as of the watermark, when the target is not frozen", () => {
    const scannedThrough = new Date(publishedAt.getTime() + 5 * 3_600_000);
    const figure = firstEngagementFigure(row({ scannedThrough }));
    expect(figure).toEqual({ kind: "none_yet", asOf: scannedThrough });
  });

  it("reports never observed for a target frozen gone/expired/unqueryable with nothing recorded", () => {
    const scannedThrough = new Date(publishedAt.getTime() + 5 * 3_600_000);
    for (const frozenReason of ["gone", "expired", "unqueryable"] as const) {
      const figure = firstEngagementFigure(row({ scannedThrough, frozenReason }));
      expect(figure).toEqual({ kind: "never_observed", asOf: scannedThrough, frozenReason });
    }
  });

  it("does not report never observed for a 'settled' freeze — that is just not yet found", () => {
    const scannedThrough = new Date(publishedAt.getTime() + 5 * 3_600_000);
    const figure = firstEngagementFigure(row({ scannedThrough, frozenReason: "settled" }));
    expect(figure).toEqual({ kind: "none_yet", asOf: scannedThrough });
  });

  it("reports not examined when nothing has been scanned yet", () => {
    expect(firstEngagementFigure(row({}))).toEqual({ kind: "not_examined" });
  });
});
