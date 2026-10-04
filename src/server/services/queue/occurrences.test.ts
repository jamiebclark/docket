import { Temporal } from "@js-temporal/polyfill";
import { describe, expect, it } from "vitest";
import { occurrencesBetween, resolveLocalDateTime, resolveOccurrence } from "./occurrences";

const I = (s: string) => Temporal.Instant.from(s);
const slot = (id: string, weekday: number, localTime: string, paused = false) => ({ id, weekday, localTime, paused });

describe("resolveOccurrence", () => {
  it("resolves wall time in the zone", () => {
    const at = resolveOccurrence(Temporal.PlainDate.from("2026-10-05"), Temporal.PlainTime.from("09:00"), "Europe/London");
    expect(at.toString()).toBe("2026-10-05T08:00:00Z");
  });
  it("moves a nonexistent time forward past the gap (compatible)", () => {
    const at = resolveOccurrence(Temporal.PlainDate.from("2026-03-29"), Temporal.PlainTime.from("01:30"), "Europe/London");
    expect(at.toString()).toBe("2026-03-29T01:30:00Z");
  });
  it("takes the earlier offset for an ambiguous time", () => {
    const at = resolveOccurrence(Temporal.PlainDate.from("2026-10-25"), Temporal.PlainTime.from("01:30"), "Europe/London");
    expect(at.toString()).toBe("2026-10-25T00:30:00Z");
  });
});

describe("occurrencesBetween", () => {
  // 2026-10-05 is a Monday.
  const monday9 = slot("a", 1, "09:00");
  it("returns weekday/time instants in the project zone, in order", () => {
    const out = occurrencesBetween(
      [monday9, slot("b", 2, "10:00")],
      "Europe/London",
      I("2026-10-01T00:00:00Z"),
      I("2026-10-13T00:00:00Z"),
    );
    expect(out.map((o) => o.instant.toString())).toEqual([
      "2026-10-05T08:00:00Z",
      "2026-10-06T09:00:00Z",
      "2026-10-12T08:00:00Z",
    ]);
    expect(out[0]!.slotId).toBe("a");
  });
  it("skips paused slots", () => {
    expect(
      occurrencesBetween([slot("a", 1, "09:00", true)], "UTC", I("2026-10-01T00:00:00Z"), I("2026-10-30T00:00:00Z")),
    ).toEqual([]);
  });
  it("is exclusive of from and inclusive of to", () => {
    const from = I("2026-10-05T08:00:00Z");
    expect(occurrencesBetween([monday9], "Europe/London", from, I("2026-10-06T00:00:00Z"))).toEqual([]);
    const out = occurrencesBetween([monday9], "Europe/London", I("2026-10-05T07:59:59Z"), from);
    expect(out).toHaveLength(1);
  });
  it("dedupes two slots at the same instant", () => {
    const out = occurrencesBetween(
      [slot("b", 1, "09:00"), slot("a", 1, "09:00:00")],
      "UTC",
      I("2026-10-01T00:00:00Z"),
      I("2026-10-06T00:00:00Z"),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.slotId).toBe("a");
  });
  it("returns nothing for an empty or inverted range", () => {
    expect(occurrencesBetween([monday9], "UTC", I("2026-10-06T00:00:00Z"), I("2026-10-01T00:00:00Z"))).toEqual([]);
  });
});

describe("DST transitions (SC-007)", () => {
  const sun = (localTime: string) => [{ id: "a", weekday: 7, localTime, paused: false }];
  it("keeps one occurrence on the spring-forward day in New York, shifted past the gap", () => {
    const out = occurrencesBetween(sun("02:30"), "America/New_York", I("2026-03-07T00:00:00Z"), I("2026-03-09T00:00:00Z"));
    expect(out.map((o) => o.instant.toString())).toEqual(["2026-03-08T07:30:00Z"]);
  });
  it("takes the earlier instant on the fall-back day in London", () => {
    const out = occurrencesBetween(sun("01:30"), "Europe/London", I("2026-10-24T00:00:00Z"), I("2026-10-26T00:00:00Z"));
    expect(out.map((o) => o.instant.toString())).toEqual(["2026-10-25T00:30:00Z"]);
  });
  it("handles a southern-hemisphere zone (Sydney, DST starts in October)", () => {
    const out = occurrencesBetween(sun("02:30"), "Australia/Sydney", I("2026-10-01T00:00:00Z"), I("2026-10-06T00:00:00Z"));
    expect(out.map((o) => o.instant.toString())).toEqual(["2026-10-03T16:30:00Z"]);
  });
});

describe("resolveLocalDateTime (Temporal compatible)", () => {
  it("is exact for an ordinary time", () => {
    expect(resolveLocalDateTime("Europe/London", "2026-10-05T09:00").toString()).toBe("2026-10-05T08:00:00Z");
  });
  it("New York gap 02:30 on 2026-03-08 resolves later, to 03:30 EDT", () => {
    expect(resolveLocalDateTime("America/New_York", "2026-03-08T02:30").toString()).toBe("2026-03-08T07:30:00Z");
  });
  it("New York overlap 01:30 on 2026-11-01 takes the earlier (EDT) instant", () => {
    expect(resolveLocalDateTime("America/New_York", "2026-11-01T01:30").toString()).toBe("2026-11-01T05:30:00Z");
  });
  it("London gap 01:30 on 2026-03-29 resolves to 02:30 BST", () => {
    expect(resolveLocalDateTime("Europe/London", "2026-03-29T01:30").toString()).toBe("2026-03-29T01:30:00Z");
  });
  it("Lord Howe's 30-minute gap (02:15 on 2026-10-04) resolves later", () => {
    expect(resolveLocalDateTime("Australia/Lord_Howe", "2026-10-04T02:15").toString()).toBe("2026-10-03T15:45:00Z");
  });
});
