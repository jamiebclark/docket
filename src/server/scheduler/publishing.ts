import { randomUUID } from "node:crypto";
import { findProvider } from "../../providers/registry";
import { inferPostType } from "../../providers/validation";
import type { SocialProvider, StepResult } from "../../providers/types";
import * as clock from "../dal/clock";
import { writeHeartbeat } from "../dal/heartbeats";
import {
  claimDueTargets,
  forSchedulerProject,
  type ClaimDecision,
  type ClaimedTarget,
} from "../dal/scheduler";
import type { TargetPatch, TargetRecord } from "../dal/targets";
import { decryptCredentials } from "../services/accounts";
import { applyDerivedStatus } from "../services/posts/status";
import { validateResolvedContent } from "../services/posts/validate";
import type { SchedulerConfig } from "./config";
import { resolvePublishMedia } from "../services/media-variants";
import { providerPublishLimits } from "../../providers/limits";
import { deferralTime, effectiveLimits } from "./limits";
import { recoverExpiredLease } from "./recovery";
import { redact, secretValues } from "./redact";
import { markInvalidEmitting, refreshForPublish } from "./credentials";
import { applyStepResult, recordStepResult } from "./record";

export interface PublishingCounts {
  claimed: number;
  done: number;
  continued: number;
  retried: number;
  failed: number;
  ambiguous: number;
  deferred: number;
  recovered: number;
  staleResults: number;
  released: number;
}

export const emptyPublishingCounts = (): PublishingCounts => ({
  claimed: 0,
  done: 0,
  continued: 0,
  retried: 0,
  failed: 0,
  ambiguous: 0,
  deferred: 0,
  recovered: 0,
  staleResults: 0,
  released: 0,
});

const UNLEASED = { leaseOwner: null, leaseUntil: null, inFlightStep: null, inFlightMayPublish: null } as const;

interface Leased {
  claimed: ClaimedTarget;
  provider: SocialProvider;
  step: string;
  mayPublish: boolean;
  token: string;
  firstStep: boolean;
  before: Pick<TargetRecord, "status" | "firstStepAt" | "publishStartedAt">;
}

