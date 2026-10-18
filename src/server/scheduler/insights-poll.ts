// scheduler/insights-poll: the insights-poll section of a tick (contracts/scheduler-insights.md).
import { findProvider, listProviders } from "../../providers/registry";
import type { AccountMetricsReadResult, InsightsSupport, MetricKeyDeclaration, PostMetricEntry, PostMetricsReadResult } from "../../providers/types";
import * as clock from "../dal/clock";
import {
  claimDueAccountMetricPolls,
  claimDuePostMetricPolls,
  countAccountsMissingInsightsScopes,
  countPublishedWithoutExternalId,
  type ClaimedAccountMetricPoll,
  type ClaimedPostMetricPoll,
  type InsightsProviderRule,
} from "../dal/insights-claims";
import { forSchedulerProject, type ClaimedAccount } from "../dal/scheduler";
import { writeHeartbeat } from "../dal/heartbeats";
import { decryptCredentials } from "../services/accounts";
import { nextAccountPollAt, postPollDecision } from "../../lib/insights/schedule";
import { nextRetryAt } from "./backoff";
import { insightsConfig, type SchedulerConfig } from "./config";
import { markInvalidEmitting } from "./credentials";
import { checkInsightsAllowance } from "./insights-budget";
import { redact, secretValues } from "./redact";

export interface InsightsPollCounts {
  targetsClaimed: number;
  accountsClaimed: number;
  postSnapshotsWritten: number;
  accountSnapshotsWritten: number;
  targetsFrozen: number;
  targetsFrozenExpired: number;
  targetsFrozenSettled: number;
  targetsUnqueryable: number;
  postsGone: number;
  targetsSkippedNoExternalId: number;
  accountsSkippedNoPermission: number;
  deferredForAllowance: number;
  retried: number;
  rateLimited: number;
  credentialsInvalid: number;
  unavailable: number;
  failed: number;
  outOfBudget: number;
}

export const emptyInsightsPollCounts = (): InsightsPollCounts => ({
  targetsClaimed: 0,
  accountsClaimed: 0,
  postSnapshotsWritten: 0,
  accountSnapshotsWritten: 0,
  targetsFrozen: 0,
  targetsFrozenExpired: 0,
  targetsFrozenSettled: 0,
  targetsUnqueryable: 0,
  postsGone: 0,
  targetsSkippedNoExternalId: 0,
  accountsSkippedNoPermission: 0,
  deferredForAllowance: 0,
  retried: 0,
  rateLimited: 0,
  credentialsInvalid: 0,
  unavailable: 0,
  failed: 0,
  outOfBudget: 0,
});

type AccountInfo = Pick<ClaimedAccount, "id" | "projectId" | "providerKey" | "settings" | "externalAccountId" | "displayName" | "publishLimitCount" | "publishLimitWindowSeconds">;

/**
 * Claims accounts and targets due for a metrics read, calls the provider's reads outside any
 * transaction, and commits each batch together with its poll-state updates — so a kill mid-read
 * resumes with no manual step and never advances a schedule on failure (contracts/scheduler-insights.md).
 */
export async function runInsightsPoll(opts: { config: SchedulerConfig; tickId: string; startedAt: Date }): Promise<InsightsPollCounts> {
  const cfg = insightsConfig(opts.config);
  const counts = emptyInsightsPollCounts();
  const deadline = opts.startedAt.getTime() + cfg.timeBudgetMs;

  // FR-003: a declared-but-unavailable surface is never claimed, so no call is ever attempted for it.
  const providers: InsightsProviderRule[] = listProviders()
    .filter((p) => p.insights && !p.insights.declaration.unavailable)
    .map((p) => ({
      providerKey: p.key,
      requiredScopes: p.insights?.declaration.requiredScopes ?? [],
      ephemeralPostTypes: p.insights?.declaration.ephemeralPostTypes ?? [],
    }));

  if (providers.length === 0) {
    await writeHeartbeat("insights_poll", await clock.now(), { ...counts });
    return counts;
  }

  let now = await clock.now();
  if (deadline - now.getTime() < opts.config.providerTimeoutMs) {
    counts.outOfBudget++;
    await writeHeartbeat("insights_poll", now, { ...counts });
    return counts;
  }

  const accounts = await claimDueAccountMetricPolls({ now, limit: cfg.accountsPerRun, leaseMs: opts.config.leaseMs, providers });
  const targets = await claimDuePostMetricPolls({ now, limit: cfg.targetsPerRun, leaseMs: opts.config.leaseMs, minIntervalMs: cfg.pollMinIntervalMs, providers });
  counts.accountsClaimed = accounts.length;
  counts.targetsClaimed = targets.length;
  counts.targetsSkippedNoExternalId = await countPublishedWithoutExternalId(providers);
  counts.accountsSkippedNoPermission = await countAccountsMissingInsightsScopes(providers);

  const targetsByAccount = new Map<string, ClaimedPostMetricPoll[]>();
  for (const t of targets) {
    const list = targetsByAccount.get(t.state.socialAccountId) ?? [];
    list.push(t);
    targetsByAccount.set(t.state.socialAccountId, list);
  }
  const accountClaimsByAccount = new Map(accounts.map((a) => [a.account.id, a]));
  const allAccountIds = new Set([...targetsByAccount.keys(), ...accountClaimsByAccount.keys()]);

  await Promise.all(
    [...allAccountIds].map((accountId) =>
      processAccount({
        accountId,
        targets: targetsByAccount.get(accountId) ?? [],
        accountClaim: accountClaimsByAccount.get(accountId) ?? null,
        deadline,
        config: opts.config,
        cfg,
        counts,
      }),
    ),
  );

  now = await clock.now();
  await writeHeartbeat("insights_poll", now, { ...counts });
  return counts;
}

