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
  /** Generation jobs (008): items claimed per tick, and the time a model call needs to be worth starting. */
  jobMaxItems?: number;
  jobMinCallMs?: number;
  jobPersistReserveMs?: number;
  jobMaxAttempts?: number;
  jobBackoffBaseMs?: number;
  jobBackoffMaxMs?: number;
}

/** The generation-jobs settings with defaults filled in (older hand-built configs omit them). */
export function jobConfig(config: SchedulerConfig) {
  return {
    maxItems: config.jobMaxItems ?? 2,
    minCallMs: config.jobMinCallMs ?? JOB_MIN_CALL_MS,
    persistReserveMs: config.jobPersistReserveMs ?? JOB_PERSIST_RESERVE_MS,
    maxAttempts: config.jobMaxAttempts ?? JOB_ITEM_MAX_ATTEMPTS,
    backoffBaseMs: config.jobBackoffBaseMs ?? JOB_BACKOFF_BASE_MS,
    backoffMaxMs: config.jobBackoffMaxMs ?? JOB_BACKOFF_MAX_MS,
    leaseMs: config.leaseMs,
    timeBudgetMs: config.timeBudgetMs,
  };
}

export const JOB_MIN_CALL_MS = 8_000;
export const JOB_PERSIST_RESERVE_MS = 3_000;
export const JOB_ITEM_MAX_ATTEMPTS = 3;
export const JOB_BACKOFF_BASE_MS = 60_000;
export const JOB_BACKOFF_MAX_MS = 900_000;

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
  | "GENERATION_TICK_MAX_ITEMS"
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
    jobMaxItems: env.GENERATION_TICK_MAX_ITEMS,
    jobMinCallMs: JOB_MIN_CALL_MS,
    jobPersistReserveMs: JOB_PERSIST_RESERVE_MS,
    jobMaxAttempts: JOB_ITEM_MAX_ATTEMPTS,
    jobBackoffBaseMs: JOB_BACKOFF_BASE_MS,
    jobBackoffMaxMs: JOB_BACKOFF_MAX_MS,
    ...overrides,
  };
}