/** Runs the publishing section: claim → lease → advance outside any transaction → record under the lease token. */
export async function runPublishing(opts: {
  config: SchedulerConfig;
  tickId: string;
  startedAt: Date;
}): Promise<PublishingCounts> {
  const { config, tickId } = opts;
  const counts = emptyPublishingCounts();
  const deadline = opts.startedAt.getTime() + config.timeBudgetMs;
  const handled = new Set<string>();

  while (handled.size < config.maxItems) {
    if ((await clock.now()).getTime() + config.providerTimeoutMs > deadline) break;
    const now = await clock.now();
    const leased = new Map<string, Leased>();

    const claimed = await claimDueTargets({
      now,
      limit: Math.min(config.batchSize, config.maxItems - handled.size),
      excludeIds: [...handled],
      async decide(target, account, ctx) {
        const finish = (patch: TargetPatch, outcome: ClaimDecision["attempts"]): ClaimDecision => ({
          patch: { ...UNLEASED, ...patch },
          ...(outcome ? { attempts: outcome } : {}),
        });
        const provider = findProvider(account.providerKey);
        const attempts: NonNullable<ClaimDecision["attempts"]> = [];
        let patch: TargetPatch = {};

        const recovery = recoverExpiredLease(target, config, tickId);
        if (recovery.kind !== "none") {
          // The lease expired while a step was in flight (FR-035).
          counts.recovered++;
          if (recovery.kind === "settled") {
            counts[recovery.outcome]++;
            return finish(recovery.patch, recovery.attempts);
          }
          attempts.push(...recovery.attempts);
          patch = recovery.patch;
        }

        if (account.removedAt !== null || account.status !== "active" || !provider) {
          counts.failed++;
          return finish(
            { status: "failed", nextAttemptAt: null, lastError: "The account is no longer available for publishing." },
            [...attempts, { step: "engine", outcome: "account_unavailable", tickId, error: "Account removed, needs reconnecting, or provider unavailable." }],
          );
        }
        if (target.firstStepAt && now.getTime() - target.firstStepAt.getTime() > config.maxPublishDurationMs) {
          counts.failed++;
          return finish(
            { status: "failed", nextAttemptAt: null, lastError: "Publishing did not complete." },
            [...attempts, { step: "engine", outcome: "did_not_complete", tickId, error: "Publishing did not complete." }],
          );
        }

        const firstStep = target.stepState === null;
        if (firstStep) {
          // Both the provider default and the account's own limit apply (D8).
          const deferUntil = await deferralTime(effectiveLimits(providerPublishLimits(provider), account), now, (since) =>
            ctx.startedSince(account.id, since, target.id), // a target's own earlier start never counts against it
          );
          if (deferUntil) {
            counts.deferred++;
            return finish({ ...patch, nextAttemptAt: deferUntil }, [
              ...attempts,
              { step: "engine", outcome: "deferred", tickId, error: "Waiting for the publishing limit to reset." },
            ]);
          }
        }

        let settings: unknown;
        try {
          settings = provider.settingsSchema.parse(account.settings ?? {});
        } catch {
          counts.failed++;
          return finish(
            { status: "failed", nextAttemptAt: null, lastError: "The account settings are invalid." },
            [...attempts, { step: "engine", outcome: "account_unavailable", tickId, error: "Invalid account settings." }],
          );
        }
        const shape = await ctx.contentShape(target);
        if (!shape) {
          // The post is gone: nothing to publish, and no provider call is made (G4).
          counts.failed++;
          return finish(
            { status: "failed", nextAttemptAt: null, lastError: "The post is no longer available." },
            [...attempts, { step: "engine", outcome: "fatal_error", tickId, error: "The post is no longer available." }],
          );
        }
        const info = provider.stepFor(target.stepState, settings, shape);
        const token = randomUUID();
        leased.set(target.id, {
          claimed: undefined as unknown as ClaimedTarget,
          provider,
          step: info.name,
          mayPublish: info.mayPublish,
          token,
          firstStep: target.firstStepAt === null,
          before: { status: target.status, firstStepAt: target.firstStepAt, publishStartedAt: target.publishStartedAt },
        });
        return {
          patch: {
            ...patch,
            status: "publishing",
            leaseOwner: token,
            leaseUntil: new Date(now.getTime() + config.leaseMs),
            inFlightStep: info.name,
            inFlightMayPublish: info.mayPublish,
            firstStepAt: target.firstStepAt ?? now,
            // A start is the most recent lease of a first step, so the attempt that may publish is what counts.
            publishStartedAt: firstStep ? now : target.publishStartedAt,
          },
          ...(attempts.length > 0 ? { attempts } : {}),
        };
      },
    });
    if (claimed.length === 0) break;

    const toRun: Leased[] = [];
    for (const c of claimed) {
      handled.add(c.target.id);
      counts.claimed++;
      const lease = leased.get(c.target.id);
      if (lease) {
        lease.claimed = c;
        toRun.push(lease);
      }
    }
    // Status for targets that changed without a provider call (recovery, deferral, failure).
    await Promise.all(
      claimed.map((c) =>
        forSchedulerProject(c.target.projectId).transaction((tx) => applyDerivedStatus(tx, c.target.postId)),
      ),
    );
    await Promise.all(toRun.map((l) => execute(l, config, tickId, deadline, counts)));
  }

  await writeHeartbeat("publishing", await clock.now(), { ...counts });
  return counts;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("The provider call timed out.")), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** Media could not be resolved before the provider call; the target fails with no call made. */
class MediaUnavailable extends Error {}

/** The post row vanished after the claim; no provider call is made, and it can never have published (G4). */
class PostGone extends Error {}

/** The resolved content no longer passes the provider's validation; fatal before credentials are read (G15). */
class ContentInvalid extends Error {}

/** Stored credentials failed to decrypt; fatal before any provider call (FR-012). */
class CredentialsUnreadable extends Error {}

/** The account's stored settings no longer parse; fatal before any provider call (FR-012). */
class SettingsInvalid extends Error {}

/**
 * Media preparation failed or overran the tick budget. It runs before any provider call,
 * so the step cannot have published: always retryable, never ambiguous (F3).
 */
class MediaNotReady extends Error {}

function withinBudget<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new MediaNotReady("Preparing media took too long; will retry.")), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