async function processAccount(ctx: {
  accountId: string;
  targets: ClaimedPostMetricPoll[];
  accountClaim: ClaimedAccountMetricPoll | null;
  deadline: number;
  config: SchedulerConfig;
  cfg: ReturnType<typeof insightsConfig>;
  counts: InsightsPollCounts;
}): Promise<void> {
  const { accountId, targets, accountClaim, deadline, config, cfg, counts } = ctx;
  const projectId = accountClaim?.account.projectId ?? targets[0]?.state.projectId;
  if (!projectId) return;
  const repos = forSchedulerProject(projectId);

  const account: AccountInfo | null = accountClaim ? accountClaim.account : await repos.accounts.get(accountId);
  if (!account) return;

  const provider = findProvider(account.providerKey);
  const pendingTargetTokens = new Map(targets.map((t) => [t.state.postTargetId, t.token]));
  let pendingAccountToken: string | null = accountClaim?.token ?? null;

  const releaseTarget = async (postTargetId: string) => {
    const token = pendingTargetTokens.get(postTargetId);
    if (!token) return;
    pendingTargetTokens.delete(postTargetId);
    await repos.postMetricPollStates.update(postTargetId, { pollLeaseUntil: null, pollLeaseOwner: null }, token);
  };
  const releaseAccount = async () => {
    if (!pendingAccountToken || !accountClaim) return;
    const token = pendingAccountToken;
    pendingAccountToken = null;
    await repos.accountMetricPollStates.update(accountId, { pollLeaseUntil: null, pollLeaseOwner: null }, token);
  };

  if (!provider?.insights) {
    counts.unavailable++;
    await Promise.all([...pendingTargetTokens.keys()].map(releaseTarget));
    await releaseAccount();
    return;
  }
  const insights = provider.insights;

  try {
    let credentials: unknown;
    let secrets: string[] = [];
    try {
      const ciphertext = await repos.accounts.getCredentialsCiphertext(accountId);
      credentials = decryptCredentials(accountId, ciphertext);
      secrets = secretValues(credentials);
    } catch {
      counts.failed++;
      await failEverything("Stored credentials are unreadable.");
      return;
    }

    let settings: unknown;
    try {
      settings = provider.settingsSchema.parse(account.settings ?? {});
    } catch {
      counts.failed++;
      await failEverything("Account settings are unreadable.");
      return;
    }

    const accountPublishLimit =
      account.publishLimitCount !== null && account.publishLimitWindowSeconds !== null
        ? { count: account.publishLimitCount, windowSeconds: account.publishLimitWindowSeconds }
        : null;
    const now0 = await clock.now();
    const verdict = await checkInsightsAllowance({
      projectId,
      socialAccountId: accountId,
      providerBudget: insights.declaration.readBudget,
      accountPublishLimit,
      now: now0,
      readReserve: cfg.readReserve,
      postSnapshots: repos.postMetricSnapshots,
      accountSnapshots: repos.accountMetricSnapshots,
    });
    if (!verdict.ok) {
      counts.deferredForAllowance++;
      await Promise.all([...pendingTargetTokens.keys()].map(releaseTarget));
      await releaseAccount();
      return;
    }

    const batchSize = Math.max(1, Math.min(cfg.readPageSize, insights.declaration.maxPostsPerRead));
    for (let i = 0; i < targets.length; i += batchSize) {
      const nowLoop = await clock.now();
      if (deadline - nowLoop.getTime() < config.providerTimeoutMs) {
        counts.outOfBudget++;
        await Promise.all(targets.slice(i).map((t) => releaseTarget(t.state.postTargetId)));
        break;
      }
      const batch = targets.slice(i, i + batchSize);
      const signal = AbortSignal.timeout(config.providerTimeoutMs);
      let result: PostMetricsReadResult;
      try {
        result = await insights.readPostMetrics({
          account: { id: accountId, externalId: account.externalAccountId, displayName: account.displayName, settings, credentials },
          posts: batch.map((t) => ({ externalId: t.externalId })),
          now: nowLoop,
          signal,
        });
      } catch (error) {
        result = { kind: "fatal_error", error: error instanceof Error ? error.message : "The provider threw while reading post metrics." };
      }
      await commitPostBatch({ batch, result, secrets, repos, insights, cfg, config, counts, releaseTarget, providerKey: account.providerKey });
    }

    if (accountClaim) {
      const nowAccount = await clock.now();
      if (deadline - nowAccount.getTime() < config.providerTimeoutMs) {
        counts.outOfBudget++;
        await releaseAccount();
      } else {
        const signal = AbortSignal.timeout(config.providerTimeoutMs);
        let result: AccountMetricsReadResult;
        try {
          result = await insights.readAccountMetrics({
            account: { id: accountId, externalId: account.externalAccountId, displayName: account.displayName, settings, credentials },
            now: nowAccount,
            signal,
          });
        } catch (error) {
          result = { kind: "fatal_error", error: error instanceof Error ? error.message : "The provider threw while reading account metrics." };
        }
        await commitAccountResult({ accountId, projectId, result, secrets, repos, insights, config, counts, releaseAccount, accountClaimToken: accountClaim.token, providerKey: account.providerKey, accountPollIntervalMs: cfg.accountPollIntervalMs });
      }
    }
  } finally {
    await Promise.all([...pendingTargetTokens.keys()].map(releaseTarget));
    await releaseAccount();
  }

  async function failEverything(message: string): Promise<void> {
    const now1 = await clock.now();
    await Promise.all(
      targets.map(async (t) => {
        const token = pendingTargetTokens.get(t.state.postTargetId);
        if (!token) return;
        pendingTargetTokens.delete(t.state.postTargetId);
        await repos.postMetricPollStates.update(
          t.state.postTargetId,
          {
            lastError: message,
            consecutiveFailures: t.state.consecutiveFailures + 1,
            failingSince: t.state.failingSince ?? now1,
            nextPollAt: nextRetryAt(now1, t.state.consecutiveFailures + 1, config),
            pollLeaseUntil: null,
            pollLeaseOwner: null,
          },
          token,
        );
      }),
    );
    if (accountClaim) {
      await repos.accountMetricPollStates.update(
        accountId,
        {
          lastError: message,
          consecutiveFailures: accountClaim.state.consecutiveFailures + 1,
          failingSince: accountClaim.state.failingSince ?? now1,
          nextPollAt: nextRetryAt(now1, accountClaim.state.consecutiveFailures + 1, config),
          pollLeaseUntil: null,
          pollLeaseOwner: null,
        },
        pendingAccountToken ?? accountClaim.token,
      );
      pendingAccountToken = null;
    }
  }
}

