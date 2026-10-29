import { describe, expect, it } from "vitest";
import { parseEnv } from "../env";
import {
  ENGAGEMENT_DEFAULTS,
  engagementConfig,
  INSIGHTS_DEFAULTS,
  insightsConfig,
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
  it("defaults to a share of the tick budget, so engagement cannot work to the tick deadline", () => {
    expect(engagementConfig(base).timeBudgetMs).toBe(16_000);
  });

  it("honours an explicit share", () => {
    expect(engagementConfig({ ...base, engagementTimeShare: 0.25 }).timeBudgetMs).toBe(5_000);
  });

  it("never exceeds the tick budget itself", () => {
    expect(engagementConfig({ ...base, engagementTimeShare: 1 }).timeBudgetMs).toBeLessThanOrEqual(base.timeBudgetMs);
  });
});

describe("insightsConfig", () => {
  it("defaults every field when not set", () => {
    const cfg = insightsConfig(base);
    expect(cfg.readPageSize).toBe(INSIGHTS_DEFAULTS.readPageSize);
    expect(cfg.targetsPerRun).toBe(INSIGHTS_DEFAULTS.targetsPerRun);
    expect(cfg.accountsPerRun).toBe(INSIGHTS_DEFAULTS.accountsPerRun);
    expect(cfg.pollMinIntervalMs).toBe(INSIGHTS_DEFAULTS.pollMinIntervalMs);
    expect(cfg.accountPollIntervalMs).toBe(INSIGHTS_DEFAULTS.accountPollIntervalMs);
    expect(cfg.readReserve).toBe(INSIGHTS_DEFAULTS.readReserve);
    expect(cfg.retentionDays).toBe(INSIGHTS_DEFAULTS.retentionDays);
    expect(cfg.pruneBatch).toBe(INSIGHTS_DEFAULTS.pruneBatch);
  });

  it("honours overrides", () => {
    const cfg = insightsConfig({
      ...base,
      insightsReadPageSize: 10,
      insightsTargetsPerRun: 100,
      insightsAccountsPerRun: 40,
      insightsPollMinIntervalMs: 1_800_000,
      insightsAccountPollIntervalMs: 43_200_000,
      insightsReadReserve: 0.75,
      insightsRetentionDays: 200,
      insightsPruneBatch: 500,
    });
    expect(cfg.readPageSize).toBe(10);
    expect(cfg.targetsPerRun).toBe(100);
    expect(cfg.accountsPerRun).toBe(40);
    expect(cfg.pollMinIntervalMs).toBe(1_800_000);
    expect(cfg.accountPollIntervalMs).toBe(43_200_000);
    expect(cfg.readReserve).toBe(0.75);
    expect(cfg.retentionDays).toBe(200);
    expect(cfg.pruneBatch).toBe(500);
  });

  it("forwards the lease unchanged but only a share of the tick budget", () => {
    const cfg = insightsConfig(base);
    expect(cfg.leaseMs).toBe(base.leaseMs);
    // Deliberately not the whole budget, and below engagement's share: see INSIGHTS_TIME_SHARE in config.ts.
    expect(cfg.timeBudgetMs).toBeLessThan(base.timeBudgetMs);
  });
});

describe("insights env vars", () => {
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
    expect(r.env.INSIGHTS_READ_PAGE_SIZE).toBe(25);
    expect(r.env.INSIGHTS_TARGETS_PER_RUN).toBe(50);
    expect(r.env.INSIGHTS_ACCOUNTS_PER_RUN).toBe(20);
    expect(r.env.INSIGHTS_POLL_MIN_INTERVAL_SECONDS).toBe(900);
    expect(r.env.INSIGHTS_ACCOUNT_POLL_INTERVAL_SECONDS).toBe(21600);
    expect(r.env.INSIGHTS_TIME_SHARE).toBe(0.3);
    expect(r.env.INSIGHTS_READ_RESERVE).toBe(0.5);
    expect(r.env.INSIGHTS_RETENTION_DAYS).toBe(400);
    expect(r.env.INSIGHTS_PRUNE_BATCH).toBe(200);
  });

  it("rejects out-of-range values", () => {
    const cases: [string, string][] = [
      ["INSIGHTS_READ_PAGE_SIZE", "101"],
      ["INSIGHTS_TARGETS_PER_RUN", "0"],
      ["INSIGHTS_ACCOUNTS_PER_RUN", "0"],
      ["INSIGHTS_POLL_MIN_INTERVAL_SECONDS", "59"],
      ["INSIGHTS_ACCOUNT_POLL_INTERVAL_SECONDS", "299"],
      ["INSIGHTS_TIME_SHARE", "1.5"],
      ["INSIGHTS_READ_RESERVE", "-0.1"],
      ["INSIGHTS_RETENTION_DAYS", "0"],
      ["INSIGHTS_PRUNE_BATCH", "0"],
    ];
    for (const [name, value] of cases) {
      const r = parseEnv({ ...baseEnv, [name]: value });
      expect(r.ok, `${name}=${value} should be rejected`).toBe(false);
      if (!r.ok) expect(r.issues.map((i) => i.name)).toContain(name);
    }
  });
});

describe("insights time share", () => {
  // `runInsightsPoll` refuses to begin unless `providerTimeoutMs` still remains, so a share worth
  // less than one provider call is not a small share — it is the section never running, silently,
  // for the life of the install. 0.3 of the stock 25s tick is 7.5s against a 10s timeout, which is
  // exactly what shipped and exactly why nothing was ever polled on any platform.
  it("is floored at one provider call plus a margin, so the section can always start", () => {
    // 0.3 × 20_000 = 6_000, below the 10_000 timeout — floored to 12_000.
    expect(insightsConfig(base).timeBudgetMs).toBe(12_000);
    expect(insightsConfig(base).timeBudgetMs).toBeGreaterThan(base.providerTimeoutMs);
  });

  it("honours an explicit share once it clears the floor", () => {
    expect(insightsConfig({ ...base, insightsTimeShare: 0.8 }).timeBudgetMs).toBe(16_000);
  });

  it("raises a share that would leave too little for one call", () => {
    expect(insightsConfig({ ...base, insightsTimeShare: 0.05 }).timeBudgetMs).toBe(12_000);
  });

  it("never exceeds the tick budget itself", () => {
    expect(insightsConfig({ ...base, insightsTimeShare: 1 }).timeBudgetMs).toBeLessThanOrEqual(base.timeBudgetMs);
    // Even when the floor itself does not fit: a tick this small cannot make a provider call at all.
    const tiny = { ...base, timeBudgetMs: 5_000 };
    expect(insightsConfig(tiny).timeBudgetMs).toBeLessThanOrEqual(tiny.timeBudgetMs);
  });

  it("treats an explicit zero as an off switch, not a share to be raised", () => {
    expect(insightsConfig({ ...base, insightsTimeShare: 0 }).timeBudgetMs).toBe(0);
  });

  it("the SHIPPED defaults leave room for a call, which is what was never checked", () => {
    const shipped: SchedulerConfig = { ...base, timeBudgetMs: 25_000, providerTimeoutMs: 10_000 };
    expect(insightsConfig(shipped).timeBudgetMs).toBeGreaterThan(shipped.providerTimeoutMs);
  });
});