async function execute(
  lease: Leased,
  config: SchedulerConfig,
  tickId: string,
  deadline: number,
  counts: PublishingCounts,
): Promise<void> {
  const { claimed, provider, token } = lease;
  const target = claimed.target;
  const account = claimed.account;
  const repos = forSchedulerProject(target.projectId);

  const fitsDeadline = async () => (await clock.now()).getTime() + config.providerTimeoutMs <= deadline;

  /** Gives the target back, uncounted: the attempt budget is untouched and one `released` attempt is recorded. */
  const release = async (error?: string): Promise<void> => {
    const released = await repos.transaction(async (tx) => {
      const row = await tx.targets.update(
        target.id,
        { ...UNLEASED, ...lease.before, attemptCount: target.attemptCount },
        { leaseOwner: token },
      );
      if (row) {
        await tx.attempts.insert({
          postTargetId: target.id,
          step: lease.step,
          outcome: "released",
          tickId,
          at: await clock.now(),
          ...(error ? { error } : {}),
        });
      }
      return row !== null;
    });
    if (released) {
      counts.released++;
      await repos.transaction((tx) => applyDerivedStatus(tx, target.postId));
    }
  };

  if (!(await fitsDeadline())) return release();

  let secrets: string[] = [];
  let result: StepResult | undefined;
  let seenCiphertext: string | null = null;
  // Set immediately before `provider.advance`: only a failure after it can leave a post possibly published (FR-012).
  let providerCalled = false;
  let validationFailed = false;
  const startedMs = Date.now();
  try {
    const loaded = await repos.targets.effectiveContent(target.id);
    if (!loaded) throw new PostGone("The post is no longer available.");
    // Adapted media (FR-016): regenerates a vanished variant; a deleted original fails the target before any provider call.
    // Text-only posts (the common case) skip it.
    let media = loaded.media;
    if (loaded.media.length > 0) {
      // Storage calls can hang; leave room for the provider call inside the tick deadline.
      const budget = Math.max(1_000, deadline - (await clock.now()).getTime() - config.providerTimeoutMs);
      const resolved = await withinBudget(resolvePublishMedia(repos, target.id, provider), budget).catch((e: unknown) => {
        throw e instanceof MediaNotReady ? e : new MediaNotReady("Preparing media failed; will retry.");
      });
      if (!resolved.ok) throw new MediaUnavailable(resolved.error);
      media = resolved.media;
    }
    const content = { text: loaded.text, media };
    // G15: a capability lowered after scheduling must not reach the platform. Runs on the first step only,
    // before credentials are read.
    if (target.stepState === null) {
      const refusal = validateResolvedContent(provider, content).find((i) => i.severity === "error");
      if (refusal) {
        validationFailed = true;
        throw new ContentInvalid(`Can't publish to ${provider.displayName}: ${refusal.message}`);
      }
    }
    seenCiphertext = await repos.accounts.getCredentialsCiphertext(account.id);
    let credentials: ReturnType<typeof decryptCredentials>;
    try {
      credentials = decryptCredentials(account.id, seenCiphertext);
    } catch {
      throw new CredentialsUnreadable(`The account's stored credentials can't be read. Reconnect ${account.displayName}.`);
    }
    secrets = secretValues(credentials);

    // Proactive refresh (G2): runs outside `advance`, so it is never covered by `inFlightMayPublish` (FR-023).
    if (provider.refreshCredentials && provider.needsRefresh?.(credentials, await clock.now())) {
      if (!(await fitsDeadline())) return release();
      const r = await refreshForPublish({ projectId: target.projectId, account, provider, seenCiphertext, config });
      if (r.kind === "refreshed" || r.kind === "changed") {
        credentials = r.credentials;
        seenCiphertext = r.ciphertext;
        secrets = [...secrets, ...secretValues(credentials)];
        if (!(await fitsDeadline())) return release(); // persisted: the next tick publishes with it
      } else if (r.kind === "busy") {
        return release("Waiting for account credentials to be renewed.");
      } else if (r.kind === "unavailable" || r.kind === "refused") {
        return release("The account needs reconnecting.");
      } else {
        result = {
          kind: "retryable_error",
          error: "Could not renew the account's session; will retry.",
          ...(r.retryAt ? { notBefore: r.retryAt } : {}),
        };
      }
    }
    let settings: ReturnType<typeof provider.settingsSchema.parse>;
    try {
      settings = provider.settingsSchema.parse(account.settings ?? {});
    } catch {
      throw new SettingsInvalid("The account settings are invalid.");
    }
    const signal = AbortSignal.timeout(config.providerTimeoutMs);
    if (!result) providerCalled = true;
    result ??= await withTimeout(
      provider.advance({
        target: { id: target.id, scheduledAt: target.scheduledAt ?? new Date(), attempt: target.attemptCount + 1 },
        account: {
          id: account.id,
          externalId: account.externalAccountId,
          displayName: account.displayName,
          settings,
          credentials,
        },
        content,
        postType: inferPostType(content),
        step: { name: lease.step, mayPublish: lease.mayPublish },
        state: target.stepState,
        now: await clock.now(),
        signal,
      }),
      config.providerTimeoutMs,
    );
  } catch (error) {
    if (error instanceof MediaUnavailable || error instanceof PostGone || error instanceof ContentInvalid || error instanceof CredentialsUnreadable || error instanceof SettingsInvalid) {
      result = { kind: "fatal_error", error: error.message };
    } else if (error instanceof MediaNotReady) {
      result = { kind: "retryable_error", error: error.message };
    } else if (!providerCalled) {
      result = { kind: "retryable_error", error: "Publishing could not start; will retry." };
    } else {
      // A lost or failed call: whether the step could have published decides the outcome (D5).
      const message = redact(error instanceof Error ? error.message : "The provider call failed.", secrets);
      result = lease.mayPublish ? { kind: "ambiguous", error: message } : { kind: "retryable_error", error: message };
    }
  }

  // G7: the platform said these credentials are dead. Fail the target with a reconnect message; no refresh, no retry.
  const credentialsInvalidReason =
    result!.kind === "fatal_error" && result!.credentialsInvalid ? redact(result!.error, secrets) : null;
  if (credentialsInvalidReason !== null && result!.kind === "fatal_error") {
    result = { ...result!, error: `Reconnect ${account.displayName} to publish: ${credentialsInvalidReason}` };
  }

  const now = await clock.now();
  const outcome = applyStepResult({
    result: result!,
    target: { attemptCount: target.attemptCount, stepState: target.stepState },
    now,
    config,
    secrets,
  });
  const lateBySeconds =
    lease.firstStep && target.scheduledAt ? Math.max(0, Math.round((now.getTime() - target.scheduledAt.getTime()) / 1000)) : undefined;
  const applied = await recordStepResult({
    projectId: target.projectId,
    postId: target.postId,
    targetId: target.id,
    token,
    step: validationFailed ? "engine-validate" : lease.step,
    outcome,
    requestSummary: { ...(result.summary?.request ?? {}), ...(lateBySeconds !== undefined ? { lateBySeconds } : {}) },
    responseSummary: result.summary?.response ?? {},
    durationMs: Date.now() - startedMs,
    tickId,
    now,
    secrets,
  });
  // Reactive refresh (G2): after the result is recorded, so a slow refresh never holds back the target's own record.
  // It only affects the account (a refusal flags `needs_reauth`); the next tick publishes with the new credentials.
  if (result!.kind === "retryable_error" && result!.credentialsExpired && provider.refreshCredentials && (await fitsDeadline())) {
    await refreshForPublish({ projectId: target.projectId, account, provider, seenCiphertext, config }).catch(() => undefined);
  }
  if (credentialsInvalidReason !== null) {
    await markInvalidEmitting(repos, account.id, { expectedCiphertext: seenCiphertext, reason: credentialsInvalidReason })
      .catch(() => console.error(`Docket: could not flag account ${account.providerKey} as needing reconnect`));
  }
  if (!applied) {
    counts.staleResults++;
    return;
  }
  switch (result!.kind) {
    case "done":
      counts.done++;
      break;
    case "continue":
      counts.continued++;
      break;
    case "retryable_error":
      if (outcome.patch.status === "failed") counts.failed++;
      else counts.retried++;
      break;
    case "fatal_error":
      counts.failed++;
      break;
    case "ambiguous":
      counts.ambiguous++;
      break;
  }
}
