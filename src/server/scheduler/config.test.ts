import { describe, expect, it } from "vitest";
import {
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
