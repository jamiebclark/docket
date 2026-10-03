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
import type { SchedulerConfig } from "./config";
import { deferralTime, effectiveLimits } from "./limits";
import { recoverExpiredLease } from "./recovery";
import { redact, secretValues } from "./redact";
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
          const deferUntil = await deferralTime(effectiveLimits(provider.defaultPublishLimit, account), now, (since) =>
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
        const info = provider.stepFor(target.stepState, settings);
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

  if ((await clock.now()).getTime() + config.providerTimeoutMs > deadline) {
    const released = await repos.transaction(async (tx) => {
      const row = await tx.targets.update(
        target.id,
        { ...UNLEASED, ...lease.before, attemptCount: target.attemptCount },
        { leaseOwner: token },
      );
      if (row) await tx.attempts.insert({ postTargetId: target.id, step: lease.step, outcome: "released", tickId, at: await clock.now() });
      return row !== null;
    });
    if (released) {
      counts.released++;
      await repos.transaction((tx) => applyDerivedStatus(tx, target.postId));
    }
    return;
  }

  let secrets: string[] = [];
  let result: StepResult;
  const startedMs = Date.now();
  try {
    const content = await repos.targets.effectiveContent(target.id);
    if (!content) throw new Error("The post is no longer available.");
    const ciphertext = await repos.accounts.getCredentialsCiphertext(account.id);
    const credentials = decryptCredentials(account.id, ciphertext);
    secrets = secretValues(credentials);
    const settings = provider.settingsSchema.parse(account.settings ?? {});
    const signal = AbortSignal.timeout(config.providerTimeoutMs);
    result = await withTimeout(
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
        state: target.stepState,
        now: await clock.now(),
        signal,
      }),
      config.providerTimeoutMs,
    );
  } catch (error) {
    // A lost or failed call: whether the step could have published decides the outcome (D5).
    const message = redact(error instanceof Error ? error.message : "The provider call failed.", secrets);
    result = lease.mayPublish ? { kind: "ambiguous", error: message } : { kind: "retryable_error", error: message };
  }

  const now = await clock.now();
  const outcome = applyStepResult({
    result,
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
    step: lease.step,
    outcome,
    requestSummary: { ...(result.summary?.request ?? {}), ...(lateBySeconds !== undefined ? { lateBySeconds } : {}) },
    responseSummary: result.summary?.response ?? {},
    durationMs: Date.now() - startedMs,
    tickId,
    now,
    secrets,
  });
  if (!applied) {
    counts.staleResults++;
    return;
  }
  switch (result.kind) {
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
