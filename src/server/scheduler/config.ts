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
  /** Standing series (071): series claimed per tick, posts one claimed series may produce per tick. */
  standingSeriesMaxSeries?: number;
  standingSeriesMaxPosts?: number;
  /** Outgoing webhooks (009). */
  webhookMaxPerTick?: number;
  webhookConcurrency?: number;
  webhookTimeoutMs?: number;
  webhookMaxAttempts?: number;
  webhookBackoffBaseMs?: number;
  webhookBackoffMaxMs?: number;
  webhookDisableAfterFailures?: number;
  webhookRetentionDays?: number;
  webhookMinWindowMs?: number;
  /** Outgoing email (044). */
  emailMaxPerTick?: number;
  emailConcurrency?: number;
  emailMinWindowMs?: number;
  emailBackoffBaseMs?: number;
  emailBackoffMaxMs?: number;
  emailPauseAfterFailures?: number;
  emailUnavailableRetryMs?: number;
  emailRetentionDays?: number;
  /** Engagement inbox (077): reads and sends claimed per tick, write-budget reserve, retention. */
  engagementRetentionDays?: number;
  engagementReadPageSize?: number;
  engagementReadPagesPerRun?: number;
  engagementReadMinIntervalMs?: number;
  engagementSendsPerTick?: number;
  engagementWriteReserve?: number;
  engagementTimeShare?: number;
  engagementPruneBatch?: number;
  /** Post and account insights polling (079): reads claimed per tick, cadence floors, read-budget reserve, retention. */
  insightsReadPageSize?: number;
  insightsTargetsPerRun?: number;
  insightsAccountsPerRun?: number;
  insightsPollMinIntervalMs?: number;
  insightsAccountPollIntervalMs?: number;
  insightsTimeShare?: number;
  insightsReadReserve?: number;
  insightsRetentionDays?: number;
  insightsPruneBatch?: number;
}

export const WEBHOOK_DEFAULTS = {
  maxPerTick: 10,
  concurrency: 4,
  timeoutMs: 10_000,
  maxAttempts: 8,
  backoffBaseMs: 60_000,
  backoffMaxMs: 21_600_000,
  disableAfterFailures: 20,
  retentionDays: 30,
  minWindowMs: 11_000,
} as const;

/** The webhook-delivery settings with defaults filled in. */
export function webhookConfig(config: SchedulerConfig) {
  return {
    maxPerTick: config.webhookMaxPerTick ?? WEBHOOK_DEFAULTS.maxPerTick,
    concurrency: config.webhookConcurrency ?? WEBHOOK_DEFAULTS.concurrency,
    timeoutMs: config.webhookTimeoutMs ?? WEBHOOK_DEFAULTS.timeoutMs,
    maxAttempts: config.webhookMaxAttempts ?? WEBHOOK_DEFAULTS.maxAttempts,
    backoffBaseMs: config.webhookBackoffBaseMs ?? WEBHOOK_DEFAULTS.backoffBaseMs,
    backoffMaxMs: config.webhookBackoffMaxMs ?? WEBHOOK_DEFAULTS.backoffMaxMs,
    disableAfterFailures: config.webhookDisableAfterFailures ?? WEBHOOK_DEFAULTS.disableAfterFailures,
    retentionDays: config.webhookRetentionDays ?? WEBHOOK_DEFAULTS.retentionDays,
    minWindowMs: config.webhookMinWindowMs ?? WEBHOOK_DEFAULTS.minWindowMs,
    leaseMs: config.leaseMs,
    timeBudgetMs: config.timeBudgetMs,
  };
}

export const EMAIL_DEFAULTS = {
  maxPerTick: 50,
  concurrency: 8,
  minWindowMs: 11_000,
  backoffBaseMs: 60_000,
  backoffMaxMs: 21_600_000,
  pauseAfterFailures: 5,
  unavailableRetryMs: 3_600_000,
  retentionDays: 30,
} as const;

