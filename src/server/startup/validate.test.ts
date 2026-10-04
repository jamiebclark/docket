import { describe, expect, it } from "vitest";
import { validateConfiguration } from "./validate";

const GOOD = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  BETTER_AUTH_SECRET: "x".repeat(40),
  BETTER_AUTH_URL: "http://localhost:3000",
  CREDENTIALS_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};

describe("validateConfiguration", () => {
  it("accepts a minimal valid environment and lists what is switched off", () => {
    const r = validateConfiguration(GOOD);
    expect(r.ok).toBe(true);
    expect(r.disabled.some((l) => /media storage/.test(l))).toBe(true);
    expect(r.disabled.some((l) => /generation/.test(l))).toBe(true);
    expect(r.disabled.some((l) => /TICK_SECRET/.test(l))).toBe(true);
  });

  it("lists a missing variable, a malformed one and a half-set group together, with no values", () => {
    const r = validateConfiguration({
      ...GOOD,
      DATABASE_URL: undefined,
      PORT: "LEAKVALUE-not-a-port",
      S3_BUCKET: "docket-media",
      LLM_MODEL: "LEAKMODEL",
    });
    expect(r.ok).toBe(false);
    const names = r.issues.map((i) => i.name);
    expect(names).toEqual(expect.arrayContaining(["DATABASE_URL", "PORT", "S3_ACCESS_KEY_ID", "LLM_PROVIDER"]));
    expect(JSON.stringify(r.issues)).not.toMatch(/LEAK/);
  });

  it("flags a provider with no model or key, and an API key without a provider", () => {
    expect(validateConfiguration({ ...GOOD, LLM_PROVIDER: "openai" }).issues.map((i) => i.name)).toEqual(
      expect.arrayContaining(["LLM_MODEL", "OPENAI_API_KEY"]),
    );
    expect(validateConfiguration({ ...GOOD, ANTHROPIC_API_KEY: "k" }).issues.map((i) => i.name)).toContain(
      "LLM_PROVIDER",
    );
  });

  it("treats a wholly absent optional group as disabled, not an error", () => {
    const r = validateConfiguration({ ...GOOD, LLM_PROVIDER: "", LLM_MODEL: "" });
    expect(r.ok).toBe(true);
    expect(r.disabled.filter((l) => /generation/.test(l))).toHaveLength(1);
  });

  it("accepts a complete generator group", () => {
    const r = validateConfiguration({ ...GOOD, LLM_PROVIDER: "openai", LLM_MODEL: "m", OPENAI_API_KEY: "k" });
    expect(r.ok).toBe(true);
    expect(r.disabled.some((l) => /generation/.test(l))).toBe(false);
  });
});
