import { describe, expect, it } from "vitest";
import { isAppId, isAppSecret, parseMetaEnv, readEnv } from "./config";

const ID = "1234567890";
const SECRET = "0123456789abcdef0123456789abcdef";

describe("parseMetaEnv", () => {
  it("is not configured, with no issues, when nothing is set", () => {
    expect(parseMetaEnv({})).toEqual({ config: null, issues: [] });
  });

  it("parses a full configuration with the default version", () => {
    const { config, issues } = parseMetaEnv({ META_APP_ID: ID, META_APP_SECRET: SECRET });
    expect(issues).toEqual([]);
    expect(config).toEqual({
      appId: ID,
      appSecret: SECRET,
      graphVersion: "v26.0",
      loginConfigId: null,
      insightsScopes: false,
      insightsUsageCeiling: 80,
    });
  });

  it("requires id and secret together", () => {
    expect(parseMetaEnv({ META_APP_ID: ID }).issues).toEqual([
      { name: "META_APP_SECRET", reason: "required when META_APP_ID is set" },
    ]);
    const only = parseMetaEnv({ META_APP_SECRET: SECRET });
    expect(only.config).toBeNull();
    expect(only.issues).toEqual([{ name: "META_APP_ID", reason: "required when META_APP_SECRET is set" }]);
  });

  it("validates the id, secret and version shapes", () => {
    const r = parseMetaEnv({ META_APP_ID: "abc", META_APP_SECRET: "short", META_GRAPH_VERSION: "26" });
    expect(r.config).toBeNull();
    expect(r.issues.map((i) => i.name).sort()).toEqual(["META_APP_ID", "META_APP_SECRET", "META_GRAPH_VERSION"]);
  });

  it("accepts a custom valid version and a config id", () => {
    const { config } = parseMetaEnv({
      META_APP_ID: ID,
      META_APP_SECRET: SECRET,
      META_GRAPH_VERSION: "v27.1",
      META_LOGIN_CONFIG_ID: "999",
    });
    expect(config?.graphVersion).toBe("v27.1");
    expect(config?.loginConfigId).toBe("999");
  });

  it("ignores a config id without id and secret, and says so", () => {
    const r = parseMetaEnv({ META_LOGIN_CONFIG_ID: "999" });
    expect(r.config).toBeNull();
    expect(r.issues).toEqual([{ name: "META_LOGIN_CONFIG_ID", reason: "set META_APP_ID and META_APP_SECRET to use it" }]);
  });

  it("never puts a value in an issue", () => {
    const r = parseMetaEnv({ META_APP_ID: "bad-id-value", META_APP_SECRET: "sec ret" });
    expect(JSON.stringify(r.issues)).not.toContain("bad-id-value");
    expect(JSON.stringify(r.issues)).not.toContain("sec ret");
  });

  it("parses META_INSIGHTS_SCOPES with its documented default", () => {
    expect(parseMetaEnv({ META_APP_ID: ID, META_APP_SECRET: SECRET }).config?.insightsScopes).toBe(false);
    expect(
      parseMetaEnv({ META_APP_ID: ID, META_APP_SECRET: SECRET, META_INSIGHTS_SCOPES: "true" }).config?.insightsScopes,
    ).toBe(true);
    expect(
      parseMetaEnv({ META_APP_ID: ID, META_APP_SECRET: SECRET, META_INSIGHTS_SCOPES: "false" }).config?.insightsScopes,
    ).toBe(false);
  });

  it("rejects a non-boolean META_INSIGHTS_SCOPES as an environment issue, not a crash", () => {
    const r = parseMetaEnv({ META_APP_ID: ID, META_APP_SECRET: SECRET, META_INSIGHTS_SCOPES: "yes" });
    expect(r.config).not.toBeNull();
    expect(r.issues).toEqual([{ name: "META_INSIGHTS_SCOPES", reason: "must be true or false" }]);
  });

  it("parses META_INSIGHTS_USAGE_CEILING with its documented default", () => {
    expect(parseMetaEnv({ META_APP_ID: ID, META_APP_SECRET: SECRET }).config?.insightsUsageCeiling).toBe(80);
    expect(
      parseMetaEnv({ META_APP_ID: ID, META_APP_SECRET: SECRET, META_INSIGHTS_USAGE_CEILING: "50" }).config
        ?.insightsUsageCeiling,
    ).toBe(50);
  });

  it("rejects an out-of-range META_INSIGHTS_USAGE_CEILING as an environment issue, not a crash", () => {
    const r = parseMetaEnv({ META_APP_ID: ID, META_APP_SECRET: SECRET, META_INSIGHTS_USAGE_CEILING: "0" });
    expect(r.config).not.toBeNull();
    expect(r.issues).toEqual([{ name: "META_INSIGHTS_USAGE_CEILING", reason: "must be an integer from 1 to 100" }]);
    const r2 = parseMetaEnv({ META_APP_ID: ID, META_APP_SECRET: SECRET, META_INSIGHTS_USAGE_CEILING: "101" });
    expect(r2.issues).toEqual([{ name: "META_INSIGHTS_USAGE_CEILING", reason: "must be an integer from 1 to 100" }]);
    const r3 = parseMetaEnv({ META_APP_ID: ID, META_APP_SECRET: SECRET, META_INSIGHTS_USAGE_CEILING: "abc" });
    expect(r3.issues).toEqual([{ name: "META_INSIGHTS_USAGE_CEILING", reason: "must be an integer from 1 to 100" }]);
  });
});

describe("exported env helpers", () => {
  it("reads trimmed values and treats blanks as unset", () => {
    expect(readEnv({ A: "  x " }, "A")).toBe("x");
    expect(readEnv({ A: "   " }, "A")).toBeNull();
    expect(readEnv({}, "A")).toBeNull();
  });
  it("validates app ids and secrets as Meta's parsing does", () => {
    expect(isAppId("123456789")).toBe(true);
    expect(isAppId("12ab")).toBe(false);
    expect(isAppSecret("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isAppSecret("short")).toBe(false);
  });
});
