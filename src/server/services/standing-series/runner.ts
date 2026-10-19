// standing-series/runner: process one claimed series (contracts/services.md §7.2-§7.5). Mirrors
// jobs/runner.ts's structure and vocabulary; shares `withinBudget`/`Overran`/`logLine` (S36).
import { AVOID_RUNS, avoidTitles } from "@/lib/series/avoid";
import { periodStartInstant } from "@/lib/series/cadence";
import { renderTemplate } from "@/lib/jobs/template";
import { Temporal } from "@js-temporal/polyfill";
import type { GenerationRecord } from "@/lib/validation/generation";
import type { DatedPosition, StandingSeriesRunConfig } from "@/lib/validation/standing-series";
import * as clock from "../../dal/clock";
import { ConflictError } from "../../dal/errors";
import type { ClaimedStandingSeries } from "../../dal/standing-series-claims";
import type { StandingSeriesPositionPatch, StandingSeriesPositionRecord, StandingSeriesRunRecord } from "../../dal/standing-series";
import { forJobRunner, type ProjectScope } from "../../dal/scope";
import { resolveLlmForProject } from "../../llm/resolve";
import { parseLlmLimits } from "../../llm/config";
import { llmFailureMessage } from "../../llm/messages";
import type { LlmFailureKind, LlmProvider } from "../../llm/types";
import { standingSeriesConfig, type SchedulerConfig } from "../../scheduler/config";
import { nextRetryAt } from "../../scheduler/backoff";
import { Overran, withinBudget, logLine } from "../../scheduler/budget";
import { runGenerationStep, type PendingRetry } from "../generation/core";
import { createUsageRecorder } from "../../llm/usage";
import { applyApprovalPolicy } from "../generation/policy";
import { saveGeneratedPost } from "../generation/save";
import { groupsForAccounts } from "../generation/groups";
import { isUniqueViolation, loadAccounts, takeVoice, type VoiceSnapshot } from "../generation/single";
import { planSeries } from "../generation/series";
import { recordFailure } from "../generation/failures";
import { prepareVariants } from "../media-variants";
import { openOrResumeRun, closeRun } from "./run";
import { resolvePositionMedia, type MediaOutcome } from "./media";

export interface StandingSeriesCounts {
  claimed: number;
  recovered: number;
  runsOpened: number;
  runsClosed: number;
  produced: number;
  skipped: number;
  failed: number;
  retried: number;
  deferred: number;
  released: number;
  finishing: number;
  blocked: number;
  autoPaused: number;
  requeued: number;
  staleResults: number;
  notConfigured: number;
  notRunnable: 0 | 1;
  held: 0 | 1;
  probed: 0 | 1;
  /** Dated occurrences recorded as missed this tick (contracts/worker.md §5). */
  missed: number;
  /** Dated rows whose `next_target_date` moved forward this tick (contracts/worker.md §5). */
  retired: number;
}

export const emptyStandingSeriesCounts = (): StandingSeriesCounts => ({
  claimed: 0,
  recovered: 0,
  runsOpened: 0,
  runsClosed: 0,
  produced: 0,
  skipped: 0,
  failed: 0,
  retried: 0,
  deferred: 0,
  released: 0,
  finishing: 0,
  blocked: 0,
  autoPaused: 0,
  requeued: 0,
  staleResults: 0,
  notConfigured: 0,
  notRunnable: 0,
  held: 0,
  probed: 0,
  missed: 0,
  retired: 0,
});

export interface StandingSeriesContext {
  config: SchedulerConfig;
  /** Epoch ms by which the tick must be finished. */
  deadline: number;
  counts: StandingSeriesCounts;
  llm?: LlmProvider;
}

type ErrorKind = NonNullable<StandingSeriesPositionPatch["lastErrorKind"]>;
const TEMPORARY = new Set<ErrorKind>(["timeout", "rate_limited", "unavailable", "internal", "interrupted"]);

/** The guard inside the policy transaction found the series lease lost. */
class GuardLost extends Error {
  constructor() {
    super("stale");
  }
}

