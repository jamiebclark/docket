import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTikTokEnv, requireTikTokConfig, tiktokAudited } from "./config";

describe("parseTikTokEnv", () => {
  it("is not configured, with no issue, when nothing is set or only the audit flag is", () => {
    expect(parseTikTokEnv({})).toEqual({ config: null, audited: false, issues: [] });
    expect(parseTikTokEnv({ TIKTOK_APP_AUDITED: "true" })).toEqual({ config: null, audited: true, issues: [] });
  });

  it("names the missing variable when only one of the pair is set, never a value", () => {
    expect(parseTikTokEnv({ TIKTOK_CLIENT_KEY: "KEY" }).issues).toEqual([
      { name: "TIKTOK_CLIENT_SECRET", reason: "required when TIKTOK_CLIENT_KEY is set" },
    ]);
    expect(parseTikTokEnv({ TIKTOK_CLIENT_SECRET: "SECRET" }).issues).toEqual([
      { name: "TIKTOK_CLIENT_KEY", reason: "required when TIKTOK_CLIENT_SECRET is set" },
    ]);
  });

  it("rejects whitespace and over-long values", () => {
    const r = parseTikTokEnv({ TIKTOK_CLIENT_KEY: "a b", TIKTOK_CLIENT_SECRET: "x".repeat(501) });
    expect(r.config).toBeNull();
    expect(r.issues.map((i) => i.name)).toEqual(["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"]);
    expect(JSON.stringify(r.issues)).not.toContain("xxxx");
  });

  it("configures with both, and reads the audit flag in any case", () => {
    expect(parseTikTokEnv({ TIKTOK_CLIENT_KEY: "K", TIKTOK_CLIENT_SECRET: "S", TIKTOK_APP_AUDITED: "TRUE" })).toEqual({
      config: { clientKey: "K", clientSecret: "S" },
      audited: true,
      issues: [],
    });
    expect(parseTikTokEnv({ TIKTOK_CLIENT_KEY: "K", TIKTOK_CLIENT_SECRET: "S" }).audited).toBe(false);
  });

  it("raises an issue for a bad audit flag and treats it as false", () => {
    const r = parseTikTokEnv({ TIKTOK_CLIENT_KEY: "K", TIKTOK_CLIENT_SECRET: "S", TIKTOK_APP_AUDITED: "yes" });
    expect(r.issues).toEqual([{ name: "TIKTOK_APP_AUDITED", reason: "must be true or false" }]);
    expect(r.audited).toBe(false);
    expect(r.config).not.toBeNull();
  });
});

describe("process.env readers", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("requireTikTokConfig throws a value-free error when unconfigured", () => {
    vi.stubEnv("TIKTOK_CLIENT_KEY", "");
    vi.stubEnv("TIKTOK_CLIENT_SECRET", "");
    expect(() => requireTikTokConfig()).toThrow(/not configured/);
  });
  it("tiktokAudited follows the environment on each call", () => {
    vi.stubEnv("TIKTOK_APP_AUDITED", "true");
    expect(tiktokAudited()).toBe(true);
    vi.stubEnv("TIKTOK_APP_AUDITED", "false");
    expect(tiktokAudited()).toBe(false);
  });
});
