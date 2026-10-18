import { describe, expect, it } from "vitest";
import { THREADS_DEFAULT_GRAPH_BASE, parseThreadsEnv, threadsApp } from "./config";

const ID = "1234567890";
const SECRET = "0123456789abcdef0123456789abcdef";

describe("parseThreadsEnv", () => {
  it("is unconfigured and quiet when nothing is set", () => {
    expect(parseThreadsEnv({})).toEqual({ config: null, issues: [] });
  });
  it("accepts an id and secret, defaulting the base", () => {
    const { config, issues } = parseThreadsEnv({ THREADS_APP_ID: ID, THREADS_APP_SECRET: SECRET });
    expect(issues).toEqual([]);
    expect(config).toEqual({
      appId: ID,
      appSecret: SECRET,
      graphBase: THREADS_DEFAULT_GRAPH_BASE,
      insightsScopes: false,
      insightsUsageCeiling: 80,
    });
  });
  it("requires id and secret together", () => {
    expect(parseThreadsEnv({ THREADS_APP_ID: ID }).issues.map((i) => i.name)).toEqual(["THREADS_APP_SECRET"]);
    expect(parseThreadsEnv({ THREADS_APP_SECRET: SECRET }).issues.map((i) => i.name)).toEqual(["THREADS_APP_ID"]);
    expect(parseThreadsEnv({ THREADS_APP_SECRET: SECRET }).config).toBeNull();
  });
  it("treats an empty base as the default and accepts an https origin", () => {
    const base = { THREADS_APP_ID: ID, THREADS_APP_SECRET: SECRET };
    expect(parseThreadsEnv({ ...base, THREADS_GRAPH_BASE: "  " }).config?.graphBase).toBe(THREADS_DEFAULT_GRAPH_BASE);
    expect(parseThreadsEnv({ ...base, THREADS_GRAPH_BASE: "https://fake.example:8443/" }).config?.graphBase).toBe(
      "https://fake.example:8443",
    );
  });
  it.each(["http://x.example", "https://x.example/v1", "https://x.example/?a=1", "https://x.example/#f", "https://u:p@x.example", "nonsense"])(
    "flags the base %s without echoing it",
    (bad) => {
      const { issues } = parseThreadsEnv({ THREADS_APP_ID: ID, THREADS_APP_SECRET: SECRET, THREADS_GRAPH_BASE: bad });
      expect(issues.map((i) => i.name)).toEqual(["THREADS_GRAPH_BASE"]);
      expect(JSON.stringify(issues)).not.toContain(bad);
    },
  );
  it("never puts values in issues", () => {
    const { issues } = parseThreadsEnv({ THREADS_APP_ID: "abc", THREADS_APP_SECRET: "short secret" });
    expect(issues).toHaveLength(2);
    expect(JSON.stringify(issues)).not.toMatch(/abc|short secret/);
  });

  it("parses THREADS_INSIGHTS_SCOPES with its documented default", () => {
    const base = { THREADS_APP_ID: ID, THREADS_APP_SECRET: SECRET };
    expect(parseThreadsEnv(base).config?.insightsScopes).toBe(false);
    expect(parseThreadsEnv({ ...base, THREADS_INSIGHTS_SCOPES: "true" }).config?.insightsScopes).toBe(true);
    expect(parseThreadsEnv({ ...base, THREADS_INSIGHTS_SCOPES: "false" }).config?.insightsScopes).toBe(false);
  });

  it("rejects a non-boolean THREADS_INSIGHTS_SCOPES as an environment issue, not a crash", () => {
    const r = parseThreadsEnv({ THREADS_APP_ID: ID, THREADS_APP_SECRET: SECRET, THREADS_INSIGHTS_SCOPES: "yes" });
    expect(r.config).not.toBeNull();
    expect(r.issues).toEqual([{ name: "THREADS_INSIGHTS_SCOPES", reason: "must be true or false" }]);
  });

  it("parses THREADS_INSIGHTS_USAGE_CEILING with its documented default", () => {
    const base = { THREADS_APP_ID: ID, THREADS_APP_SECRET: SECRET };
    expect(parseThreadsEnv(base).config?.insightsUsageCeiling).toBe(80);
    expect(parseThreadsEnv({ ...base, THREADS_INSIGHTS_USAGE_CEILING: "50" }).config?.insightsUsageCeiling).toBe(50);
  });

  it("rejects an out-of-range THREADS_INSIGHTS_USAGE_CEILING as an environment issue, not a crash", () => {
    const base = { THREADS_APP_ID: ID, THREADS_APP_SECRET: SECRET };
    const r = parseThreadsEnv({ ...base, THREADS_INSIGHTS_USAGE_CEILING: "0" });
    expect(r.config).not.toBeNull();
    expect(r.issues).toEqual([{ name: "THREADS_INSIGHTS_USAGE_CEILING", reason: "must be an integer from 1 to 100" }]);
    const r2 = parseThreadsEnv({ ...base, THREADS_INSIGHTS_USAGE_CEILING: "101" });
    expect(r2.issues).toEqual([{ name: "THREADS_INSIGHTS_USAGE_CEILING", reason: "must be an integer from 1 to 100" }]);
  });
});

describe("threadsApp", () => {
  it("builds a versioned app on the given base", () => {
    expect(threadsApp("https://x.example")).toEqual({ graphBase: "https://x.example", version: "v1.0" });
  });
});
