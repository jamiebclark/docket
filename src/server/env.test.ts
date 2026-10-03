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
  describe("scheduling configuration", () => {
    it("applies defaults", () => {
      const r = parseEnv({ ...base, NODE_ENV: "development" });
      if (!r.ok) throw new Error(JSON.stringify(r.issues));
      expect(r.env).toMatchObject({
        TICK_SECRET: undefined,
        WORKER_INTERVAL_SECONDS: 60,
        RUN_WORKER_IN_PROCESS: false,
        SCHEDULER_TICK_BUDGET_SECONDS: 20,
        SCHEDULER_TICK_MAX_ITEMS: 25,
        SCHEDULER_PROVIDER_TIMEOUT_SECONDS: 10,
        SCHEDULER_LEASE_SECONDS: 300,
        PUBLISH_MAX_ATTEMPTS: 5,
        PUBLISH_BACKOFF_BASE_SECONDS: 60,
        PUBLISH_BACKOFF_MAX_SECONDS: 3600,
        PUBLISH_MAX_DURATION_HOURS: 24,
        TOKEN_REFRESH_WINDOW_HOURS: 72,
        SCHEDULER_STALE_AFTER_MINUTES: 5,
        EXPLICIT_TIME_WARNING_MINUTES: 30,
        QUEUE_HORIZON_DAYS: 366,
        MOCK_PROVIDER_ENABLED: true,
      });
    });

    it.each([
      ["WORKER_INTERVAL_SECONDS", "29"],
      ["WORKER_INTERVAL_SECONDS", "61"],
      ["SCHEDULER_TICK_BUDGET_SECONDS", "4"],
      ["SCHEDULER_TICK_BUDGET_SECONDS", "26"],
      ["SCHEDULER_TICK_MAX_ITEMS", "0"],
      ["SCHEDULER_TICK_MAX_ITEMS", "501"],
      ["SCHEDULER_PROVIDER_TIMEOUT_SECONDS", "0"],
      ["SCHEDULER_PROVIDER_TIMEOUT_SECONDS", "21"],
      ["SCHEDULER_LEASE_SECONDS", "59"],
      ["SCHEDULER_LEASE_SECONDS", "3601"],
      ["PUBLISH_MAX_ATTEMPTS", "0"],
      ["PUBLISH_MAX_ATTEMPTS", "21"],
      ["PUBLISH_BACKOFF_BASE_SECONDS", "0"],
      ["PUBLISH_BACKOFF_MAX_SECONDS", "86401"],
      ["PUBLISH_MAX_DURATION_HOURS", "169"],
      ["TOKEN_REFRESH_WINDOW_HOURS", "721"],
      ["SCHEDULER_STALE_AFTER_MINUTES", "0"],
      ["EXPLICIT_TIME_WARNING_MINUTES", "-1"],
      ["QUEUE_HORIZON_DAYS", "6"],
      ["QUEUE_HORIZON_DAYS", "731"],
      ["RUN_WORKER_IN_PROCESS", "yes"],
      ["MOCK_PROVIDER_ENABLED", "1"],
    ])("rejects %s=%s", (name, value) => {
      expect(issues({ ...base, [name]: value }).map((i) => i.name)).toContain(name);
    });

    it("accepts the range edges and booleans", () => {
      const r = parseEnv({ ...base, WORKER_INTERVAL_SECONDS: "30", QUEUE_HORIZON_DAYS: "730", EXPLICIT_TIME_WARNING_MINUTES: "0", RUN_WORKER_IN_PROCESS: "true", MOCK_PROVIDER_ENABLED: "false" });
      if (!r.ok) throw new Error(JSON.stringify(r.issues));
      expect(r.env).toMatchObject({ WORKER_INTERVAL_SECONDS: 30, QUEUE_HORIZON_DAYS: 730, EXPLICIT_TIME_WARNING_MINUTES: 0, RUN_WORKER_IN_PROCESS: true, MOCK_PROVIDER_ENABLED: false });
    });

    it("accepts the smallest lease against the largest budget and timeout", () => {
      // The ranges (lease >= 60, budget <= 25, timeout <= 20) keep the lease rule satisfied; it guards future range changes.
      expect(parseEnv({ ...base, SCHEDULER_LEASE_SECONDS: "60", SCHEDULER_TICK_BUDGET_SECONDS: "25", SCHEDULER_PROVIDER_TIMEOUT_SECONDS: "20" }).ok).toBe(true);
    });

    it("requires the provider timeout to be less than the tick budget", () => {
      expect(issues({ ...base, SCHEDULER_PROVIDER_TIMEOUT_SECONDS: "10", SCHEDULER_TICK_BUDGET_SECONDS: "10" }).map((i) => i.name)).toContain("SCHEDULER_PROVIDER_TIMEOUT_SECONDS");
      expect(parseEnv({ ...base, SCHEDULER_PROVIDER_TIMEOUT_SECONDS: "9", SCHEDULER_TICK_BUDGET_SECONDS: "10" }).ok).toBe(true);
    });

    it("requires the backoff cap to be at least the base", () => {
      expect(issues({ ...base, PUBLISH_BACKOFF_BASE_SECONDS: "120", PUBLISH_BACKOFF_MAX_SECONDS: "60" }).map((i) => i.name)).toContain("PUBLISH_BACKOFF_MAX_SECONDS");
      expect(parseEnv({ ...base, PUBLISH_BACKOFF_BASE_SECONDS: "60", PUBLISH_BACKOFF_MAX_SECONDS: "60" }).ok).toBe(true);
    });

    it("TICK_SECRET: short is rejected, empty means unset, long is kept", () => {
      expect(issues({ ...base, TICK_SECRET: "short-secret" }).map((i) => i.name)).toContain("TICK_SECRET");
      const empty = parseEnv({ ...base, TICK_SECRET: "" });
      if (!empty.ok) throw new Error(JSON.stringify(empty.issues));
      expect(empty.env.TICK_SECRET).toBeUndefined();
      const ok = parseEnv({ ...base, TICK_SECRET: "t".repeat(32) });
      if (!ok.ok) throw new Error(JSON.stringify(ok.issues));
      expect(ok.env.TICK_SECRET).toBe("t".repeat(32));
    });

    it("MOCK_PROVIDER_ENABLED defaults off in production and on elsewhere", () => {
      const prev = process.env.NODE_ENV;
      try {
        (process.env as Record<string, string>).NODE_ENV = "production";
        const prod = parseEnv(base);
        if (!prod.ok) throw new Error(JSON.stringify(prod.issues));
        expect(prod.env.MOCK_PROVIDER_ENABLED).toBe(false);
        const forced = parseEnv({ ...base, MOCK_PROVIDER_ENABLED: "true" });
        if (!forced.ok) throw new Error(JSON.stringify(forced.issues));
        expect(forced.env.MOCK_PROVIDER_ENABLED).toBe(true);
      } finally {
        (process.env as Record<string, string | undefined>).NODE_ENV = prev;
      }
    });

    it("messages never contain values", () => {
      const secret = "short-secret-VALUE";
      const out = JSON.stringify(issues({ ...base, TICK_SECRET: secret, SCHEDULER_LEASE_SECONDS: "31337", QUEUE_HORIZON_DAYS: "9999" }));
      expect(out).not.toContain(secret);
      expect(out).not.toContain("31337");
      expect(out).not.toContain("9999");
    });
  });
});
