// scheduler/engagement-read: the engagement-read section of a tick (data-model.md §7).
import { findProvider, listProviders } from "../../providers/registry";
import type { EngagementReadResult } from "../../providers/types";
import { directionFor, nextBackfillState, shouldReadAnotherPage } from "../../lib/engagement/paging";
import * as clock from "../dal/clock";
import { claimDueEngagementReads, type ClaimedEngagementAccount } from "../dal/engagement-read-claims";
import { forSchedulerProject } from "../dal/scheduler";
import { writeHeartbeat } from "../dal/heartbeats";
import { decryptCredentials } from "../services/accounts";
import { nextRetryAt } from "./backoff";
import { engagementConfig, type SchedulerConfig } from "./config";
import { markInvalidEmitting } from "./credentials";
import { redact, secretValues } from "./redact";

export interface EngagementReadCounts {
  claimed: number;
  itemsInserted: number;
  accountsWithNewItems: number;
  retried: number;
  rateLimited: number;
  credentialsInvalid: number;
  cursorLost: number;
  unavailable: number;
  failed: number;
}

export const emptyEngagementReadCounts = (): EngagementReadCounts => ({
  claimed: 0,
  itemsInserted: 0,
  accountsWithNewItems: 0,
  retried: 0,
  rateLimited: 0,
  credentialsInvalid: 0,
  cursorLost: 0,
  unavailable: 0,
  failed: 0,
});

const ACCOUNTS_PER_RUN = 20;

/**
 * Claims accounts due for a read, calls the provider's `read()` outside any transaction, and
 * commits the inserted items, cursor and backfill flag together in one transaction per account —
 * so a kill mid-read resumes from the last committed cursor and never advances it on failure
 * (FR-014, data-model.md §7).
 */
export async function runEngagementRead(opts: { config: SchedulerConfig; tickId: string; startedAt: Date }): Promise<EngagementReadCounts> {
  const cfg = engagementConfig(opts.config);
  const counts = emptyEngagementReadCounts();
  const deadline = opts.startedAt.getTime() + cfg.timeBudgetMs;
  // FR-055: a declared-but-unavailable surface is never claimed, so no call is ever attempted for it.
  const providerKeys = listProviders()
    .filter((p) => p.engagement && !p.engagement.declaration.unavailable)
    .map((p) => p.key);

  if (providerKeys.length > 0) {
    const now = await clock.now();
    const claimed = await claimDueEngagementReads({
      now,
      limit: ACCOUNTS_PER_RUN,
      leaseMs: opts.config.leaseMs,
      minIntervalMs: cfg.readMinIntervalMs,
      providerKeys,
    });
    counts.claimed = claimed.length;
    await Promise.all(claimed.map((claim) => processAccount(claim, { config: opts.config, cfg, deadline, counts })));
  }

  await writeHeartbeat("engagement_read", await clock.now(), { ...counts });
  return counts;
}

