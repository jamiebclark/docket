// scheduler/engagement-read: the engagement-read section of a tick (data-model.md §7).
import { findProvider, listProviders } from "../../providers/registry";
import type { EngagementReadResult } from "../../providers/types";
import { directionFor, nextBackfillState, shouldReadAnotherPage } from "../../lib/engagement/paging";
import * as clock from "../dal/clock";
import {
  claimDueEngagementReads,
  countAccountsMissingEngagementScopes,
  countAccountsOnUnavailableEngagement,
  type ClaimedEngagementAccount,
  type EngagementProviderRule,
} from "../dal/engagement-read-claims";
import { forSchedulerProject } from "../dal/scheduler";
import { writeHeartbeat } from "../dal/heartbeats";
import { decryptCredentials } from "../services/accounts";
import { nextRetryAt } from "./backoff";
import { engagementConfig, type SchedulerConfig } from "./config";
import { markInvalidEmitting, refreshForPublish } from "./credentials";
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
  accountsSkippedNoPermission: number;
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
  accountsSkippedNoPermission: 0,
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
  const providers: EngagementProviderRule[] = listProviders()
    .filter((p) => p.engagement && !p.engagement.declaration.unavailable)
    .map((p) => ({ providerKey: p.key, readScopes: p.engagement!.declaration.readScopes ?? [] }));
  const unavailableProviderKeys = listProviders()
    .filter((p) => p.engagement?.declaration.unavailable)
    .map((p) => p.key);
  counts.unavailable += await countAccountsOnUnavailableEngagement(unavailableProviderKeys);

  if (providers.length > 0) {
    const now = await clock.now();
    const claimed = await claimDueEngagementReads({
      now,
      limit: ACCOUNTS_PER_RUN,
      leaseMs: opts.config.leaseMs,
      minIntervalMs: cfg.readMinIntervalMs,
      providers,
    });
    counts.claimed = claimed.length;
    counts.accountsSkippedNoPermission = await countAccountsMissingEngagementScopes(providers);
    await Promise.all(claimed.map((claim) => processAccount(claim, { config: opts.config, cfg, deadline, counts })));
  }

  await writeHeartbeat("engagement_read", await clock.now(), { ...counts });
  return counts;
}

