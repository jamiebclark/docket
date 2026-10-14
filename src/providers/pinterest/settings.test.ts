import { describe, expect, it } from "vitest";
import { PINTEREST_TRIAL_NOTE, pinterestAccountNotes, pinterestSettingsSchema } from "./settings";

describe("pinterestSettingsSchema", () => {
  it("strips a stale future value rather than failing", () => {
    const parsed = pinterestSettingsSchema.safeParse({ someFutureField: "x" });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({});
  });

  it("parses an empty object", () => {
    expect(pinterestSettingsSchema.parse({})).toEqual({});
  });
});

describe("pinterestAccountNotes", () => {
  it("always includes the Trial note, worded tier-neutrally", () => {
    const notes = pinterestAccountNotes({ settings: {}, credentialsExpireAt: null, timeZone: "UTC" });
    expect(notes).toEqual([PINTEREST_TRIAL_NOTE]);
    expect(PINTEREST_TRIAL_NOTE).not.toMatch(/\bStandard\b/);
  });

  it("adds the reconnect note only within 30 days, rendered through formatLocal", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const within = new Date(now.getTime() + 29 * 24 * 60 * 60 * 1000);
    const outside = new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000);

    const near = pinterestAccountNotes({ settings: {}, credentialsExpireAt: within, now, timeZone: "UTC" });
    expect(near.some((n) => n.startsWith("Reconnect Pinterest before "))).toBe(true);
    expect(near.some((n) => n.includes("T") && n.includes("Z"))).toBe(false);

    const far = pinterestAccountNotes({ settings: {}, credentialsExpireAt: outside, now, timeZone: "UTC" });
    expect(far.some((n) => n.startsWith("Reconnect Pinterest before "))).toBe(false);
  });

  it("omits the reconnect note when now is not given", () => {
    const notes = pinterestAccountNotes({ settings: {}, credentialsExpireAt: new Date(), timeZone: "UTC" });
    expect(notes).toEqual([PINTEREST_TRIAL_NOTE]);
  });
});