/** The email-delivery settings with defaults filled in. */
export function emailConfig(config: SchedulerConfig) {
  return {
    maxPerTick: config.emailMaxPerTick ?? EMAIL_DEFAULTS.maxPerTick,
    concurrency: config.emailConcurrency ?? EMAIL_DEFAULTS.concurrency,
    minWindowMs: config.emailMinWindowMs ?? EMAIL_DEFAULTS.minWindowMs,
    backoffBaseMs: config.emailBackoffBaseMs ?? EMAIL_DEFAULTS.backoffBaseMs,
    backoffMaxMs: config.emailBackoffMaxMs ?? EMAIL_DEFAULTS.backoffMaxMs,
    pauseAfterFailures: config.emailPauseAfterFailures ?? EMAIL_DEFAULTS.pauseAfterFailures,
    unavailableRetryMs: config.emailUnavailableRetryMs ?? EMAIL_DEFAULTS.unavailableRetryMs,
    retentionDays: config.emailRetentionDays ?? EMAIL_DEFAULTS.retentionDays,
    leaseMs: config.leaseMs,
    timeBudgetMs: config.timeBudgetMs,
  };
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

/** The standing-series section's settings with defaults filled in; physical constants shared with jobs (S23). */
export function standingSeriesConfig(config: SchedulerConfig) {
  return {
    maxSeries: config.standingSeriesMaxSeries ?? STANDING_SERIES_MAX_SERIES_DEFAULT,
    maxPosts: config.standingSeriesMaxPosts ?? STANDING_SERIES_MAX_POSTS_DEFAULT,
    minCallMs: JOB_MIN_CALL_MS,
    persistReserveMs: JOB_PERSIST_RESERVE_MS,
    maxAttempts: JOB_ITEM_MAX_ATTEMPTS,
    backoffBaseMs: JOB_BACKOFF_BASE_MS,
    backoffMaxMs: JOB_BACKOFF_MAX_MS,
    leaseMs: config.leaseMs,
    timeBudgetMs: config.timeBudgetMs,
  };
}

export const ENGAGEMENT_DEFAULTS = {
  retentionDays: 90,
  readPageSize: 50,
  readPagesPerRun: 3,
  readMinIntervalMs: 60_000,
  sendsPerTick: 5,
  writeReserve: 0.25,
  timeShare: 0.8,
  pruneBatch: 200,
} as const;

/** The engagement inbox's settings with defaults filled in. */
export function engagementConfig(config: SchedulerConfig) {
  return {
    retentionDays: config.engagementRetentionDays ?? ENGAGEMENT_DEFAULTS.retentionDays,
    readPageSize: config.engagementReadPageSize ?? ENGAGEMENT_DEFAULTS.readPageSize,
    readPagesPerRun: config.engagementReadPagesPerRun ?? ENGAGEMENT_DEFAULTS.readPagesPerRun,
    readMinIntervalMs: config.engagementReadMinIntervalMs ?? ENGAGEMENT_DEFAULTS.readMinIntervalMs,
    sendsPerTick: config.engagementSendsPerTick ?? ENGAGEMENT_DEFAULTS.sendsPerTick,
    writeReserve: config.engagementWriteReserve ?? ENGAGEMENT_DEFAULTS.writeReserve,
    pruneBatch: config.engagementPruneBatch ?? ENGAGEMENT_DEFAULTS.pruneBatch,
    leaseMs: config.leaseMs,
    // Engagement takes a share of the tick, never all of it. Every section computes its deadline
    // from the same startedAt and they run concurrently, so a section that works to the very end
    // of the budget starves the ones that predate it: token refresh skips an account silently,
    // counting nothing, once now plus providerTimeoutMs passes the deadline.
    timeBudgetMs: Math.floor(config.timeBudgetMs * (config.engagementTimeShare ?? ENGAGEMENT_DEFAULTS.timeShare)),
  };
}

export const INSIGHTS_DEFAULTS = {
  readPageSize: 25,
  targetsPerRun: 50,
  accountsPerRun: 20,
  pollMinIntervalMs: 900_000,
  accountPollIntervalMs: 21_600_000,
  timeShare: 0.3,
  readReserve: 0.5,
  retentionDays: 400,
  pruneBatch: 200,
} as const;

/** The insights polling settings with defaults filled in. */
export function insightsConfig(config: SchedulerConfig) {
  return {
    readPageSize: config.insightsReadPageSize ?? INSIGHTS_DEFAULTS.readPageSize,
    targetsPerRun: config.insightsTargetsPerRun ?? INSIGHTS_DEFAULTS.targetsPerRun,
    accountsPerRun: config.insightsAccountsPerRun ?? INSIGHTS_DEFAULTS.accountsPerRun,
    pollMinIntervalMs: config.insightsPollMinIntervalMs ?? INSIGHTS_DEFAULTS.pollMinIntervalMs,
    accountPollIntervalMs: config.insightsAccountPollIntervalMs ?? INSIGHTS_DEFAULTS.accountPollIntervalMs,
    readReserve: config.insightsReadReserve ?? INSIGHTS_DEFAULTS.readReserve,
    retentionDays: config.insightsRetentionDays ?? INSIGHTS_DEFAULTS.retentionDays,
    pruneBatch: config.insightsPruneBatch ?? INSIGHTS_DEFAULTS.pruneBatch,
    leaseMs: config.leaseMs,
    // Insights takes a share of the tick, never all of it, below engagement's share since it is the
    // least urgent section: see ENGAGEMENT_TIME_SHARE above and research.md §6.
    //
    // The share is floored at one provider call plus a margin to start it. `runInsightsPoll` will
    // not begin unless `providerTimeoutMs` remains, so a share smaller than that is not "a small
    // share" — it is the section never running at all, silently, for the life of the install. At
    // the stock 25s tick and 10s provider timeout the old 0.3 share gave 7.5s and did exactly that:
    // every tick counted `outOfBudget` and returned, and nothing was ever polled on any platform.
    // Tests never caught it because `tickConfig()` pins a 120s budget, so the defaults that ship
    // were the one configuration never exercised.
    timeBudgetMs: insightsTimeBudgetMs(config),
  };
}

/** Exported for the test that pins the shipped defaults against the gate in `runInsightsPoll`. */
export function insightsTimeBudgetMs(config: SchedulerConfig): number {
  const configured = config.insightsTimeShare ?? INSIGHTS_DEFAULTS.timeShare;
  // An explicit 0 is an off switch and stays one: the floor exists to stop a SMALL share silently
  // disabling the section, not to override an operator who asked for it off.
  if (configured <= 0) return 0;
  const share = Math.floor(config.timeBudgetMs * configured);
  const floor = config.providerTimeoutMs + INSIGHTS_START_MARGIN_MS;
  // Still never more than the tick itself: if the floor does not fit, the tick budget is too small
  // for any section to make a provider call and raising insights' share would not change that.
  return Math.min(Math.max(share, floor), config.timeBudgetMs);
}

/** Headroom over one provider call: enough for the claim and the first request to get away. */
export const INSIGHTS_START_MARGIN_MS = 2_000;

export const STANDING_SERIES_MAX_SERIES_DEFAULT = 2;
export const STANDING_SERIES_MAX_POSTS_DEFAULT = 2;

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
  | "STANDING_SERIES_TICK_MAX_SERIES"
  | "STANDING_SERIES_TICK_MAX_POSTS"
  | "ENGAGEMENT_RETENTION_DAYS"
  | "ENGAGEMENT_READ_PAGE_SIZE"
  | "ENGAGEMENT_READ_PAGES_PER_RUN"
  | "ENGAGEMENT_READ_MIN_INTERVAL_SECONDS"
  | "ENGAGEMENT_SENDS_PER_TICK"
  | "ENGAGEMENT_WRITE_RESERVE"
  | "ENGAGEMENT_TIME_SHARE"
  | "ENGAGEMENT_PRUNE_BATCH"
  | "INSIGHTS_READ_PAGE_SIZE"
  | "INSIGHTS_TARGETS_PER_RUN"
  | "INSIGHTS_ACCOUNTS_PER_RUN"
  | "INSIGHTS_POLL_MIN_INTERVAL_SECONDS"
  | "INSIGHTS_ACCOUNT_POLL_INTERVAL_SECONDS"
  | "INSIGHTS_TIME_SHARE"
  | "INSIGHTS_READ_RESERVE"
  | "INSIGHTS_RETENTION_DAYS"
  | "INSIGHTS_PRUNE_BATCH"
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
    standingSeriesMaxSeries: env.STANDING_SERIES_TICK_MAX_SERIES,
    standingSeriesMaxPosts: env.STANDING_SERIES_TICK_MAX_POSTS,
    engagementRetentionDays: env.ENGAGEMENT_RETENTION_DAYS,
    engagementReadPageSize: env.ENGAGEMENT_READ_PAGE_SIZE,
    engagementReadPagesPerRun: env.ENGAGEMENT_READ_PAGES_PER_RUN,
    engagementReadMinIntervalMs: env.ENGAGEMENT_READ_MIN_INTERVAL_SECONDS * 1000,
    engagementSendsPerTick: env.ENGAGEMENT_SENDS_PER_TICK,
    engagementWriteReserve: env.ENGAGEMENT_WRITE_RESERVE,
    engagementTimeShare: env.ENGAGEMENT_TIME_SHARE,
    engagementPruneBatch: env.ENGAGEMENT_PRUNE_BATCH,
    insightsReadPageSize: env.INSIGHTS_READ_PAGE_SIZE,
    insightsTargetsPerRun: env.INSIGHTS_TARGETS_PER_RUN,
    insightsAccountsPerRun: env.INSIGHTS_ACCOUNTS_PER_RUN,
    insightsPollMinIntervalMs: env.INSIGHTS_POLL_MIN_INTERVAL_SECONDS * 1000,
    insightsAccountPollIntervalMs: env.INSIGHTS_ACCOUNT_POLL_INTERVAL_SECONDS * 1000,
    insightsTimeShare: env.INSIGHTS_TIME_SHARE,
    insightsReadReserve: env.INSIGHTS_READ_RESERVE,
    insightsRetentionDays: env.INSIGHTS_RETENTION_DAYS,
    insightsPruneBatch: env.INSIGHTS_PRUNE_BATCH,
    ...overrides,
  };
}
