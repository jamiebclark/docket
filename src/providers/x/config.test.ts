import { describe, expect, it } from "vitest";
import { parseXEnv, requireXConfig } from "./config";

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
