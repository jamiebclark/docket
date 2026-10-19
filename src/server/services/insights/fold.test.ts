import { describe, expect, it } from "vitest";
import { foldRows, type FoldableSnapshotRow, type ShapeFor } from "./fold";

const shapeFor: ShapeFor = (_providerKey, _surface, metricKey) =>
  metricKey === "weird" ? { kind: "unknown", reason: "test" } : { kind: "cumulative" };

const row = (overrides: Partial<FoldableSnapshotRow>): FoldableSnapshotRow => ({
  subjectId: "acct-1",
  providerKey: "mock",
  capturedAt: new Date("2026-01-01T00:00:00.000Z"),
  metrics: { likeCount: 1 },
  ...overrides,
});

describe("foldRows (contracts/fold.md §2-§3)", () => {
  it("keeps the newest reading per (subject, metric key, UTC day), regardless of input order", () => {
    const rows = [
      row({ capturedAt: new Date("2026-01-01T01:00:00.000Z"), metrics: { likeCount: 5 } }),
      row({ capturedAt: new Date("2026-01-01T23:00:00.000Z"), metrics: { likeCount: 9 } }),
      row({ capturedAt: new Date("2026-01-01T12:00:00.000Z"), metrics: { likeCount: 7 } }),
    ];
    const points = foldRows(rows, "account", shapeFor);
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ metricKey: "likeCount", value: 9, capturedDay: "2026-01-01", kind: "cumulative" });
  });

  it("produces one point per distinct subject, metric key and UTC day", () => {
    const rows = [
      row({ subjectId: "acct-1", capturedAt: new Date("2026-01-01T00:00:00.000Z"), metrics: { likeCount: 1, replyCount: 2 } }),
      row({ subjectId: "acct-2", capturedAt: new Date("2026-01-01T00:00:00.000Z"), metrics: { likeCount: 3 } }),
      row({ subjectId: "acct-1", capturedAt: new Date("2026-01-02T00:00:00.000Z"), metrics: { likeCount: 4 } }),
    ];
    const points = foldRows(rows, "account", shapeFor);
    expect(points).toHaveLength(4);
  });

  it("tags each point with the metric's shape at fold time", () => {
    const points = foldRows([row({ metrics: { weird: 1 } })], "account", shapeFor);
    expect(points[0]!.kind).toBe("unknown");
  });

  it("ignores a non-number metric value", () => {
    const points = foldRows([row({ metrics: { likeCount: "nope" as unknown as number, replyCount: 2 } })], "account", shapeFor);
    expect(points).toHaveLength(1);
    expect(points[0]!.metricKey).toBe("replyCount");
  });

  it("buckets by UTC day, not local day", () => {
    const points = foldRows([row({ capturedAt: new Date("2026-01-01T23:59:59.999Z") })], "account", shapeFor);
    expect(points[0]!.capturedDay).toBe("2026-01-01");
  });

  it("is a no-op on an empty batch", () => {
    expect(foldRows([], "account", shapeFor)).toEqual([]);
  });
});