/** Only the declared keys present, as a plain record — a key the provider never declared is dropped before storage (FR-018). */
function filterToDeclared(raw: unknown, declared: readonly MetricKeyDeclaration[]): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const allowed = new Set(declared.map((d) => d.key));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (allowed.has(k)) out[k] = v;
  return out;
}

function byteSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function validateEntryMetrics(raw: unknown, declaration: readonly MetricKeyDeclaration[], schema: { safeParse(v: unknown): { success: boolean; data?: unknown } }): Record<string, number> | null {
  if (byteSize(raw) > 2000) return null;
  const filtered = filterToDeclared(raw, declaration);
  if (filtered === null) return null;
  const parsed = schema.safeParse(filtered);
  if (!parsed.success) return null;
  return parsed.data as Record<string, number>;
}

async function commitPostBatch(input: {
  batch: ClaimedPostMetricPoll[];
  result: PostMetricsReadResult;
  secrets: readonly string[];
  repos: ReturnType<typeof forSchedulerProject>;
  insights: InsightsSupport;
  cfg: ReturnType<typeof insightsConfig>;
  config: SchedulerConfig;
  counts: InsightsPollCounts;
  releaseTarget: (postTargetId: string) => Promise<void>;
  providerKey: string;
}): Promise<void> {
  const { batch, result, secrets, repos, insights, cfg, config, counts, releaseTarget, providerKey } = input;
  const now = await clock.now();

  if (result.kind !== "page") {
    const reason = redact("reason" in result ? result.reason : result.error, secrets);
    await Promise.all(
      batch.map(async (t) => {
        switch (result.kind) {
          case "retryable_error":
          case "fatal_error":
            counts.retried++;
            await repos.postMetricPollStates.update(
              t.state.postTargetId,
              {
                lastError: reason,
                consecutiveFailures: t.state.consecutiveFailures + 1,
                failingSince: t.state.failingSince ?? now,
                nextPollAt: ("retryAt" in result && result.retryAt) || nextRetryAt(now, t.state.consecutiveFailures + 1, config),
              },
              t.token,
            );
            break;
          case "rate_limited":
            counts.rateLimited++;
            await repos.postMetricPollStates.update(
              t.state.postTargetId,
              { lastError: reason, nextPollAt: result.retryAt ?? nextRetryAt(now, t.state.consecutiveFailures + 1, config) },
              t.token,
            );
            break;
          case "credentials_invalid": {
            counts.credentialsInvalid++;
            const ciphertext = await repos.accounts.getCredentialsCiphertext(t.state.socialAccountId);
            await markInvalidEmitting(repos, t.state.socialAccountId, { expectedCiphertext: ciphertext, reason }).catch(() => undefined);
            await repos.postMetricPollStates.update(
              t.state.postTargetId,
              { lastError: reason, consecutiveFailures: t.state.consecutiveFailures + 1, failingSince: t.state.failingSince ?? now },
              t.token,
            );
            break;
          }
          case "unavailable":
            counts.unavailable++;
            await repos.postMetricPollStates.update(
              t.state.postTargetId,
              { lastError: reason, nextPollAt: nextRetryAt(now, t.state.consecutiveFailures + 1, config) },
              t.token,
            );
            break;
        }
      }),
    );
    await Promise.all(batch.map((t) => releaseTarget(t.state.postTargetId)));
    return;
  }

  const entries = new Map(result.entries.map((e) => [e.externalId, e]));
  await repos.transaction(async (tx) => {
    for (const t of batch) {
      const entry: PostMetricEntry | undefined = entries.get(t.externalId);
      if (!entry) continue; // the provider did not answer for this id this call; leave it due.
      if (entry.kind === "gone") {
        counts.postsGone++;
        counts.targetsFrozen++;
        await tx.postMetricPollStates.update(
          t.state.postTargetId,
          { nextPollAt: null, frozenAt: now, frozenReason: "gone" },
          t.token,
        );
        continue;
      }
      if (entry.kind === "unqueryable") {
        counts.targetsUnqueryable++;
        counts.targetsFrozen++;
        await tx.postMetricPollStates.update(
          t.state.postTargetId,
          { nextPollAt: null, frozenAt: now, frozenReason: "unqueryable", lastError: null, consecutiveFailures: 0, failingSince: null },
          t.token,
        );
        continue;
      }
      const metrics = validateEntryMetrics(entry.metrics, insights.declaration.post, insights.postMetricsSchema);
      if (metrics === null) {
        counts.failed++;
        await tx.postMetricPollStates.update(
          t.state.postTargetId,
          {
            consecutiveFailures: t.state.consecutiveFailures + 1,
            failingSince: t.state.failingSince ?? now,
            lastError: "The platform returned an unreadable payload.",
            nextPollAt: nextRetryAt(now, t.state.consecutiveFailures + 1, config),
          },
          t.token,
        );
        continue;
      }
      await tx.postMetricSnapshots.insertIfAbsent({
        postTargetId: t.state.postTargetId,
        socialAccountId: t.state.socialAccountId,
        providerKey,
        capturedAt: now,
        metrics,
      });
      counts.postSnapshotsWritten++;
      const decision = postPollDecision({
        publishedAt: t.publishedAt,
        lastCapturedAt: now,
        now,
        minIntervalMs: cfg.pollMinIntervalMs,
        chosenPostType: t.chosenPostType,
        ephemeralPostTypes: insights.declaration.ephemeralPostTypes,
      });
      if (decision.kind === "frozen") {
        counts.targetsFrozen++;
        if (decision.reason === "expired") counts.targetsFrozenExpired++;
        else counts.targetsFrozenSettled++;
      }
      await tx.postMetricPollStates.update(
        t.state.postTargetId,
        {
          consecutiveFailures: 0,
          failingSince: null,
          lastError: null,
          lastPolledAt: now,
          lastCapturedAt: now,
          nextPollAt: decision.kind === "due" ? decision.at : null,
          frozenAt: decision.kind === "frozen" ? now : null,
          frozenReason: decision.kind === "frozen" ? decision.reason : null,
        },
        t.token,
      );
    }
  });
  await Promise.all(batch.map((t) => releaseTarget(t.state.postTargetId)));
}

