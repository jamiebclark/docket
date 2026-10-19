import { describe, expect, it } from "vitest";
import { compare, type ComparableRow, type Dimension } from "./compare";

const ZONE = "America/New_York";
const RANGE = { from: new Date("2026-01-01T00:00:00Z"), to: new Date("2026-02-01T00:00:00Z") };

let seq = 0;
function row(overrides: Partial<ComparableRow> = {}): ComparableRow {
  seq++;
  return {
    targetId: `t${seq}`,
    postId: `p${seq}`,
    accountId: "acct-1",
    accountName: "Account One",
    providerKey: "bluesky",
    platform: "Bluesky",
    metricKey: "likeCount",
    metricShapeKnown: true,
    scheduleKind: "slot",
    slotOccurrenceAt: new Date("2026-01-05T14:00:00Z"), // Monday 09:00 America/New_York
    slotLabel: { id: "slot-1", recordedName: "Morning slot", liveName: "Morning slot" },
    publishedAt: new Date("2026-01-05T14:00:00Z"),
    origin: "manual",
    voiceProfile: null,
    seriesKind: null,
    externalId: "ext-1",
    frozenWithoutReading: false,
    value: 10,
    capturedAt: new Date("2026-01-05T15:00:00Z"),
    ...overrides,
  };
}

function groupOf(rows: ComparableRow[], dimension: Dimension = "slot") {
  return compare({ rows, timeZone: ZONE, range: RANGE, dimension });
}

describe("compare: the floor", () => {
  it.each([3, 4, 7, 8])("draws the right verdict at sample size %i", (n) => {
    const rows = Array.from({ length: n }, () => row({ slotOccurrenceAt: new Date("2026-01-05T14:00:00Z") }));
    const result = groupOf(rows);
    if (n < 4) {
      expect(result.groups).toHaveLength(0);
      expect(result.suppressedGroupCount).toBe(1);
    } else if (n < 8) {
      expect(result.groups).toHaveLength(1);
      expect(result.groups[0]!.verdict).toBe("provisional");
    } else {
      expect(result.groups).toHaveLength(1);
      expect(result.groups[0]!.verdict).toBe("ranked");
    }
  });
});

describe("compare: ranking needs two groups", () => {
  it("below 8 in every group: no ranking, no superlative, label order", () => {
    const rows = [
      ...Array.from({ length: 5 }, () => row({ slotOccurrenceAt: new Date("2026-01-05T14:00:00Z") })), // Mon
      ...Array.from({ length: 6 }, () => row({ slotOccurrenceAt: new Date("2026-01-06T14:00:00Z") })), // Tue
    ];
    const result = groupOf(rows, "day_of_week");
    expect(result.conclusion).toBe("not_enough_posts");
    const labels = result.groups.map((g) => g.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
  });

  it("exactly one group above the floor draws no comparison", () => {
    const rows = [
      ...Array.from({ length: 10 }, () => row({ slotOccurrenceAt: new Date("2026-01-05T14:00:00Z") })), // Mon, ranked
      ...Array.from({ length: 5 }, () => row({ slotOccurrenceAt: new Date("2026-01-06T14:00:00Z") })), // Tue, provisional
    ];
    const result = groupOf(rows, "day_of_week");
    expect(result.conclusion).toBe("not_enough_posts");
    expect(result.groups.find((g) => g.label === "Monday")?.sampleSize).toBe(10);
  });

  it("ranks when two groups reach the floor", () => {
    const rows = [
      ...Array.from({ length: 8 }, () => row({ slotOccurrenceAt: new Date("2026-01-05T14:00:00Z"), value: 100 })),
      ...Array.from({ length: 8 }, () => row({ slotOccurrenceAt: new Date("2026-01-06T14:00:00Z"), value: 10 })),
    ];
    const result = groupOf(rows, "day_of_week");
    expect(result.conclusion).toBe("ranked");
    expect(result.groups[0]!.label).toBe("Monday");
  });
});

describe("compare: exclusions, counted and never zeros", () => {
  it("counts each of the six reasons with no zero-valued post", () => {
    const rows = [
      row({ externalId: null }),
      row({ value: null, frozenWithoutReading: false }),
      row({ scheduleKind: "explicit", slotOccurrenceAt: null }),
      row({ value: null, frozenWithoutReading: true }),
      row({ seriesKind: null }),
      row({ metricShapeKnown: false }),
    ];
    const result = compare({ rows, timeZone: ZONE, range: RANGE, dimension: "slot" });
    const reasons = new Set(result.exclusions.map((e) => e.reason));
    expect(reasons.has("no_external_id")).toBe(true);
    expect(reasons.has("no_snapshot")).toBe(true);
    expect(reasons.has("not_slot_scheduled")).toBe(true);
    expect(reasons.has("frozen_without_reading")).toBe(true);
    expect(reasons.has("metric_shape_unknown")).toBe(true);
    for (const e of result.exclusions) expect(e.count).toBeGreaterThan(0);
    expect(result.groups.every((g) => g.mean !== 0)).toBe(true);
  });
});

describe("compare: removed labels", () => {
  it("keeps a deleted slot comparable under 'removed'", () => {
    const rows = Array.from({ length: 4 }, () => row({ slotLabel: null }));
    const result = groupOf(rows, "slot");
    expect(result.groups[0]!.removed).toBe(true);
    expect(result.groups[0]!.label).toContain("(removed)");
  });

  it("keeps a deleted voice profile comparable under 'removed', using the recorded name", () => {
    const rows = Array.from({ length: 4 }, () =>
      row({ voiceProfile: { id: "vp-1", recordedName: "Old Voice", liveName: null } }),
    );
    const result = groupOf(rows, "voice_profile");
    expect(result.groups[0]!.removed).toBe(true);
    expect(result.groups[0]!.label).toBe("Old Voice (removed)");
  });

  it("uses the current name for a live voice profile, not the recorded one", () => {
    const rows = Array.from({ length: 4 }, () =>
      row({ voiceProfile: { id: "vp-1", recordedName: "Old Name", liveName: "New Name" } }),
    );
    const result = groupOf(rows, "voice_profile");
    expect(result.groups[0]!.removed).toBe(false);
    expect(result.groups[0]!.label).toBe("New Name");
  });

  it("keeps a deleted series comparable under 'removed'", () => {
    const rows = Array.from({ length: 4 }, () =>
      row({ seriesKind: { id: "s-1", occurrenceRule: "cadence", recordedName: "Old Series", liveName: null } }),
    );
    const result = groupOf(rows, "series_kind");
    expect(result.groups[0]!.removed).toBe(true);
    expect(result.groups[0]!.label).toBe("Evergreen (removed)");
  });
});

describe("compare: explicit/now and slot vs day_of_week", () => {
  it("excludes explicit/now from slot, with a count", () => {
    const rows = Array.from({ length: 4 }, () => row({ scheduleKind: "explicit", slotOccurrenceAt: null }));
    const result = groupOf(rows, "slot");
    expect(result.groups).toHaveLength(0);
    expect(result.exclusions.find((e) => e.reason === "not_slot_scheduled")?.count).toBe(4);
  });

  it("includes explicit/now in day_of_week, grouped by published time", () => {
    const rows = Array.from({ length: 4 }, () =>
      row({ scheduleKind: "now", slotOccurrenceAt: null, publishedAt: new Date("2026-01-05T14:00:00Z") }),
    );
    const result = groupOf(rows, "day_of_week");
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.label).toBe("Monday");
  });
});