function llmTimeoutMs(): number {
  return parseLlmLimits(process.env).timeoutMs;
}

/** Closes `run` via the shared `closeRun` and tallies the result into the tick's counts. */
async function closeRunCounted(scope: ProjectScope, run: StandingSeriesRunRecord, counts: StandingSeriesCounts, now: Date): Promise<void> {
  const { closed, autoPaused } = await closeRun(scope, run, now);
  if (!closed) return;
  counts.runsClosed++;
  if (autoPaused) counts.autoPaused++;
}

/** Whether any position is still `queued` or `running` — the only question that decides if a run may close (review F1/F2). */
function hasOpenWork(byStatus: Record<StandingSeriesPositionRecord["status"], number>): boolean {
  return byStatus.queued + byStatus.running > 0;
}

/** Settles the dated occurrence matching `positionId`, if any (a cadence position is a no-op). */
async function settleOccurrence(scope: ProjectScope, positionId: string, outcome: "produced" | "failed" | "skipped", at: Date): Promise<void> {
  const occurrence = await scope.datedOccurrences.forPosition(positionId);
  if (occurrence) await scope.datedOccurrences.settle(occurrence.id, outcome, at);
}

export async function processClaimedSeries(claimed: ClaimedStandingSeries, ctx: StandingSeriesContext): Promise<void> {
  const { series, token, owner } = claimed;
  const cfg = standingSeriesConfig(ctx.config);
  const { counts } = ctx;
  let resolvedKey: string | null = null;

  const scope = await forJobRunner(series.projectId, series.createdByUserId);
  const now = await clock.now();

  const openResult = await openOrResumeRun(scope, series, now);
  if (!openResult) return;
  const run = openResult.run;
  const config = run.config as StandingSeriesRunConfig;
  let plan = run.plan as { angles: { title: string; description: string }[] } | null;
  if (openResult.opened) counts.runsOpened++;
  if (run.closedAt) {
    counts.blocked++;
    return;
  }

  // 7.2 — plan, only when requested_count >= 2 and plan IS NULL, and only for a cadence run (B9).
  if (config.rule === "cadence" && run.requestedCount >= 2 && plan === null) {
    const remaining = ctx.deadline - (await clock.now()).getTime();
    if (remaining - cfg.persistReserveMs < cfg.minCallMs) {
      counts.released++;
      return;
    }
    const avoid = avoidTitles(await scope.standingSeriesRuns.recentClosedPlans(series.id, AVOID_RUNS));
    const liveAccountIds = config.targetAccountIds.filter((id) => !run.droppedAccountIds.includes(id));
    const planResult = await planSeries(
      scope,
      {
        voiceProfileId: config.voiceProfileId,
        brief: config.brief,
        sourceText: null,
        instructions: config.template,
        targetAccountIds: liveAccountIds,
        mediaIds: [],
        count: run.requestedCount,
      },
      ctx.llm,
      { avoidTitles: avoid, purpose: "generate.standing_series_plan" },
    );
    if (planResult.ok) {
      const set = await scope.standingSeriesRuns.setPlan(run.id, { angles: planResult.angles });
      if (!set) {
        const winner = await scope.standingSeriesRuns.get(run.id);
        if (winner) plan = winner.plan as { angles: { title: string; description: string }[] } | null;
      } else {
        plan = { angles: planResult.angles };
      }
    } else if (planResult.kind === "credit_exhausted") {
      counts.requeued++;
      return;
    } else {
      const attempts = run.planAttemptCount + 1;
      if (TEMPORARY.has(planResult.kind as ErrorKind) && attempts < cfg.maxAttempts) {
        await scope.standingSeriesRuns.update(run.id, { planAttemptCount: attempts, planNextAttemptAt: nextRetryAt(now, attempts, cfg) });
        counts.retried++;
        return;
      }
      const positions = await scope.standingSeriesPositions.listForRun(run.id);
      for (const p of positions) {
        if (p.status !== "queued") continue;
        await scope.standingSeriesPositions.update(p.id, {
          status: "failed",
          lastErrorKind: planResult.kind as ErrorKind,
          lastError: planResult.message,
          finishedAt: now,
        });
        counts.failed++;
      }
      await closeRunCounted(scope, run, counts, now);
      return;
    }
  }

  // 7.3 — produce positions, one at a time.
  let producedThisTick = 0;
  while (producedThisTick < cfg.maxPosts) {
    const iterNow = await clock.now();
    if (iterNow.getTime() + cfg.minCallMs + cfg.persistReserveMs > ctx.deadline) return;

    const freshSeries = await scope.standingSeries.get(series.id);
    if (!freshSeries?.enabled) return;

    const position = await scope.standingSeriesPositions.nextDue(run.id, iterNow);
    if (!position) {
      // `null` means nothing is due *right now* — not that nothing is left. A position in retry
      // backoff is `queued` with a future `next_attempt_at`, so it is neither `nextDue` nor safe to
      // treat as finished (review F1); only close when no position is `queued`/`running` at all.
      const byStatus = await scope.standingSeriesPositions.countByStatus(run.id);
      if (hasOpenWork(byStatus)) return;
      await closeRunCounted(scope, run, counts, iterNow);
      return;
    }

    const existing = await scope.posts.findByStandingSeriesPosition(position.id, { includeDeleted: true });
    if (existing) {
      counts.finishing++;
      await finishPosition(scope, series.id, token, config.resolved, position, existing.id, counts);
      producedThisTick++;
      continue;
    }

    const liveAccountIds = config.targetAccountIds.filter((id) => !run.droppedAccountIds.includes(id));
    const accounts = await loadAccounts(scope, liveAccountIds);
    let media: MediaOutcome;
    try {
      media = await withinBudget(
        resolvePositionMedia(scope, position, config.media, accounts),
        ctx.deadline - (await clock.now()).getTime() - cfg.minCallMs - cfg.persistReserveMs,
      );
    } catch (error) {
      if (error instanceof Overran) {
        counts.released++;
        return;
      }
      throw error;
    }
    if (!media.ok) {
      if (media.requeue) {
        // An image-generation billing refusal, not a terminal media failure: requeue with no
        // attempt counted, exactly as the text model call does below (review F5).
        await scope.standingSeriesPositions.update(position.id, { status: "queued", nextAttemptAt: iterNow, pendingRetry: null });
        counts.requeued++;
        return;
      }
      await scope.standingSeriesPositions.update(position.id, {
        status: "skipped",
        skipReason: media.skip.reason,
        skipAccountId: media.skip.accountId,
        finishedAt: iterNow,
      });
      await settleOccurrence(scope, position.id, "skipped", iterNow);
      counts.skipped++;
      continue;
    }

    await scope.standingSeriesPositions.update(position.id, { status: "running", startedAt: iterNow });

    let llm: LlmProvider;
    let callOwner: string | undefined = owner;
    let source: "project" | "install" = "install";
    if (ctx.llm) {
      llm = ctx.llm;
    } else {
      const resolved = await resolveLlmForProject(series.projectId);
      if (!resolved.ok) {
        counts.notConfigured++;
        await scope.standingSeriesPositions.update(position.id, { status: "queued" });
        return;
      }
      llm = resolved.llm;
      callOwner = resolved.owner;
      resolvedKey = resolved.apiKey;
      source = resolved.source;
    }
    const recorder = createUsageRecorder({ projectId: series.projectId, purpose: "generate.standing_series_post", source });

    const voice: VoiceSnapshot = await takeVoice(scope, config.voiceProfileId);
    const groups = groupsForAccounts(accounts);
    const angles = plan?.angles ?? null;
    const angle = angles?.[position.position];
    const seriesField =
      config.rule === "cadence" && run.requestedCount >= 2 && angle
        ? {
            id: run.id,
            position: position.position,
            angle,
            otherAngles: angles!.filter((_, i) => i !== position.position).map((a) => a.title),
          }
        : null;
    const dated = position.dated as DatedPosition | null;
    const instructions = dated ? renderTemplate(config.template, dated.values, { mark: true }) : config.template;

    const window = Math.min(llmTimeoutMs(), ctx.deadline - (await clock.now()).getTime() - cfg.persistReserveMs);
    if (window < cfg.minCallMs) {
      // Media resolution (now budget-wrapped above) can still eat most of the tick budget; re-check
      // right before the call, matching jobs/runner.ts:279, and release untouched rather than start
      // a call with a sub-minimum or negative timeout (review F4).
      await scope.standingSeriesPositions.update(position.id, { status: "queued" });
      counts.released++;
      return;
    }
    const step = await runGenerationStep(
      scope,
      {
        label: "generate.standing_series_post",
        purpose: "generate.standing_series_post",
        voice,
        groups,
        assets: media.assets,
        inputs: { brief: config.brief, sourceText: null, instructions, series: seriesField },
        timeoutMs: window,
      },
      llm,
      {
        pending: (position.pendingRetry as PendingRetry | null) ?? null,
        owner: callOwner,
        recorder,
        retryWindowMs: async () => {
          const w = Math.min(llmTimeoutMs(), ctx.deadline - (await clock.now()).getTime() - cfg.persistReserveMs);
          return w >= cfg.minCallMs ? w : null;
        },
      },
    );
    if (claimed.probe) counts.probed = 1;

    // Every exit from here flushes the recorder immediately, as jobs/runner.ts:336 does, so a
    // failed, deferred or credit-refused call still reaches the usage ledger; only the success
    // path (below) has a post id to link it to (review F3).
    if (step.ok === "retry") {
      await scope.standingSeriesPositions.update(position.id, { status: "queued", pendingRetry: step.pending, nextAttemptAt: await clock.now() });
      counts.deferred++;
      await recorder.flush();
      return;
    }
    if (step.ok === false) {
      const kind: LlmFailureKind = step.kind;
      if (kind === "credit_exhausted") {
        await scope.standingSeriesPositions.update(position.id, { status: "queued", nextAttemptAt: await clock.now(), pendingRetry: null });
        counts.requeued++;
        await recorder.flush();
        return;
      }
      await recordFailure(scope, {
        mode: "standing_series_post",
        standingSeriesRunId: run.id,
        standingSeriesPosition: position.position,
        inputs: {
          brief: config.brief,
          sourceText: null,
          instructions,
          mediaAssetIds: media.assets.map((a) => a.id),
          targetAccountIds: accounts.map((a) => a.id),
          series: seriesField,
        },
        kind,
        attempts: step.attempts,
        provider: step.provider,
        model: step.model,
      });
      if (TEMPORARY.has(kind as ErrorKind)) {
        const attempts = position.attemptCount + 1;
        if (attempts >= cfg.maxAttempts) {
          const finishedAt = await clock.now();
          await scope.standingSeriesPositions.update(position.id, { status: "failed", lastErrorKind: kind as ErrorKind, lastError: llmFailureMessage(kind), finishedAt });
          await settleOccurrence(scope, position.id, "failed", finishedAt);
          counts.failed++;
        } else {
          await scope.standingSeriesPositions.update(position.id, {
            status: "queued",
            attemptCount: attempts,
            nextAttemptAt: nextRetryAt(await clock.now(), attempts, cfg),
          });
          counts.retried++;
        }
      } else {
        const finishedAt = await clock.now();
        await scope.standingSeriesPositions.update(position.id, { status: "failed", lastErrorKind: kind as ErrorKind, lastError: llmFailureMessage(kind), finishedAt });
        await settleOccurrence(scope, position.id, "failed", finishedAt);
        counts.failed++;
      }
      await recorder.flush();
      return;
    }

    const inputs: GenerationRecord["inputs"] = {
      brief: config.brief,
      sourceText: null,
      instructions,
      mediaAssetIds: media.assets.map((a) => a.id),
      targetAccountIds: accounts.map((a) => a.id),
      series: seriesField,
    };
    const record: GenerationRecord = {
      at: (await clock.now()).toISOString(),
      mode: "standing_series_post",
      provider: step.provider,
      model: step.model,
      voiceProfile: { id: voice.id, versionId: voice.versionId, version: voice.version, name: voice.name },
      standingSeries: { id: series.id, name: series.name, occurrenceRule: series.occurrenceRule },
      inputs,
      prompt: step.prompt,
      policies: { requested: config.requested, resolved: config.resolved, decision: null },
      attempts: step.attempts,
      retried: step.retried,
      output: step.output,
      remainingProblems: step.remainingProblems,
      accounts: groups.flatMap((g) => g.accounts.map((a) => ({ accountId: a.id, displayName: a.displayName, providerKey: a.providerKey, instructions: null, groupKey: g.key }))),
    };

    let postId: string | "stale";
    try {
      postId = await scope.transaction(async (tx) => {
        const lease = await tx.standingSeries.lockShared(series.id);
        if (!lease || lease.leaseOwner !== token) return "stale";
        return saveGeneratedPost(tx, {
          accounts,
          groups,
          variants: step.output.variants,
          assets: media.assets,
          imageAltTexts: step.output.imageAltTexts,
          record,
          schedulingPolicy: config.resolved.scheduling,
          createdByUserId: series.createdByUserId,
          link: { standingSeriesPositionId: position.id },
          queueNotBefore: dated ? periodStartInstant(Temporal.PlainDate.from(dated.targetDate), scope.project.timezone) : null,
        });
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const winner = await scope.posts.findByStandingSeriesPosition(position.id, { includeDeleted: true });
      if (!winner) throw error;
      postId = winner.id;
    }
    if (postId === "stale") {
      counts.staleResults++;
      await recorder.flush();
      return;
    }
    await recorder.flush({ postId });
    await finishPosition(scope, series.id, token, config.resolved, position, postId, counts);
    counts.produced++;
    producedThisTick++;
  }

  // The loop above exits here only on `producedThisTick >= cfg.maxPosts` (every other exit already
  // returned). That counter hitting its cap says nothing about whether work remains, so a run whose
  // last tick lands exactly on it must still be closed here rather than waiting for the next tick to
  // find nothing due (review F2).
  const byStatus = await scope.standingSeriesPositions.countByStatus(run.id);
  if (!hasOpenWork(byStatus)) await closeRunCounted(scope, run, counts, await clock.now());

  logLine(`standing_series series=${series.id} run=${run.id} produced=${producedThisTick}`, resolvedKey);
}

/** 7.4 — finish a position: variants, policy, then mark produced. */
async function finishPosition(
  scope: ProjectScope,
  seriesId: string,
  token: string,
  resolved: StandingSeriesRunConfig["resolved"],
  position: StandingSeriesPositionRecord,
  postId: string,
  counts: StandingSeriesCounts,
): Promise<void> {
  const post = await scope.posts.get(postId);
  if (post && post.reviewState === "needs_review") {
    try {
      await withinBudget(prepareVariants(scope, postId), 60_000);
    } catch (error) {
      if (error instanceof Overran) {
        await scope.standingSeries.update(seriesId, { leaseUntil: await clock.now() });
        counts.released++;
        return;
      }
    }
    try {
      await applyApprovalPolicy(scope, postId, resolved, {
        guard: async (tx) => {
          const lease = await tx.standingSeries.lockShared(seriesId);
          if (!lease || lease.leaseOwner !== token) throw new GuardLost();
        },
      });
    } catch (error) {
      if (error instanceof GuardLost) {
        counts.staleResults++;
        return;
      }
      if (!(error instanceof ConflictError)) throw error;
    }
  }
  const finishedAt = await clock.now();
  await scope.standingSeriesPositions.update(position.id, { status: "produced", finishedAt });
  await settleOccurrence(scope, position.id, "produced", finishedAt);
}