async function commitAccountResult(input: {
  accountId: string;
  projectId: string;
  result: AccountMetricsReadResult;
  secrets: readonly string[];
  repos: ReturnType<typeof forSchedulerProject>;
  insights: InsightsSupport;
  config: SchedulerConfig;
  counts: InsightsPollCounts;
  releaseAccount: () => Promise<void>;
  accountClaimToken: string;
  providerKey: string;
  accountPollIntervalMs: number;
}): Promise<void> {
  const { accountId, result, secrets, repos, insights, config, counts, releaseAccount, accountClaimToken, providerKey, accountPollIntervalMs } = input;
  const now = await clock.now();

  if (result.kind !== "page") {
    const reason = redact("reason" in result ? result.reason : result.error, secrets);
    const state = await repos.accountMetricPollStates.get(accountId);
    const failures = state?.consecutiveFailures ?? 0;
    switch (result.kind) {
      case "retryable_error":
      case "fatal_error":
        counts.retried++;
        await repos.accountMetricPollStates.update(
          accountId,
          { lastError: reason, consecutiveFailures: failures + 1, failingSince: state?.failingSince ?? now, nextPollAt: ("retryAt" in result && result.retryAt) || nextRetryAt(now, failures + 1, config) },
          accountClaimToken,
        );
        break;
      case "rate_limited":
        counts.rateLimited++;
        await repos.accountMetricPollStates.update(accountId, { lastError: reason, nextPollAt: result.retryAt ?? nextRetryAt(now, failures + 1, config) }, accountClaimToken);
        break;
      case "credentials_invalid": {
        counts.credentialsInvalid++;
        const ciphertext = await repos.accounts.getCredentialsCiphertext(accountId);
        await markInvalidEmitting(repos, accountId, { expectedCiphertext: ciphertext, reason }).catch(() => undefined);
        await repos.accountMetricPollStates.update(accountId, { lastError: reason, consecutiveFailures: failures + 1, failingSince: state?.failingSince ?? now }, accountClaimToken);
        break;
      }
      case "unavailable":
        counts.unavailable++;
        await repos.accountMetricPollStates.update(
          accountId,
          { lastError: reason, nextPollAt: nextRetryAt(now, failures + 1, config) },
          accountClaimToken,
        );
        break;
    }
    await releaseAccount();
    return;
  }

  const metrics = validateEntryMetrics(result.metrics, insights.declaration.account, insights.accountMetricsSchema);
  if (metrics === null) {
    counts.failed++;
    const state = await repos.accountMetricPollStates.get(accountId);
    await repos.accountMetricPollStates.update(
      accountId,
      {
        consecutiveFailures: (state?.consecutiveFailures ?? 0) + 1,
        failingSince: state?.failingSince ?? now,
        lastError: "The platform returned an unreadable payload.",
        nextPollAt: nextRetryAt(now, (state?.consecutiveFailures ?? 0) + 1, config),
      },
      accountClaimToken,
    );
    await releaseAccount();
    return;
  }

  const nextPollAt = nextAccountPollAt({ lastCapturedAt: now, now, intervalMs: accountPollIntervalMs, minIntervalMs: accountPollIntervalMs });
  await repos.transaction(async (tx) => {
    await tx.accountMetricSnapshots.insertIfAbsent({ socialAccountId: accountId, providerKey, capturedAt: now, metrics });
    await tx.accountMetricPollStates.update(
      accountId,
      { consecutiveFailures: 0, failingSince: null, lastError: null, lastPolledAt: now, lastCapturedAt: now, nextPollAt },
      accountClaimToken,
    );
  });
  counts.accountSnapshotsWritten++;
  await releaseAccount();
}