describe("compare: DST and time zone", () => {
  it("buckets a 09:00 slot occurrence to its correct local weekday either side of a DST change", () => {
    // 2026-03-08 is the US spring-forward Sunday; 09:00 America/New_York before and after.
    const rows = [
      row({ slotOccurrenceAt: new Date("2026-03-01T14:00:00Z") }), // Sun 09:00 EST
      row({ slotOccurrenceAt: new Date("2026-03-01T14:00:00Z") }),
      row({ slotOccurrenceAt: new Date("2026-03-15T13:00:00Z") }), // Sun 09:00 EDT
      row({ slotOccurrenceAt: new Date("2026-03-15T13:00:00Z") }),
    ];
    const result = compare({ rows, timeZone: ZONE, range: RANGE, dimension: "day_of_week" });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.label).toBe("Sunday");
  });

  it("re-buckets when the time zone changes", () => {
    const rows = Array.from({ length: 4 }, () => row({ slotOccurrenceAt: new Date("2026-01-05T23:30:00Z") })); // Mon 23:30 UTC
    const inET = compare({ rows, timeZone: "America/New_York", range: RANGE, dimension: "day_of_week" }); // Mon 18:30 local
    const inTokyo = compare({ rows, timeZone: "Asia/Tokyo", range: RANGE, dimension: "day_of_week" }); // Tue 08:30 local
    expect(inET.groups[0]!.label).toBe("Monday");
    expect(inTokyo.groups[0]!.label).toBe("Tuesday");
  });
});

describe("compare: platforms, targets, aggregate", () => {
  it("keeps two platforms as separate series — no bar for a different platform", () => {
    const rows = [
      ...Array.from({ length: 4 }, () => row({ providerKey: "bluesky", metricKey: "likeCount" })),
      ...Array.from({ length: 4 }, () => row({ providerKey: "mastodon", metricKey: "likeCount" })),
    ];
    const result = groupOf(rows, "slot");
    expect(result.providerKey).toBe("bluesky");
    expect(result.groups.reduce((n, g) => n + g.sampleSize, 0)).toBe(4);
  });

  it("gives a multi-target post one point per target, never one averaged point", () => {
    const rows = Array.from({ length: 4 }, () => row({ postId: "shared-post" }));
    const result = groupOf(rows, "slot");
    expect(result.groups[0]!.sampleSize).toBe(4);
  });

  it("reports both mean and median; a viral outlier moves the mean, not the median", () => {
    const values = [1, 2, 3, 1000];
    const rows = values.map((v) => row({ value: v }));
    const result = groupOf(rows, "slot");
    const group = result.groups[0]!;
    expect(group.median).toBe(2.5);
    expect(group.mean).toBeGreaterThan(group.median);
  });

  it("moves a group below the floor when the range changes", () => {
    const rows = Array.from({ length: 5 }, () => row());
    const wide = compare({ rows, timeZone: ZONE, range: RANGE, dimension: "slot" });
    expect(wide.groups).toHaveLength(1);
    const narrow = compare({
      rows: rows.slice(0, 2),
      timeZone: ZONE,
      range: { from: new Date("2026-01-01T00:00:00Z"), to: new Date("2026-01-02T00:00:00Z") },
      dimension: "slot",
    });
    expect(narrow.groups).toHaveLength(0);
    expect(narrow.suppressedGroupCount).toBe(1);
  });
});
