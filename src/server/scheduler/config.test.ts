import { describe, expect, it } from "vitest";
import { parseEnv } from "../env";
import {
  ENGAGEMENT_DEFAULTS,
  engagementConfig,
  STANDING_SERIES_MAX_POSTS_DEFAULT,
  STANDING_SERIES_MAX_SERIES_DEFAULT,
  standingSeriesConfig,
  type SchedulerConfig,
} from "./config";

const base: SchedulerConfig = {
  timeBudgetMs: 20_000,
  maxItems: 25,
  leaseMs: 300_000,
  providerTimeoutMs: 10_000,
  maxAttempts: 5,
  backoffBaseMs: 60_000,
  backoffMaxMs: 3_600_000,
  maxPublishDurationMs: 86_400_000,
  refreshWindowMs: 259_200_000,
  refreshMaxAccounts: 5,
  batchSize: 4,
};

describe("standingSeriesConfig", () => {
  it("defaults maxSeries and maxPosts when not set", () => {
    const cfg = standingSeriesConfig(base);
    expect(cfg.maxSeries).toBe(STANDING_SERIES_MAX_SERIES_DEFAULT);
    expect(cfg.maxPosts).toBe(STANDING_SERIES_MAX_POSTS_DEFAULT);
  });

  it("honours overrides", () => {
    const cfg = standingSeriesConfig({ ...base, standingSeriesMaxSeries: 5, standingSeriesMaxPosts: 7 });
    expect(cfg.maxSeries).toBe(5);
    expect(cfg.maxPosts).toBe(7);
  });

  it("forwards the shared lease and budget fields", () => {
    const cfg = standingSeriesConfig(base);
    expect(cfg.leaseMs).toBe(base.leaseMs);
    expect(cfg.timeBudgetMs).toBe(base.timeBudgetMs);
  });
});

describe("engagementConfig", () => {
  it("defaults every field when not set", () => {
    const cfg = engagementConfig(base);
    expect(cfg.retentionDays).toBe(ENGAGEMENT_DEFAULTS.retentionDays);
    expect(cfg.readPageSize).toBe(ENGAGEMENT_DEFAULTS.readPageSize);
    expect(cfg.readPagesPerRun).toBe(ENGAGEMENT_DEFAULTS.readPagesPerRun);
    expect(cfg.readMinIntervalMs).toBe(ENGAGEMENT_DEFAULTS.readMinIntervalMs);
    expect(cfg.sendsPerTick).toBe(ENGAGEMENT_DEFAULTS.sendsPerTick);
    expect(cfg.writeReserve).toBe(ENGAGEMENT_DEFAULTS.writeReserve);
    expect(cfg.pruneBatch).toBe(ENGAGEMENT_DEFAULTS.pruneBatch);
  });

  it("honours overrides", () => {
    const cfg = engagementConfig({
      ...base,
      engagementRetentionDays: 30,
      engagementReadPageSize: 25,
      engagementReadPagesPerRun: 5,
      engagementReadMinIntervalMs: 120_000,
      engagementSendsPerTick: 10,
      engagementWriteReserve: 0.5,
      engagementPruneBatch: 500,
    });
    expect(cfg.retentionDays).toBe(30);
    expect(cfg.readPageSize).toBe(25);
    expect(cfg.readPagesPerRun).toBe(5);
    expect(cfg.readMinIntervalMs).toBe(120_000);
    expect(cfg.sendsPerTick).toBe(10);
    expect(cfg.writeReserve).toBe(0.5);
    expect(cfg.pruneBatch).toBe(500);
  });

  it("forwards the lease unchanged but only a share of the tick budget", () => {
    const cfg = engagementConfig(base);
    expect(cfg.leaseMs).toBe(base.leaseMs);
    // Deliberately not the whole budget: see ENGAGEMENT_TIME_SHARE in config.ts.
    expect(cfg.timeBudgetMs).toBeLessThan(base.timeBudgetMs);
  });
});

describe("engagement env vars", () => {
  const key = "a".repeat(64);
  const baseEnv = {
    DATABASE_URL: "postgres://u:pw@localhost:5432/docket",
    BETTER_AUTH_SECRET: "s".repeat(32),
    BETTER_AUTH_URL: "http://localhost:3000",
    CREDENTIALS_ENCRYPTION_KEY: key,
  };

  it("parses with documented defaults", () => {
    const r = parseEnv(baseEnv);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.env.ENGAGEMENT_RETENTION_DAYS).toBe(90);
    expect(r.env.ENGAGEMENT_READ_PAGE_SIZE).toBe(50);
    expect(r.env.ENGAGEMENT_READ_PAGES_PER_RUN).toBe(3);
    expect(r.env.ENGAGEMENT_READ_MIN_INTERVAL_SECONDS).toBe(60);
    expect(r.env.ENGAGEMENT_SENDS_PER_TICK).toBe(5);
    expect(r.env.ENGAGEMENT_WRITE_RESERVE).toBe(0.25);
    expect(r.env.ENGAGEMENT_PRUNE_BATCH).toBe(200);
  });

  it("rejects out-of-range values", () => {
    const cases: [string, string][] = [
      ["ENGAGEMENT_RETENTION_DAYS", "0"],
      ["ENGAGEMENT_READ_PAGE_SIZE", "101"],
      ["ENGAGEMENT_READ_PAGES_PER_RUN", "0"],
      ["ENGAGEMENT_READ_MIN_INTERVAL_SECONDS", "5"],
      ["ENGAGEMENT_SENDS_PER_TICK", "51"],
      ["ENGAGEMENT_WRITE_RESERVE", "1.5"],
      ["ENGAGEMENT_PRUNE_BATCH", "0"],
    ];
    for (const [name, value] of cases) {
      const r = parseEnv({ ...baseEnv, [name]: value });
      expect(r.ok, `${name}=${value} should be rejected`).toBe(false);
      if (!r.ok) expect(r.issues.map((i) => i.name)).toContain(name);
    }
  });
});

describe("engagement time share", () => {
  it("defaults to half the tick budget, so engagement cannot work to the tick deadline", () => {
    expect(engagementConfig(base).timeBudgetMs).toBe(10_000);
  });

  it("honours an explicit share", () => {
    expect(engagementConfig({ ...base, engagementTimeShare: 0.25 }).timeBudgetMs).toBe(5_000);
  });

  it("never exceeds the tick budget itself", () => {
    expect(engagementConfig({ ...base, engagementTimeShare: 1 }).timeBudgetMs).toBeLessThanOrEqual(base.timeBudgetMs);
  });
});
