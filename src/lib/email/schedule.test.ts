import { describe, expect, it } from "vitest";
import {
  atLocalHour,
  insideQuietHours,
  isSameLocalDay,
  isStaleDigest,
  nextDue,
  quietWindowEnd,
  resolveZone,
  type ScheduleSettings,
} from "./schedule";

const base: ScheduleSettings = {
  cadence: "digest",
  digestHour: 7,
  timeZone: "America/New_York",
  quietStartHour: null,
  quietEndHour: null,
};

describe("resolveZone", () => {
  it("prefers the stored zone", () => {
    expect(resolveZone("Europe/Paris", ["America/New_York"])).toBe("Europe/Paris");
  });
  it("falls back to UTC for an unrecognised stored zone", () => {
    expect(resolveZone("Not/AZone", ["America/New_York"])).toBe("UTC");
  });
  it("derives the shared project zone when none is stored", () => {
    expect(resolveZone(null, ["America/New_York", "America/New_York"])).toBe("America/New_York");
  });
  it("falls back to UTC when projects disagree", () => {
    expect(resolveZone(null, ["America/New_York", "Europe/Paris"])).toBe("UTC");
  });
  it("falls back to UTC with no projects", () => {
    expect(resolveZone(null, [])).toBe("UTC");
  });
});

