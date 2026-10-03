import type { Env } from "../env";

export interface SchedulerConfig {
  timeBudgetMs: number;
  maxItems: number;
  leaseMs: number;
  providerTimeoutMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  maxPublishDurationMs: number;
  refreshWindowMs: number;
  refreshMaxAccounts: number;
  batchSize: number;
}

type EnvLike = Pick<
  Env,
  | "SCHEDULER_TICK_BUDGET_SECONDS"
  | "SCHEDULER_TICK_MAX_ITEMS"
  | "SCHEDULER_LEASE_SECONDS"
  | "SCHEDULER_PROVIDER_TIMEOUT_SECONDS"
  | "PUBLISH_MAX_ATTEMPTS"
  | "PUBLISH_BACKOFF_BASE_SECONDS"
  | "PUBLISH_BACKOFF_MAX_SECONDS"
  | "PUBLISH_MAX_DURATION_HOURS"
  | "TOKEN_REFRESH_WINDOW_HOURS"
>;

/** `overrides` is for tests. */
export function schedulerConfig(env: EnvLike, overrides: Partial<SchedulerConfig> = {}): SchedulerConfig {
  return {
    timeBudgetMs: env.SCHEDULER_TICK_BUDGET_SECONDS * 1000,
    maxItems: env.SCHEDULER_TICK_MAX_ITEMS,
    leaseMs: env.SCHEDULER_LEASE_SECONDS * 1000,
    providerTimeoutMs: env.SCHEDULER_PROVIDER_TIMEOUT_SECONDS * 1000,
    maxAttempts: env.PUBLISH_MAX_ATTEMPTS,
    backoffBaseMs: env.PUBLISH_BACKOFF_BASE_SECONDS * 1000,
    backoffMaxMs: env.PUBLISH_BACKOFF_MAX_SECONDS * 1000,
    maxPublishDurationMs: env.PUBLISH_MAX_DURATION_HOURS * 3_600_000,
    refreshWindowMs: env.TOKEN_REFRESH_WINDOW_HOURS * 3_600_000,
    refreshMaxAccounts: 5,
    batchSize: 4,
    ...overrides,
  };
}
