// jobs/runner: process one claimed job item (contracts/runner.md). Every write after the claim is lease-checked
// and holds the job lock first; no model, storage or sharp work happens inside a held transaction.
import { renderTemplate } from "@/lib/jobs/template";
import { itemPayloadSchema, jobInstructionsSnapshotSchema } from "@/lib/validation/jobs";
import type { GenerationRecord } from "@/lib/validation/generation";
import { voiceContentSchema } from "@/lib/validation/voice";
import * as clock from "../../dal/clock";
import { ConflictError } from "../../dal/errors";
import type { ClaimedJobItem } from "../../dal/job-claims";
import { forJobRunner, type ProjectScope } from "../../dal/scope";
import type { JobItemPatch } from "../../dal/jobs";
import { getLlm } from "../../llm";
import { imagesForModel } from "../../llm/images";
import { parseLlmConfig } from "../../llm/config";
import { llmFailureMessage } from "../../llm/messages";
import type { LlmFailureKind, LlmProvider } from "../../llm/types";
import { jobConfig, type SchedulerConfig } from "../../scheduler/config";
import { nextRetryAt } from "../../scheduler/backoff";
import { redact } from "../../scheduler/redact";
import type { GenerationCounts } from "../../scheduler/generation";
import { runGenerationStep, type PendingRetry } from "../generation/core";
import { applyApprovalPolicy } from "../generation/policy";
import { saveGeneratedPost } from "../generation/save";
import { GROUP_LIMIT, groupLimitMessage } from "../../../lib/generation/groups";
import { groupsForAccounts } from "../generation/groups";
import {
  buildRecord,
  isUniqueViolation,
  lastRecord,
  type VoiceSnapshot,
} from "../generation/single";
import { prepareVariants } from "../media-variants";
import { sourceFor } from "./sources";
import { refreshJobStatus } from "./status";

export interface RunnerContext {
  config: SchedulerConfig;
  /** Epoch ms by which the tick must be finished. */
  deadline: number;
  counts: GenerationCounts;
  llm?: LlmProvider;
}

type ErrorKind = NonNullable<JobItemPatch["lastErrorKind"]>;

export const INTERNAL_MESSAGE = "Something went wrong while generating this post.";
const TEMPORARY = new Set<ErrorKind>(["timeout", "rate_limited", "unavailable", "internal", "interrupted"]);
const UNLEASED = { leaseOwner: null, leaseUntil: null } as const;

class Overran extends Error {}
/** The guard inside the policy transaction found the job cancelled or the lease lost. */
class GuardLost extends Error {
  constructor(readonly why: "cancelled" | "stale") {
    super(why);
  }
}

function withinBudget<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Overran()), Math.max(ms, 0));
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function llmTimeoutMs(): number {
  const parsed = parseLlmConfig(process.env);
  return parsed.ok ? parsed.config.timeoutMs : 90_000;
}

function logLine(parts: string): void {
  const parsed = parseLlmConfig(process.env);
  const keys = parsed.ok ? [parsed.config.apiKey] : [];
  console.log(redact(parts, keys));
}

