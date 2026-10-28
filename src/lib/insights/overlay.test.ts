import { describe, expect, it } from "vitest";
import { buildPostPerformanceOverlay, type OverlaySubject } from "./overlay";
import type { TargetInsightsView } from "./panel";

const AT = new Date("2026-04-01T12:00:00Z");
const EARLIER = new Date("2026-04-01T06:00:00Z");

function subject(name: string, providerName: string, view: TargetInsightsView): OverlaySubject {
  return { targetId: `t-${name}`, accountName: name, providerKey: providerName.toLowerCase(), providerName, view };
}

const reported = (rows: { label: string; value: number }[], capturedAt = AT): TargetInsightsView => ({
  state: "reported",
  capturedAt,
  rows,
});

describe("buildPostPerformanceOverlay", () => {
  it("gives every account its own column and keeps each figure under it", () => {
    const o = buildPostPerformanceOverlay([
      subject("IG", "Instagram", reported([{ label: "Views", value: 120 }, { label: "Likes", value: 8 }])),
      subject("BS", "Bluesky", reported([{ label: "Likes", value: 3 }])),
    ]);
    expect(o.columns.map((c) => c.accountName)).toEqual(["IG", "BS"]);
    expect(o.columns[0]!.values.get("Likes")).toBe(8);
    expect(o.columns[1]!.values.get("Likes")).toBe(3);
  });

  it("never sums, averages or otherwise combines two platforms' figures for a shared label", () => {
    const o = buildPostPerformanceOverlay([
      subject("IG", "Instagram", reported([{ label: "Likes", value: 8 }])),
      subject("BS", "Bluesky", reported([{ label: "Likes", value: 3 }])),
      subject("TT", "TikTok", reported([{ label: "Likes", value: 5 }])),
    ]);
    const likes = o.columns.map((c) => c.values.get("Likes"));
    expect(likes).toEqual([8, 3, 5]);
    // 16 is the sum, 5.33 the mean: neither exists anywhere in the result.
    expect(JSON.stringify([...o.columns.map((c) => [...c.values.values()])])).not.toContain("16");
  });

  it("lists a label once, the rows more accounts report first, ties in first-seen order", () => {
    const o = buildPostPerformanceOverlay([
      subject("IG", "Instagram", reported([{ label: "Views", value: 1 }, { label: "Likes", value: 2 }])),
      subject("BS", "Bluesky", reported([{ label: "Likes", value: 3 }, { label: "Reposts", value: 4 }])),
    ]);
    // Likes is the only row both accounts answer, so it leads; Views and Reposts keep their order.
    expect(o.labels).toEqual(["Likes", "Views", "Reposts"]);
  });

  it("keeps declaration order among rows with equal coverage, so one platform's words stay in its order", () => {
    const o = buildPostPerformanceOverlay([
      subject("IG", "Instagram", reported([{ label: "Views", value: 1 }, { label: "Reach", value: 2 }, { label: "Saved", value: 3 }])),
    ]);
    expect(o.labels).toEqual(["Views", "Reach", "Saved"]);
  });

  it("leaves a metric a platform does not report out of that column entirely, rather than zero", () => {
    const o = buildPostPerformanceOverlay([
      subject("IG", "Instagram", reported([{ label: "Views", value: 120 }])),
      subject("BS", "Bluesky", reported([{ label: "Likes", value: 3 }])),
    ]);
    expect(o.columns[1]!.values.has("Views")).toBe(false);
    expect(o.columns[1]!.values.get("Views")).toBeUndefined();
  });

  it("makes an account with no numbers an absence, never a column of blanks", () => {
    const o = buildPostPerformanceOverlay([
      subject("IG", "Instagram", reported([{ label: "Views", value: 1 }])),
      subject("TH", "Threads", { state: "not_polled_yet", firstReadDueAt: AT }),
      subject("X", "X", { state: "needs_reconnect", reason: "Reconnect to read numbers.", canReconnect: true }),
    ]);
    expect(o.columns).toHaveLength(1);
    expect(o.absences.map((a) => a.summary)).toEqual(["Waiting on the first read", "Needs a reconnect"]);
  });

  it("keeps a frozen target's last snapshot as a column, with a caveat naming the platform", () => {
    const o = buildPostPerformanceOverlay([
      subject("IG", "Instagram", { state: "gone", snapshot: { capturedAt: AT, rows: [{ label: "Views", value: 9 }] } }),
    ]);
    expect(o.columns[0]!.values.get("Views")).toBe(9);
    expect(o.columns[0]!.caveat).toBe("This post is no longer on Instagram; these numbers are the last ones read.");
  });

  it("treats a frozen target that never read anything as an absence, not an empty column", () => {
    const o = buildPostPerformanceOverlay([subject("IG", "Instagram", { state: "gone", snapshot: null })]);
    expect(o.columns).toEqual([]);
    expect(o.absences[0]!.summary).toBe("No longer on the platform");
  });

  it("reports the newest reading across the columns as `asOf`", () => {
    const o = buildPostPerformanceOverlay([
      subject("IG", "Instagram", reported([{ label: "Views", value: 1 }], EARLIER)),
      subject("BS", "Bluesky", reported([{ label: "Likes", value: 2 }], AT)),
    ]);
    expect(o.asOf).toEqual(AT);
  });

  it("is empty, not broken, for a post with no targets at all", () => {
    expect(buildPostPerformanceOverlay([])).toEqual({ labels: [], columns: [], absences: [], asOf: null });
  });

  it("keeps an unpublished target visible as an absence, so every account is accounted for", () => {
    const o = buildPostPerformanceOverlay([subject("IG", "Instagram", { state: "not_published" })]);
    expect(o.absences[0]!.summary).toBe("Not published yet");
  });
});