async function processAccount(
  claim: ClaimedEngagementAccount,
  ctx: { config: SchedulerConfig; cfg: ReturnType<typeof engagementConfig>; deadline: number; counts: EngagementReadCounts },
): Promise<void> {
  const { account, state } = claim;
  const { counts } = ctx;
  const repos = forSchedulerProject(account.projectId);

  const release = (patch: Parameters<typeof repos.engagementAccountStates.update>[1]) =>
    repos.engagementAccountStates.update(account.id, { ...patch, readLeaseUntil: null, readLeaseOwner: null });

  const provider = findProvider(account.providerKey);
  if (!provider?.engagement) {
    counts.unavailable++;
    await release({});
    return;
  }
  const engagement = provider.engagement;

  let ciphertext: string | null;
  let credentials: unknown;
  let secrets: string[] = [];
  try {
    ciphertext = await repos.accounts.getCredentialsCiphertext(account.id);
    credentials = decryptCredentials(account.id, ciphertext);
    secrets = secretValues(credentials);
  } catch {
    counts.failed++;
    await release({
      lastError: "Stored credentials are unreadable.",
      consecutiveFailures: state.consecutiveFailures + 1,
      readNotBefore: nextRetryAt(await clock.now(), state.consecutiveFailures + 1, ctx.config),
    });
    return;
  }
  let settings: unknown;
  try {
    settings = provider.settingsSchema.parse(account.settings ?? {});
  } catch {
    counts.failed++;
    await release({
      lastError: "Account settings are unreadable.",
      consecutiveFailures: state.consecutiveFailures + 1,
      readNotBefore: nextRetryAt(await clock.now(), state.consecutiveFailures + 1, ctx.config),
    });
    return;
  }

  const parsedProviderState = engagement.stateSchema.safeParse(state.providerState ?? {});
  const providerState = (parsedProviderState.success ? parsedProviderState.data : {}) as Record<string, unknown>;
  let backfilling = state.backfilling;
  let newestCursor = state.cursor;
  let backfillCursor = typeof providerState.backfillCursor === "string" ? providerState.backfillCursor : null;

  const pages: { items: readonly import("../../providers/types").InboundItemDraft[] }[] = [];
  let pagesRead = 0;
  let stop: EngagementReadResult | null = null;

  while (true) {
    const now = await clock.now();
    if (!shouldReadAnotherPage({ pagesReadSoFar: pagesRead, policy: { pagesPerRun: ctx.cfg.readPagesPerRun, pageSize: ctx.cfg.readPageSize }, remainingBudgetMs: ctx.deadline - now.getTime(), providerTimeoutMs: ctx.config.providerTimeoutMs })) {
      break;
    }
    const direction = directionFor(backfilling);
    const cursor = direction === "older" ? backfillCursor : newestCursor;
    const signal = AbortSignal.timeout(ctx.config.providerTimeoutMs);
    const result = await engagement.read({
      account: { id: account.id, externalId: account.externalAccountId, displayName: account.displayName, settings, credentials },
      cursor,
      providerState,
      direction,
      limit: ctx.cfg.readPageSize,
      now,
      signal,
    });
    if (result.kind !== "page") {
      stop = result;
      break;
    }
    pagesRead++;
    pages.push({ items: result.items });
    if (direction === "older") backfillCursor = result.cursor;
    else newestCursor = result.cursor;
    const anyAlreadyStored = false; // determined when inserting, below; conservative default keeps backfilling going
    backfilling = nextBackfillState({
      wasBackfilling: backfilling,
      pageItemCount: result.items.length,
      pageSize: ctx.cfg.readPageSize,
      anyAlreadyStored,
      exhausted: result.exhausted,
    });
    if (result.exhausted) break;
  }

  if (stop) {
    await handleStop(stop, { account, state, repos, ctx, secrets });
    return;
  }

  const now = await clock.now();
  const retentionHorizon = new Date(now.getTime() - ctx.cfg.retentionDays * 86_400_000);
  let inserted = 0;
  let newestSaidAt: Date | null = state.lastItemAt;
  await repos.transaction(async (tx) => {
    for (const page of pages) {
      for (const item of page.items) {
        // Anything a retention pass would have already removed is never stored, so a cursor
        // restart cannot resurrect and re-notify what retention pruned (data-model.md §10).
        if (item.saidAt < retentionHorizon) continue;
        const result = await tx.engagementItems.insertIfAbsent({
          socialAccountId: account.id,
          providerKey: account.providerKey,
          kind: item.kind,
          externalId: item.externalId,
          text: item.text,
          textTruncated: item.textTruncated ?? false,
          authorDisplayName: item.author.displayName,
          authorHandle: item.author.handle,
          authorExternalId: item.author.externalId,
          authorUrl: item.author.url,
          authorIdentityStable: item.author.identityStable,
          authorReachable: item.author.reachable ?? true,
          saidAt: item.saidAt,
          ingestedAt: now,
          parentExternalId: item.parentExternalId,
          providerData: item.data ?? {},
        });
        if (result.inserted) {
          inserted++;
          if (!newestSaidAt || item.saidAt > newestSaidAt) newestSaidAt = item.saidAt;
        }
      }
    }
    await tx.engagementAccountStates.update(account.id, {
      cursor: newestCursor,
      providerState: { ...providerState, ...(backfillCursor ? { backfillCursor } : {}) },
      backfilling,
      readLeaseUntil: null,
      readLeaseOwner: null,
      lastReadAt: now,
      lastItemAt: newestSaidAt,
      consecutiveFailures: 0,
      lastError: null,
    });
    if (inserted > 0) {
      await tx.activity.insert({
        kind: "engagement_received",
        occurredAt: now,
        socialAccountId: account.id,
        providerKey: account.providerKey,
        message: `${inserted} new ${inserted === 1 ? "item" : "items"}`,
        details: { items: inserted },
      });
    }
  });
  counts.itemsInserted += inserted;
  if (inserted > 0) counts.accountsWithNewItems++;
}

async function handleStop(
  result: Exclude<EngagementReadResult, { kind: "page" }>,
  input: {
    account: ClaimedEngagementAccount["account"];
    state: ClaimedEngagementAccount["state"];
    repos: ReturnType<typeof forSchedulerProject>;
    ctx: { config: SchedulerConfig; counts: EngagementReadCounts };
    secrets: readonly string[];
  },
): Promise<void> {
  const { account, state, repos, ctx, secrets } = input;
  const now = await clock.now();
  const release = (patch: Parameters<typeof repos.engagementAccountStates.update>[1]) =>
    repos.engagementAccountStates.update(account.id, { ...patch, readLeaseUntil: null, readLeaseOwner: null });

  switch (result.kind) {
    case "retryable_error":
    case "fatal_error": {
      ctx.counts.failed++;
      await release({
        lastError: redact(result.error, secrets),
        consecutiveFailures: state.consecutiveFailures + 1,
        readNotBefore: ("retryAt" in result && result.retryAt) || nextRetryAt(now, state.consecutiveFailures + 1, ctx.config),
      });
      return;
    }
    case "rate_limited": {
      ctx.counts.rateLimited++;
      await release({
        lastError: redact(result.error, secrets),
        readNotBefore: result.retryAt ?? nextRetryAt(now, state.consecutiveFailures + 1, ctx.config),
      });
      return;
    }
    case "credentials_invalid": {
      ctx.counts.credentialsInvalid++;
      const ciphertext = await repos.accounts.getCredentialsCiphertext(account.id);
      await markInvalidEmitting(repos, account.id, { expectedCiphertext: ciphertext, reason: redact(result.error, secrets) }).catch(() => undefined);
      await release({ lastError: redact(result.error, secrets), consecutiveFailures: state.consecutiveFailures + 1 });
      return;
    }
    case "cursor_lost": {
      ctx.counts.cursorLost++;
      await release({
        cursor: null,
        providerState: {},
        backfilling: false,
        gapAt: now,
        lastError: redact(result.error, secrets),
      });
      return;
    }
    case "unavailable": {
      ctx.counts.unavailable++;
      await release({});
      return;
    }
  }
}
