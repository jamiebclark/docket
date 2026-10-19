import { afterEach, describe, expect, it, vi } from "vitest";
import { configured, parsePinterestEnv, requirePinterestConfig } from "./config";

describe("parsePinterestEnv", () => {
  it("is not configured, with no issue, when nothing is set", () => {
    expect(parsePinterestEnv({})).toEqual({ config: null, issues: [] });
  });

  it("configures with both valid values", () => {
    expect(parsePinterestEnv({ PINTEREST_CLIENT_ID: "ID", PINTEREST_CLIENT_SECRET: "SECRET" })).toEqual({
      config: { clientId: "ID", clientSecret: "SECRET", insightsScopes: false },
      issues: [],
    });
  });

  it("parses PINTEREST_INSIGHTS_SCOPES with its documented default", () => {
    expect(
      parsePinterestEnv({ PINTEREST_CLIENT_ID: "ID", PINTEREST_CLIENT_SECRET: "SECRET", PINTEREST_INSIGHTS_SCOPES: "true" }).config
        ?.insightsScopes,
    ).toBe(true);
    expect(parsePinterestEnv({ PINTEREST_CLIENT_ID: "ID", PINTEREST_CLIENT_SECRET: "SECRET" }).config?.insightsScopes).toBe(false);
  });

  it("rejects a non-boolean PINTEREST_INSIGHTS_SCOPES as an environment issue, not a crash", () => {
    const r = parsePinterestEnv({ PINTEREST_CLIENT_ID: "ID", PINTEREST_CLIENT_SECRET: "SECRET", PINTEREST_INSIGHTS_SCOPES: "yes" });
    expect(r.config?.insightsScopes).toBe(false);
    expect(r.issues).toEqual([{ name: "PINTEREST_INSIGHTS_SCOPES", reason: "must be true or false" }]);
  });

  it("names the missing variable when only one of the pair is set, never a value", () => {
    expect(parsePinterestEnv({ PINTEREST_CLIENT_ID: "ID" }).issues).toEqual([
      { name: "PINTEREST_CLIENT_SECRET", reason: "required when PINTEREST_CLIENT_ID is set" },
    ]);
    expect(parsePinterestEnv({ PINTEREST_CLIENT_SECRET: "SECRET" }).issues).toEqual([
      { name: "PINTEREST_CLIENT_ID", reason: "required when PINTEREST_CLIENT_SECRET is set" },
    ]);
  });

  it("rejects an id with whitespace or over 200 chars", () => {
    const whitespace = parsePinterestEnv({ PINTEREST_CLIENT_ID: "a b", PINTEREST_CLIENT_SECRET: "SECRET" });
    expect(whitespace.config).toBeNull();
    expect(whitespace.issues).toEqual([{ name: "PINTEREST_CLIENT_ID", reason: "must be the app ID from the Pinterest developer portal" }]);

    const long = parsePinterestEnv({ PINTEREST_CLIENT_ID: "a".repeat(201), PINTEREST_CLIENT_SECRET: "SECRET" });
    expect(long.config).toBeNull();
    expect(long.issues).toEqual([{ name: "PINTEREST_CLIENT_ID", reason: "must be the app ID from the Pinterest developer portal" }]);
  });

  it("rejects a secret with whitespace or over 500 chars", () => {
    const whitespace = parsePinterestEnv({ PINTEREST_CLIENT_ID: "ID", PINTEREST_CLIENT_SECRET: "a b" });
    expect(whitespace.config).toBeNull();
    expect(whitespace.issues).toEqual([
      { name: "PINTEREST_CLIENT_SECRET", reason: "must be the app secret from the Pinterest developer portal" },
    ]);

    const long = parsePinterestEnv({ PINTEREST_CLIENT_ID: "ID", PINTEREST_CLIENT_SECRET: "a".repeat(501) });
    expect(long.config).toBeNull();
    expect(long.issues).toEqual([
      { name: "PINTEREST_CLIENT_SECRET", reason: "must be the app secret from the Pinterest developer portal" },
    ]);
    expect(JSON.stringify(long.issues)).not.toContain("aaaa");
  });

  it("never puts a value inside an issue", () => {
    const r = parsePinterestEnv({ PINTEREST_CLIENT_ID: "secret-id-value", PINTEREST_CLIENT_SECRET: "a b" });
    expect(JSON.stringify(r.issues)).not.toContain("secret-id-value");
  });
});

describe("configured", () => {
  it("is true only when both are present and valid", () => {
    expect(configured({})).toBe(false);
    expect(configured({ PINTEREST_CLIENT_ID: "ID" })).toBe(false);
    expect(configured({ PINTEREST_CLIENT_ID: "ID", PINTEREST_CLIENT_SECRET: "SECRET" })).toBe(true);
  });
});

describe("requirePinterestConfig", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("throws a value-free error when not configured", () => {
    vi.stubEnv("PINTEREST_CLIENT_ID", "");
    vi.stubEnv("PINTEREST_CLIENT_SECRET", "");
    expect(() => requirePinterestConfig()).toThrow(/not configured/);
  });
});