describe("digest hour, zone change, DST and quiet windows", () => {
  it("resolves the daily hour identically before and after a US spring-forward", async () => {
    const { Temporal } = await import("@js-temporal/polyfill");
    const before = atLocalHour(Temporal.PlainDate.from("2026-03-07"), 7, "America/New_York");
    const after = atLocalHour(Temporal.PlainDate.from("2026-03-09"), 7, "America/New_York");
    expect(before.getUTCHours()).toBe(12); // EST, UTC-5
    expect(after.getUTCHours()).toBe(11); // EDT, UTC-4
  });

  it("resolves the daily hour identically before and after a US fall-back", async () => {
    const { Temporal } = await import("@js-temporal/polyfill");
    const before = atLocalHour(Temporal.PlainDate.from("2026-10-31"), 7, "America/New_York");
    const after = atLocalHour(Temporal.PlainDate.from("2026-11-02"), 7, "America/New_York");
    expect(before.getUTCHours()).toBe(11); // EDT
    expect(after.getUTCHours()).toBe(12); // EST
  });

  it("spring forward: a skipped hour moves to the next instant that exists", async () => {
    const { Temporal } = await import("@js-temporal/polyfill");
    // 2026-03-08 is spring-forward day in America/New_York; 02:00 does not exist.
    const d = atLocalHour(Temporal.PlainDate.from("2026-03-08"), 2, "America/New_York");
    expect(d).toBeInstanceOf(Date);
    expect(d.getTime()).toBe(new Date("2026-03-08T07:00:00Z").getTime());
  });

  it("two zones with different DST rules resolve to different absolute instants for the same local hour", async () => {
    const { Temporal } = await import("@js-temporal/polyfill");
    const ny = atLocalHour(Temporal.PlainDate.from("2026-06-01"), 7, "America/New_York");
    const london = atLocalHour(Temporal.PlainDate.from("2026-06-01"), 7, "Europe/London");
    expect(ny.getTime()).not.toBe(london.getTime());
  });

  it("insideQuietHours wraps midnight as one comparison", () => {
    const s: ScheduleSettings = { ...base, quietStartHour: 22, quietEndHour: 7 };
    const night = new Date("2026-06-01T02:00:00Z"); // 22:00 EDT the prior day -> inside
    const day = new Date("2026-06-01T15:00:00Z"); // 11:00 EDT -> outside
    expect(insideQuietHours(s, night)).toBe(true);
    expect(insideQuietHours(s, day)).toBe(false);
  });

  it("a non-wrapping quiet window is a plain range", () => {
    const s: ScheduleSettings = { ...base, quietStartHour: 1, quietEndHour: 6 };
    expect(insideQuietHours(s, new Date("2026-06-01T06:00:00Z"))).toBe(true); // 02:00 EDT
    expect(insideQuietHours(s, new Date("2026-06-01T12:00:00Z"))).toBe(false); // 08:00 EDT
  });

  it("quietWindowEnd resolves the end on the correct local day when the window wraps", () => {
    const s: ScheduleSettings = { ...base, quietStartHour: 22, quietEndHour: 7 };
    const night = new Date("2026-06-01T02:00:00Z"); // inside, started the previous evening
    const end = quietWindowEnd(s, night);
    expect(end.getTime()).toBeGreaterThan(night.getTime());
    expect(insideQuietHours(s, new Date(end.getTime() - 1))).toBe(true);
    expect(insideQuietHours(s, end)).toBe(false);
  });

  it("nextDue for immediate cadence is now outside quiet hours", () => {
    const s: ScheduleSettings = { ...base, cadence: "immediate" };
    const now = new Date("2026-06-01T15:00:00Z");
    expect(nextDue(s, null, now).getTime()).toBe(now.getTime());
  });

  it("nextDue for immediate cadence defers to the end of quiet hours", () => {
    const s: ScheduleSettings = { ...base, cadence: "immediate", quietStartHour: 22, quietEndHour: 7 };
    const now = new Date("2026-06-01T02:00:00Z");
    expect(nextDue(s, null, now).getTime()).toBe(quietWindowEnd(s, now).getTime());
  });

  it("nextDue for a digest picks today's hour when still ahead", () => {
    const now = new Date("2026-06-01T10:00:00Z"); // 06:00 EDT, before the 07:00 digest hour
    const due = nextDue(base, null, now);
    expect(isSameLocalDay(due, now, base.timeZone)).toBe(true);
    expect(due.getTime()).toBeGreaterThan(now.getTime());
  });

  it("nextDue for a digest that missed today sends a late one today (N53)", () => {
    const now = new Date("2026-06-01T20:00:00Z"); // well after 07:00 EDT
    const due = nextDue(base, null, now);
    expect(due.getTime()).toBe(now.getTime());
  });

  it("nextDue for a digest already sent today rolls to tomorrow", () => {
    const now = new Date("2026-06-01T20:00:00Z");
    const lastSentAt = new Date("2026-06-01T11:00:00Z");
    const due = nextDue(base, lastSentAt, now);
    expect(isSameLocalDay(due, now, base.timeZone)).toBe(false);
  });

  it("nextDue reflects a digest-hour change mid-day", () => {
    const now = new Date("2026-06-01T10:00:00Z"); // 06:00 EDT
    const earlier: ScheduleSettings = { ...base, digestHour: 5 };
    const due = nextDue(earlier, null, now);
    expect(due.getTime()).toBe(now.getTime()); // 05:00 already passed and nothing was sent today -> a late "now"
  });

  it("nextDue reflects a zone change", () => {
    const now = new Date("2026-06-01T10:00:00Z");
    const parisZone: ScheduleSettings = { ...base, timeZone: "Europe/Paris" };
    const nyDue = nextDue(base, null, now);
    const parisDue = nextDue(parisZone, null, now);
    expect(nyDue.getTime()).not.toBe(parisDue.getTime());
  });

  it("isStaleDigest is true for a digest claimed after its own local day has passed", () => {
    const dueAt = new Date("2026-06-01T11:00:00Z");
    const now = new Date("2026-06-02T20:00:00Z");
    expect(isStaleDigest(base, dueAt, now)).toBe(true);
  });

  it("isStaleDigest is false on the same local day, and always false for immediate", () => {
    const dueAt = new Date("2026-06-01T11:00:00Z");
    const now = new Date("2026-06-01T20:00:00Z");
    expect(isStaleDigest(base, dueAt, now)).toBe(false);
    expect(isStaleDigest({ ...base, cadence: "immediate" }, dueAt, now)).toBe(false);
  });

  it("an unrecognised stored zone resolves to UTC and schedule.ts never throws on it", () => {
    const zone = resolveZone("Definitely/Not-A-Zone", ["America/New_York"]);
    expect(zone).toBe("UTC");
    const s: ScheduleSettings = { ...base, timeZone: zone };
    expect(() => nextDue(s, null, new Date())).not.toThrow();
  });
});