async function processAccount(
  claim: ClaimedEngagementAccount,
  ctx: { config: SchedulerConfig; cfg: ReturnType<typeof engagementConfig>; deadline: number; counts: EngagementReadCounts },
): Promise<void> {
  const { account, state, token } = claim;
  const { counts } = ctx;
  const repos = forSchedulerProject(account.projectId);

  const release = (patch: Parameters<typeof repos.engagementAccountStates.update>[1]) =>
    repos.engagementAccountStates.update(account.id, { ...patch, readLeaseUntil: null, readLeaseOwner: null }, token);

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
  let providerState = (parsedProviderState.success ? parsedProviderState.data : {}) as Record<string, unknown>;
  // The persisted cursor only ever paginates older history (the backfill direction): the newest
  // direction has no "since" parameter on any provider, so it always restarts from `cursor: null`
  // and stops as soon as it sees an item already stored — that overlap *is* the new-items boundary.
  let backfilling = state.backfilling;
  let backfillCursor = state.cursor;
  let freshCursor: string | null = null;
  let pagesRead = 0;
  let stop: EngagementReadResult | null = null;
  let inserted = 0;
  let newestSaidAt: Date | null = state.lastItemAt;
  const now0 = await clock.now();
  const retentionHorizon = new Date(now0.getTime() - ctx.cfg.retentionDays * 86_400_000);

  while (true) {
    const nowLoop = await clock.now();
    if (!shouldReadAnotherPage({ pagesReadSoFar: pagesRead, policy: { pagesPerRun: ctx.cfg.readPagesPerRun, pageSize: ctx.cfg.readPageSize }, remainingBudgetMs: ctx.deadline - nowLoop.getTime(), providerTimeoutMs: ctx.config.providerTimeoutMs })) {
      break;
    }
    const direction = directionFor(backfilling);
    const cursor = direction === "older" ? backfillCursor : freshCursor;
    const signal = AbortSignal.timeout(ctx.config.providerTimeoutMs);
    const result = await engagement.read({
      account: { id: account.id, externalId: account.externalAccountId, displayName: account.displayName, settings, credentials },
      cursor,
      providerState,
      direction,
      limit: ctx.cfg.readPageSize,
      now: nowLoop,
      signal,
    });
    if (result.kind !== "page") {
      stop = result;
      break;
    }
    providerState = (result.providerState ?? providerState) as Record<string, unknown>;
    pagesRead++;
    let anyAlreadyStored = false;
    for (const item of result.items) {
      // Anything a retention pass would have already removed is never stored, so a cursor
      // restart cannot resurrect and re-notify what retention pruned (data-model.md §10).
      if (item.saidAt < retentionHorizon) continue;
      // The parent of a reply/mention may be the brand's own post (data-model.md §2); resolved
      // once at ingest, since `post_targets.external_id` can change owner-side after the fact.
      const parentTarget = item.parentExternalId ? await repos.targets.getByExternalId(account.id, item.parentExternalId) : null;
      const insertResult = await repos.engagementItems.insertIfAbsent({
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
        ingestedAt: nowLoop,
        parentExternalId: item.parentExternalId,
        parentPostId: parentTarget?.postId ?? null,
        parentPostTargetId: parentTarget?.id ?? null,
        providerData: item.data ?? {},
      });
      if (insertResult.inserted) {
        inserted++;
        if (!newestSaidAt || item.saidAt > newestSaidAt) newestSaidAt = item.saidAt;
      } else {
        anyAlreadyStored = true;
      }
      // The provider's upstream signal (FR-011, FR-061) applies to the already-stored row — the
      // item itself is immutable past ingest, so this is the one allowed post-ingest mutation.
      if (item.upstream === "withdrawn") await repos.engagementItems.markWithdrawn(insertResult.id, nowLoop);
      else if (item.upstream === "edited") await repos.engagementItems.markEditedUpstream(insertResult.id, nowLoop);
    }
    if (direction === "older") backfillCursor = result.cursor;
    else freshCursor = result.cursor;
    backfilling = nextBackfillState({
      wasBackfilling: backfilling,
      pageItemCount: result.items.length,
      pageSize: ctx.cfg.readPageSize,
      anyAlreadyStored,
      exhausted: result.exhausted,
    });
    if (result.exhausted) break;
    // The newest direction only ever reads forward until it meets what it already has; once it
    // does, there is nothing further back worth reading again this run.
    if (direction === "newest" && anyAlreadyStored) break;
  }

  if (stop) {
    // Never advance the cursor or backfill flag on a failed/stopped read (FR-014), but anything
    // already inserted this run must still be committed and notified — it is idempotent to insert
    // again, so a silent loss here is permanent (review F25).
    if (inserted > 0) {
      const stopNow = await clock.now();
      await repos.transaction(async (tx) => {
        await tx.engagementAccountStates.update(account.id, { lastItemAt: newestSaidAt }, token);
        await tx.activity.insert({
          kind: "engagement_received",
          occurredAt: stopNow,
          socialAccountId: account.id,
          providerKey: account.providerKey,
          message: `${inserted} new ${inserted === 1 ? "item" : "items"}`,
          details: { items: inserted },
        });
      });
      counts.itemsInserted += inserted;
      counts.accountsWithNewItems++;
    }
    await handleStop(stop, { account, state, token, repos, ctx, secrets, provider });
    return;
  }

  const now = await clock.now();
  await repos.transaction(async (tx) => {
    await tx.engagementAccountStates.update(
      account.id,
      {
        cursor: backfillCursor,
        providerState,
        backfilling,
        readLeaseUntil: null,
        readLeaseOwner: null,
        lastReadAt: now,
        lastItemAt: newestSaidAt,
        consecutiveFailures: 0,
        lastError: null,
      },
      token,
    );
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
    token: string;
    repos: ReturnType<typeof forSchedulerProject>;
    ctx: { config: SchedulerConfig; counts: EngagementReadCounts };
    secrets: readonly string[];
    /** Needed to renew credentials before declaring them invalid; absent means no renewal is possible. */
    provider: ReturnType<typeof findProvider>;
  },
): Promise<void> {
  const { account, state, token, repos, ctx, secrets, provider } = input;
  const now = await clock.now();
  const release = (patch: Parameters<typeof repos.engagementAccountStates.update>[1]) =>
    repos.engagementAccountStates.update(account.id, { ...patch, readLeaseUntil: null, readLeaseOwner: null }, token);

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
      // A read rejecting the session is not proof the account needs a human. Publishing recovers
      // from the same rejection by renewing — and, where a provider keeps the means to re-open a
      // session (Bluesky's stored app password, 078/#124), without anyone noticing. Marking the
      // account invalid straight from here skipped all of that: the reader polls far more often
      // than posts publish, so it reached the rejection first and flagged an account that could
      // have healed. Stencilvania lost its Bluesky arm four times in a day that way on
      // 2026-10-17, each reconnect undone within the hour. Try the renewal the publish path
      // would, and only give up on the account when that refuses too.
      const ciphertext = await repos.accounts.getCredentialsCiphertext(account.id);
      const renewed = provider
        ? await refreshForPublish({
            projectId: account.projectId,
            account,
            provider,
            seenCiphertext: ciphertext,
            config: ctx.config,
          }).catch(() => ({ kind: "unavailable" }) as const)
        : ({ kind: "unavailable" } as const);

      if (renewed.kind === "refreshed" || renewed.kind === "changed") {
        // Healed. Leave the account active and come back on the normal backoff with the new session.
        ctx.counts.retried++;
        await release({
          lastError: redact(result.error, secrets),
          consecutiveFailures: state.consecutiveFailures + 1,
          readNotBefore: nextRetryAt(now, state.consecutiveFailures + 1, ctx.config),
        });
        return;
      }

      ctx.counts.credentialsInvalid++;
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
