import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseEnv } from "./env";

const key = randomBytes(32).toString("base64");
const base = {
  DATABASE_URL: "postgres://u:pw-secret@localhost:5432/docket",
  BETTER_AUTH_SECRET: "s".repeat(32),
  BETTER_AUTH_URL: "http://localhost:3000",
  CREDENTIALS_ENCRYPTION_KEY: key,
};

function issues(src: Record<string, string | undefined>) {
  const r = parseEnv(src);
  if (r.ok) throw new Error("expected issues");
  return r.issues;
}

describe("parseEnv", () => {
  it("applies defaults", () => {
    const r = parseEnv(base);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.env.DATABASE_URL_DIRECT).toBe(base.DATABASE_URL);
    expect(r.env.DATABASE_POOL_MAX).toBe(10);
    expect(r.env.INVITATION_TTL_DAYS).toBe(7);
    expect(r.env.MIGRATE_ON_START).toBe(true);
    expect(r.env.BOOTSTRAP_ADMIN_NAME).toBe("Admin");
  });

  it("reports every issue by name, not just the first", () => {
    const names = issues({}).map((i) => i.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "DATABASE_URL",
        "BETTER_AUTH_SECRET",
        "BETTER_AUTH_URL",
        "CREDENTIALS_ENCRYPTION_KEY",
      ]),
    );
  });

  it("never echoes values", () => {
    const bad = {
      ...base,
      BETTER_AUTH_SECRET: "short-secret-value",
      CREDENTIALS_ENCRYPTION_KEY: "bad-key-value-xyz",
      DATABASE_URL: "mysql://user:pw-secret@host/db",
    };
    const text = JSON.stringify(issues(bad));
    for (const v of ["short-secret-value", "bad-key-value-xyz", "pw-secret"]) {
      expect(text).not.toContain(v);
    }
  });

  it("requires bootstrap email and password together", () => {
    expect(issues({ ...base, BOOTSTRAP_ADMIN_EMAIL: "a@example.com" }).map((i) => i.name)).toContain(
      "BOOTSTRAP_ADMIN_PASSWORD",
    );
    expect(issues({ ...base, BOOTSTRAP_ADMIN_PASSWORD: "x".repeat(12) }).map((i) => i.name)).toContain(
      "BOOTSTRAP_ADMIN_EMAIL",
    );
    expect(
      parseEnv({ ...base, BOOTSTRAP_ADMIN_EMAIL: "a@example.com", BOOTSTRAP_ADMIN_PASSWORD: "x".repeat(12) }).ok,
    ).toBe(true);
  });

  it("reports cross-field issues even when a base field fails", () => {
    const names = issues({ ...base, DATABASE_URL: undefined, DATABASE_URL_DIRECT: "mysql://x" }).map(
      (i) => i.name,
    );
    expect(names).toContain("DATABASE_URL");
    expect(names).toContain("DATABASE_URL_DIRECT");
    const names2 = issues({
      ...base,
      BOOTSTRAP_ADMIN_EMAIL: "a@example.com",
      DATABASE_POOL_MAX: "0",
    }).map((i) => i.name);
    expect(names2).toContain("BOOTSTRAP_ADMIN_PASSWORD");
    expect(names2).toContain("DATABASE_POOL_MAX");
  });

  it("accepts a 32-byte key as base64 or hex only", () => {
    expect(parseEnv({ ...base, CREDENTIALS_ENCRYPTION_KEY: randomBytes(32).toString("hex") }).ok).toBe(true);
    for (const bad of [randomBytes(16).toString("base64"), randomBytes(31).toString("hex"), "not a key"]) {
      expect(issues({ ...base, CREDENTIALS_ENCRYPTION_KEY: bad }).map((i) => i.name)).toContain(
        "CREDENTIALS_ENCRYPTION_KEY",
      );
    }
  });

  it("validates ranges and booleans", () => {
    expect(issues({ ...base, DATABASE_POOL_MAX: "0" }).map((i) => i.name)).toContain("DATABASE_POOL_MAX");
    expect(issues({ ...base, INVITATION_TTL_DAYS: "91" }).map((i) => i.name)).toContain("INVITATION_TTL_DAYS");
    const r = parseEnv({ ...base, MIGRATE_ON_START: "false" });
    expect(r.ok && r.env.MIGRATE_ON_START).toBe(false);
  });
});