export async function processClaimedItem(claimed: ClaimedJobItem, ctx: RunnerContext): Promise<void> {
  const { job, item, token } = claimed;
  const cfg = jobConfig(ctx.config);
  const { counts } = ctx;
  const t0 = Date.now();
  let outcome = "stale";
  let scope: ProjectScope | null = null;

  const remaining = async () => ctx.deadline - (await clock.now()).getTime();

  /** Lease-checked write under the job lock. Returns false when the lease was lost. */
  async function commit(patch: JobItemPatch, opts: { refresh?: boolean } = { refresh: true }): Promise<boolean> {
    const row = await scope!.transaction(async (tx) => {
      await tx.jobs.lockForUpdate(job.id);
      const updated = await tx.jobItems.updateWithLease(item.id, token, patch);
      if (updated && opts.refresh !== false) await refreshJobStatus(tx, job.id);
      return updated;
    });
    if (!row) counts.staleResults++;
    return row !== null;
  }

  async function fail(kind: ErrorKind, message: string): Promise<void> {
    const ok = await commit({
      status: "failed",
      ...UNLEASED,
      lastErrorKind: kind,
      lastError: message,
      finishedAt: await clock.now(),
      pendingRetry: null,
    });
    if (ok) {
      counts.failed++;
      outcome = `failed:${kind}`;
    }
  }

  async function retryLater(kind: ErrorKind, message: string): Promise<void> {
    const attempts = item.attemptCount + 1;
    if (attempts >= cfg.maxAttempts) return fail(kind, message);
    const now = await clock.now();
    const ok = await commit(
      {
        status: "queued",
        attemptCount: attempts,
        nextAttemptAt: nextRetryAt(now, attempts, cfg),
        ...UNLEASED,
        pendingRetry: null,
        lastErrorKind: kind,
        lastError: message,
      },
      { refresh: false },
    );
    if (ok) {
      counts.retried++;
      outcome = `retried:${kind}`;
    }
  }

  async function release(): Promise<void> {
    if (await commit({ status: "queued", ...UNLEASED })) {
      counts.released++;
      outcome = "released";
    }
  }

  async function finish(postId: string): Promise<void> {
    const s = scope!;
    const post = await s.posts.get(postId);
    if (post && post.reviewState === "needs_review" && (lastRecord(post)?.policies.decision ?? null) === null) {
      try {
        await withinBudget(prepareVariants(s, postId), await remaining());
      } catch (error) {
        if (error instanceof Overran) {
          // Stays running with its post and an already-expired lease: the next tick claims it as `finish`.
          if (await commit({ leaseUntil: await clock.now() }, { refresh: false })) {
            counts.released++;
            outcome = "released";
          }
          return;
        }
        // Reported per target by the gate.
      }
      try {
        await applyApprovalPolicy(
          s,
          postId,
          { approval: job.approvalPolicy, scheduling: job.schedulingPolicy },
          {
            guard: async (tx) => {
              const j = await tx.jobs.lockShared(job.id);
              if (!j || j.status === "cancelled") throw new GuardLost("cancelled");
              const current = await tx.jobItems.get(item.id);
              if (!current || current.leaseOwner !== token) throw new GuardLost("stale");
            },
          },
        );
      } catch (error) {
        if (error instanceof GuardLost) {
          if (error.why === "stale") {
            counts.staleResults++;
            return;
          }
          counts.cancelled++;
          outcome = "cancelled";
        } else if (!(error instanceof ConflictError)) throw error;
      }
    }
    const ok = await commit({
      status: "done",
      ...UNLEASED,
      finishedAt: await clock.now(),
      pendingRetry: null,
    });
    if (ok) {
      counts.done++;
      if (outcome === "stale") outcome = "done";
    }
  }

  try {
    scope = await forJobRunner(job.projectId, job.createdByUserId);
    const s = scope;
    if (claimed.kind === "finish") {
      counts.finishing++;
      const existing = await s.posts.findByJobItemId(item.id, { includeDeleted: true });
      if (existing) await finish(existing.id);
      else await retryLater("internal", INTERNAL_MESSAGE);
      return;
    }

    const existing = await s.posts.findByJobItemId(item.id, { includeDeleted: true });
    if (existing) {
      counts.finishing++;
      await finish(existing.id);
      return;
    }

    const [profile, version] = await Promise.all([
      s.voiceProfiles.get(job.voiceProfileId),
      s.voiceVersions.get(job.voiceProfileVersionId),
    ]);
    if (!profile || !version) throw new Error("pinned voice is missing");
    const voice: VoiceSnapshot = {
      id: profile.id,
      versionId: version.id,
      version: version.version,
      name: profile.name,
      content: voiceContentSchema.parse(version.content),
    };
    const accounts = (await Promise.all(job.targetAccountIds.map((id) => s.accounts.get(id)))).filter(
      (a): a is NonNullable<typeof a> => a !== null,
    );
    if (accounts.length === 0) return await fail("no_targets", "No target accounts left.");

    const assets = item.mediaAssetId ? await s.media.getMany([item.mediaAssetId]) : [];
    if (item.mediaAssetId && assets.length === 0) return await fail("image_deleted", "Image deleted.");

    if (assets.length > 0) {
      let prepared;
      try {
        prepared = await withinBudget(
          imagesForModel(s, assets),
          (await remaining()) - cfg.minCallMs - cfg.persistReserveMs,
        );
      } catch (error) {
        if (error instanceof Overran) return await release();
        throw error;
      }
      if (!prepared.ok) return await fail("image_unavailable", prepared.message);
    }

    const window = Math.min(llmTimeoutMs(), (await remaining()) - cfg.persistReserveMs);
    if (window < cfg.minCallMs) return await release();

    const payload = itemPayloadSchema.safeParse(item.payload);
    const fields = payload.success ? payload.data.fields : {};
    const instructions = renderTemplate(job.template, fields, { mark: true });
    const brief = sourceFor(job.sourceKind).brief;
    const llm = ctx.llm ?? getLlm();
    const pending = (item.pendingRetry as PendingRetry | null) ?? null;

    const parsedSnapshot = jobInstructionsSnapshotSchema.nullable().safeParse(job.postingInstructionsSnapshot ?? null);
    const snapshot = parsedSnapshot.success ? parsedSnapshot.data : null;
    const groups = groupsForAccounts(
      accounts,
      snapshot ? (a) => snapshot.byAccount[a.id] ?? null : undefined,
    );
    if (groups.length > GROUP_LIMIT) return await fail("bad_request", groupLimitMessage(groups.length));
    const step = await runGenerationStep(
      s,
      {
        label: "generate.job_item",
        voice,
        groups,
        assets,
        inputs: { brief, sourceText: null, instructions, series: null },
        timeoutMs: window,
        itemData: { fields: Object.entries(fields) },
      },
      llm,
      {
        pending,
        retryWindowMs: async () => {
          const w = Math.min(llmTimeoutMs(), (await remaining()) - cfg.persistReserveMs);
          return w >= cfg.minCallMs ? w : null;
        },
      },
    );

    if (step.ok === "retry") {
      const ok = await commit(
        { status: "queued", pendingRetry: step.pending, ...UNLEASED, nextAttemptAt: await clock.now() },
        { refresh: false },
      );
      if (ok) {
        counts.deferred++;
        outcome = "deferred";
      }
      return;
    }
    if (step.ok === false) {
      const kind: LlmFailureKind = step.kind;
      return TEMPORARY.has(kind) ? await retryLater(kind, llmFailureMessage(kind)) : await fail(kind, llmFailureMessage(kind));
    }

    const inputs: GenerationRecord["inputs"] = {
      brief,
      sourceText: null,
      instructions,
      itemFields: fields,
      mediaAssetIds: assets.map((a) => a.id),
      targetAccountIds: accounts.map((a) => a.id),
      series: null,
    };
    const record: GenerationRecord = {
      ...buildRecord({
        mode: "job_item",
        outcome: step,
        voice,
        inputs,
        groups,
        requested: { approval: job.requestedApproval, scheduling: job.requestedScheduling },
        resolved: { approval: job.approvalPolicy, scheduling: job.schedulingPolicy },
        at: await clock.now(),
      }),
      job: { id: job.id, itemId: item.id, position: item.position, sourceKind: job.sourceKind },
    };

    let postId: string | "cancelled" | "stale";
    try {
      postId = await s.transaction(async (tx) => {
        const locked = await tx.jobs.lockForUpdate(job.id);
        if (!locked || locked.status === "cancelled") return "cancelled";
        if (!(await tx.jobItems.updateWithLease(item.id, token, { pendingRetry: null }))) return "stale";
        const id = await saveGeneratedPost(tx, {
          accounts,
          groups,
          variants: step.output.variants,
          assets,
          imageAltTexts: step.output.imageAltTexts,
          record,
          schedulingPolicy: job.schedulingPolicy,
          createdByUserId: job.createdByUserId,
          createdByApiKeyId: job.createdByApiKeyId,
          link: { generationJobItemId: item.id },
        });
        await refreshJobStatus(tx, job.id);
        return id;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const winner = await s.posts.findByJobItemId(item.id, { includeDeleted: true });
      if (!winner) throw error;
      postId = winner.id;
    }
    if (postId === "cancelled") {
      counts.cancelled++;
      outcome = "cancelled";
      return;
    }
    if (postId === "stale") {
      counts.staleResults++;
      return;
    }
    await finish(postId);
  } catch {
    // Never reaches Promise.all or another item (FR-017); no error text is logged or stored.
    try {
      if (scope) await retryLater("internal", INTERNAL_MESSAGE);
    } catch {
      outcome = "stale";
    }
  } finally {
    logLine(`generation_job_item job=${job.id} item=${item.id} outcome=${outcome} latency_ms=${Date.now() - t0}`);
  }
}
