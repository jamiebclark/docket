import { describe, expect, it } from "vitest";
import { parseXEnv, parseXInsightsEnv, requireXConfig } from "./config";

const ID = "abcDEF123_client";
const SECRET = "s3cr3t-value_0123456789";

describe("parseXEnv", () => {
  it("is unconfigured and quiet when nothing is set", () => {
    expect(parseXEnv({})).toEqual({ config: null, issues: [] });
  });
  it("accepts an id and secret", () => {
    expect(parseXEnv({ X_CLIENT_ID: ` ${ID} `, X_CLIENT_SECRET: SECRET })).toEqual({
      config: { clientId: ID, clientSecret: SECRET },
      issues: [],
    });
  });
  it("requires id and secret together", () => {
    const one = parseXEnv({ X_CLIENT_ID: ID });
    expect(one.config).toBeNull();
    expect(one.issues.map((i) => i.name)).toEqual(["X_CLIENT_SECRET"]);
    const other = parseXEnv({ X_CLIENT_SECRET: SECRET });
    expect(other.config).toBeNull();
    expect(other.issues.map((i) => i.name)).toEqual(["X_CLIENT_ID"]);
  });
  it("flags whitespace and over-long values without echoing them", () => {
    const { config, issues } = parseXEnv({ X_CLIENT_ID: "has space", X_CLIENT_SECRET: "x".repeat(501) });
    expect(config).toBeNull();
    expect(issues.map((i) => i.name)).toEqual(["X_CLIENT_ID", "X_CLIENT_SECRET"]);
    expect(JSON.stringify(issues)).not.toMatch(/has space|xxxxx/);
  });
  it("never puts values in issues", () => {
    expect(JSON.stringify(parseXEnv({ X_CLIENT_ID: ID }).issues)).not.toContain(ID);
    expect(JSON.stringify(parseXEnv({ X_CLIENT_SECRET: SECRET }).issues)).not.toContain(SECRET);
  });
});

describe("parseXInsightsEnv", () => {
  it("defaults to disabled with the documented read ceiling when nothing is set", () => {
    expect(parseXInsightsEnv({})).toEqual({ enabled: false, readCeiling: 8000, issues: [] });
  });
  it("parses X_INSIGHTS_ENABLED", () => {
    expect(parseXInsightsEnv({ X_INSIGHTS_ENABLED: "true" }).enabled).toBe(true);
    expect(parseXInsightsEnv({ X_INSIGHTS_ENABLED: "false" }).enabled).toBe(false);
  });
  it("rejects a non-boolean X_INSIGHTS_ENABLED as an environment issue, not a crash", () => {
    const r = parseXInsightsEnv({ X_INSIGHTS_ENABLED: "yes" });
    expect(r.enabled).toBe(false);
    expect(r.issues).toEqual([{ name: "X_INSIGHTS_ENABLED", reason: "must be true or false" }]);
  });
  it("parses X_INSIGHTS_READ_CEILING within its documented bounds", () => {
    expect(parseXInsightsEnv({ X_INSIGHTS_READ_CEILING: "100" }).readCeiling).toBe(100);
    expect(parseXInsightsEnv({ X_INSIGHTS_READ_CEILING: "1000000" }).readCeiling).toBe(1_000_000);
  });
  it("rejects an out-of-range or non-integer X_INSIGHTS_READ_CEILING as an environment issue naming the variable, never its value", () => {
    const low = parseXInsightsEnv({ X_INSIGHTS_READ_CEILING: "99" });
    expect(low.readCeiling).toBe(8000);
    expect(low.issues).toEqual([{ name: "X_INSIGHTS_READ_CEILING", reason: "must be an integer from 100 to 1,000,000" }]);

    const high = parseXInsightsEnv({ X_INSIGHTS_READ_CEILING: "1000001" });
    expect(high.readCeiling).toBe(8000);
    expect(high.issues).toEqual([{ name: "X_INSIGHTS_READ_CEILING", reason: "must be an integer from 100 to 1,000,000" }]);

    const notInt = parseXInsightsEnv({ X_INSIGHTS_READ_CEILING: "abc" });
    expect(notInt.readCeiling).toBe(8000);
    expect(notInt.issues).toEqual([{ name: "X_INSIGHTS_READ_CEILING", reason: "must be an integer from 100 to 1,000,000" }]);
    expect(JSON.stringify(notInt.issues)).not.toContain("abc");
  });
});

describe("requireXConfig", () => {
  it("throws a value-free error when unconfigured", () => {
    const saved = { id: process.env.X_CLIENT_ID, secret: process.env.X_CLIENT_SECRET };
    delete process.env.X_CLIENT_ID;
    delete process.env.X_CLIENT_SECRET;
    try {
      expect(() => requireXConfig()).toThrow(/X is not configured/);
    } finally {
      if (saved.id !== undefined) process.env.X_CLIENT_ID = saved.id;
      if (saved.secret !== undefined) process.env.X_CLIENT_SECRET = saved.secret;
    }
  });
});
