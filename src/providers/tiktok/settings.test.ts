import { afterEach, describe, expect, it, vi } from "vitest";
import { PHOTO_DOMAIN_NOTE, UNAUDITED_NOTE, tiktokAccountNotes, tiktokSettingsSchema } from "./settings";

const NOW = new Date("2026-10-01T00:00:00Z");
const DAY = 86_400_000;
afterEach(() => vi.unstubAllEnvs());

describe("tiktokSettingsSchema", () => {
  it("strips unknown keys and tolerates empty settings", () => {
    expect(tiktokSettingsSchema.parse({ username: "ada", extra: 1 })).toEqual({ username: "ada" });
    expect(tiktokSettingsSchema.parse({})).toEqual({});
  });
});

describe("tiktokAccountNotes", () => {
  it("lists the unaudited and photo-domain notes on an unaudited install", () => {
    vi.stubEnv("TIKTOK_APP_AUDITED", "false");
    expect(tiktokAccountNotes({ settings: {}, credentialsExpireAt: null, now: NOW })).toEqual([UNAUDITED_NOTE, PHOTO_DOMAIN_NOTE]);
  });
  it("drops the unaudited note once the app is audited", () => {
    vi.stubEnv("TIKTOK_APP_AUDITED", "true");
    expect(tiktokAccountNotes({ settings: {}, credentialsExpireAt: null, now: NOW })).toEqual([PHOTO_DOMAIN_NOTE]);
  });
  it("adds the reconnect date within 30 days of expiry, and not beyond", () => {
    vi.stubEnv("TIKTOK_APP_AUDITED", "true");
    const within = new Date(NOW.getTime() + 30 * DAY);
    expect(tiktokAccountNotes({ settings: {}, credentialsExpireAt: within, now: NOW })).toContain("Reconnect TikTok before 2026-10-31");
    const beyond = new Date(NOW.getTime() + 30 * DAY + 1);
    expect(tiktokAccountNotes({ settings: {}, credentialsExpireAt: beyond, now: NOW })).toEqual([PHOTO_DOMAIN_NOTE]);
  });
  it("leaves the reconnect note out without a clock", () => {
    vi.stubEnv("TIKTOK_APP_AUDITED", "true");
    expect(tiktokAccountNotes({ settings: {}, credentialsExpireAt: NOW })).toEqual([PHOTO_DOMAIN_NOTE]);
  });
});
