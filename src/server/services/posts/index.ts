import { z } from "zod";
import type { ValidationIssue } from "@/providers/types";
import { atSchema, baseTextSchema, externalUrlSchema, POST_MEDIA_MAX, postInputSchema, postTargetInputSchema } from "@/lib/validation/scheduling";
import * as clock from "../../dal/clock";
import { ConflictError, NotFoundError, ValidationIssuesError } from "../../dal/errors";
import type { PostRecord } from "../../dal/posts";
import { actorColumns, attemptActor, resolverColumns, type ProjectScope } from "../../dal/scope";
import type { TargetPatch, TargetRecord } from "../../dal/targets";
import { explicitSchedulePatch } from "./schedule-patch";
import { allocateNextFree, nearQueuedWarnings, peekNextFree, plannedTime, type PlannedTime, type Warning } from "../queue";
import { cancelTargetRow, hasLiveLease, resetEmptyReview } from "./cancel";
import { prepareVariants } from "../media-variants";
import { applyDerivedStatus } from "./status";
import { lockPost, need, withLockedTarget } from "./locked";
import { errorsOf, gate, issuesFor } from "./gate";
import { resolvedEvent } from "../activity/classify";
import { recordTargetEvent } from "../activity/record";

export { applyDerivedStatus, derivePostStatus } from "./status";
export { lockPost, withLockedTarget } from "./locked";
export { gate } from "./gate";
export {
  retryBlockedReason,
  retryInputSchema,
  retryLockedTarget,
  retryTarget,
  type RetryFailureReason,
  type RetryInput,
  type RetryResult,
} from "./retry";
export {
  previewRetryAll,
  RETRY_ALL_CAP,
  retryAllFailed,
  retryAllInputSchema,
  retryAllScopeSchema,
  type RetryAllAccountRow,
  type RetryAllPreview,
  type RetryAllResult,
  type RetryAllSkipReason,
  type SkipCounts,
} from "./retry-all";
export { excerptOf, listPosts, POSTS_PAGE_SIZE, type PostList, type PostListItem } from "./list";
export { getPostView, type AttemptView, type PostView, type PostViewMedia, type PostViewTarget } from "./view";
export { explicitSchedulePatch };
export { checkComposition, previewExplicitTime, type CompositionCheck, type ExplicitTimePreview, type TargetCheck } from "./compose";

export type TargetFailureCode =
  | "no_active_slots"
  | "no_free_occurrence"
  | "validation"
  | "not_queueable"
  | "account_unavailable"
  | "in_past";

export type TargetResult<T> =
  | ({ targetId: string; accountId: string; ok: true } & T)
  | { targetId: string; accountId: string; ok: false; code: TargetFailureCode; message: string; issues?: ValidationIssue[] };

export interface PostTargetView {
  id: string;
  accountId: string;
  status: TargetRecord["status"];
  scheduleKind: TargetRecord["scheduleKind"];
  scheduledAt: Date | null;
  localTime: string | null;
  slotId: string | null;
  overrideText: string | null;
  attemptCount: number;
  nextAttemptAt: Date | null;
  lastError: string | null;
  externalId: string | null;
  externalUrl: string | null;
  publishedAt: Date | null;
  inProgress: boolean;
}

export interface PostDetail {
  post: PostRecord;
  targets: PostTargetView[];
  mediaIds: string[];
}

type Tx = ProjectScope;
const uuid = z.uuid();
const REVIEW = z.enum(["draft", "needs_review", "approved", "rejected"]);
const STARTED: readonly TargetRecord["status"][] = ["publishing", "published", "ambiguous"];

const createSchema = postInputSchema.extend({
  origin: z.enum(["manual", "generated", "api"]).optional(),
  generationMetadata: z.record(z.string(), z.unknown()).nullish(),
  reviewState: REVIEW.optional(),
  // Used only by the generation service; the composer never sends them.
  generationRequestId: uuid.optional(),
  schedulingPolicy: z.enum(["leave_as_draft", "add_to_queue"]).nullable().optional(),
  seriesId: uuid.optional(),
  seriesPosition: z.number().int().min(0).max(32_000).optional(),
});
const patchSchema = z.object({
  baseText: baseTextSchema.optional(),
  // No `.default`: an absent key must stay absent, or an edit of the text alone would clear media and targets.
  mediaIds: z.array(uuid).max(POST_MEDIA_MAX, { error: "Too many images" }).optional(),
  generationMetadata: z.record(z.string(), z.unknown()).nullable().optional(),
  targets: z
    .array(postTargetInputSchema)
    .max(50, { error: "Too many accounts" })
    .refine((t) => new Set(t.map((x) => x.accountId)).size === t.length, { error: "An account can appear only once" })
    .optional(),
});
const selectSchema = z.object({ targetIds: z.array(uuid).optional() });

async function targetView(tx: Tx, t: TargetRecord, now: Date): Promise<PostTargetView> {
  return {
    id: t.id,
    accountId: t.socialAccountId,
    status: t.status,
    scheduleKind: t.scheduleKind,
    scheduledAt: t.scheduledAt,
    localTime: t.scheduledAt ? plannedTime(t.scheduledAt, t.slotId, tx.project.timezone).localTime : null,
    slotId: t.slotId,
    overrideText: t.overrideText,
    attemptCount: t.attemptCount,
    nextAttemptAt: t.nextAttemptAt,
    lastError: t.lastError,
    externalId: t.externalId,
    externalUrl: t.externalUrl,
    publishedAt: t.publishedAt,
    inProgress: hasLiveLease(t, now),
  };
}

async function detail(tx: Tx, postId: string): Promise<PostDetail> {
  const post = await tx.posts.get(postId);
  if (!post) throw new NotFoundError();
  const now = await clock.now();
  const targets = await tx.targets.listForPost(postId);
  return {
    post,
    targets: await Promise.all(targets.map((t) => targetView(tx, t, now))),
    mediaIds: await tx.posts.listMediaIds(postId),
  };
}

/**
 * Adapted images are made before any transaction opens: converting and storing can take seconds, which must
 * not be spent holding row locks. Best effort; a pair that fails shows up as `variant_failed` at the gate.
 */
export async function prepareForScheduling(
  scope: ProjectScope,
  postId: string,
  opts?: Parameters<typeof prepareVariants>[2],
): Promise<void> {
  try {
    await prepareVariants(scope, postId, opts);
  } catch {
    // Reported per target by the gate.
  }
}

function fail(t: TargetRecord, code: TargetFailureCode, message: string, issues?: ValidationIssue[]): TargetResult<never> {
  return { targetId: t.id, accountId: t.socialAccountId, ok: false, code, message, ...(issues ? { issues } : {}) };
}

/** Queueable: draft or cancelled, on a post that is not awaiting review. */
function queueableGate(post: PostRecord, t: TargetRecord): TargetResult<never> | null {
  if (t.status !== "draft" && t.status !== "cancelled") {
    return fail(t, "not_queueable", "This post is already scheduled or has been published.");
  }
  if (post.reviewState === "rejected") return fail(t, "not_queueable", "This post was rejected.");
  if (post.reviewState === "needs_review") {
    return fail(t, "not_queueable", "This post is waiting for review before it can be scheduled.");
  }
  return null;
}

function pickTargets(all: TargetRecord[], ids: string[] | undefined): TargetRecord[] {
  if (!ids) return all;
  const byId = new Map(all.map((t) => [t.id, t]));
  return ids.map((id) => {
    const t = byId.get(id);
    if (!t) throw new NotFoundError();
    return t;
  });
}

// ---------------------------------------------------------------- create / update / delete

export async function createDraft(scope: ProjectScope, input: unknown): Promise<PostDetail> {
  const parsed = createSchema.parse(input);
  need(scope, { post: ["edit"] });
  return scope.transaction(async (tx) => {
    need(tx, { post: ["edit"] });
    const now = await clock.now();
    for (const target of parsed.targets) if (!(await tx.accounts.get(target.accountId))) throw new NotFoundError();
    if ((await tx.media.lockShared(parsed.mediaIds)).length !== new Set(parsed.mediaIds).size) throw new NotFoundError();
    const post = await tx.posts.insert({
      baseText: parsed.baseText,
      ...actorColumns(tx),
      ...(parsed.origin ? { origin: parsed.origin } : {}),
      ...(tx.actor.kind === "api_key" ? { origin: "api" as const } : {}),
      ...(parsed.generationMetadata !== undefined ? { generationMetadata: parsed.generationMetadata } : {}),
      ...(parsed.reviewState ? { reviewState: parsed.reviewState } : {}),
      ...(parsed.generationRequestId ? { generationRequestId: parsed.generationRequestId } : {}),
      ...(parsed.schedulingPolicy ? { schedulingPolicy: parsed.schedulingPolicy } : {}),
      ...(parsed.seriesId ? { seriesId: parsed.seriesId, seriesPosition: parsed.seriesPosition ?? 0 } : {}),
    });
    await tx.posts.setMedia(post.id, parsed.mediaIds);
    await tx.media.markUsed(parsed.mediaIds, now);
    await tx.targets.insertMany(
      parsed.targets.map((t) => ({
        postId: post.id,
        socialAccountId: t.accountId,
        ...(t.overrideText != null ? { overrideText: t.overrideText } : {}),
      })),
    );
    await applyDerivedStatus(tx, post.id);
    return detail(tx, post.id);
  });
}

export async function updatePost(scope: ProjectScope, postId: string, patchInput: unknown): Promise<PostDetail> {
  const id = uuid.parse(postId);
  const patch = patchSchema.parse(patchInput);
  need(scope, { post: ["edit"] });
  if (patch.mediaIds) await prepareForScheduling(scope, id, { mediaIds: patch.mediaIds });
  return scope.transaction(async (tx) => {
    need(tx, { post: ["edit"] });
    await lockPost(tx, id);
    const now = await clock.now();
    const existing = await tx.targets.listForPost(id);
    if (existing.some((t) => STARTED.includes(t.status))) {
      throw new ConflictError("Publishing has started, so this post can no longer be edited.");
    }
    if (patch.baseText !== undefined || patch.generationMetadata !== undefined) {
      await tx.posts.update(id, {
        ...(patch.baseText !== undefined ? { baseText: patch.baseText } : {}),
        ...(patch.generationMetadata !== undefined ? { generationMetadata: patch.generationMetadata } : {}),
      });
    }
    if (patch.mediaIds) {
      if ((await tx.media.lockShared(patch.mediaIds)).length !== new Set(patch.mediaIds).size) throw new NotFoundError();
      await tx.posts.setMedia(id, patch.mediaIds);
      await tx.media.markUsed(patch.mediaIds, now);
    }
    if (patch.targets) {
      const wanted = new Map(patch.targets.map((t) => [t.accountId, t]));
      for (const t of existing) {
        const want = wanted.get(t.socialAccountId);
        if (!want) {
          if (t.status !== "cancelled") await cancelTargetRow(tx, t.id);
        } else {
          await tx.targets.update(t.id, {
            overrideText: want.overrideText ?? null,
            ...(t.status === "cancelled" ? { status: "draft" as const } : {}),
          });
        }
        wanted.delete(t.socialAccountId);
      }
      for (const want of wanted.values()) {
        if (!(await tx.accounts.get(want.accountId))) throw new NotFoundError();
      }
      await tx.targets.insertMany(
        [...wanted.values()].map((t) => ({
          postId: id,
          socialAccountId: t.accountId,
          ...(t.overrideText != null ? { overrideText: t.overrideText } : {}),
        })),
      );
    }
    // A scheduled target must stay publishable: refuse the whole edit if any would now fail.
    const problems: Record<string, ValidationIssue[]> = {};
    for (const t of await tx.targets.listForPost(id)) {
      if (t.status !== "scheduled") continue;
      const g = await gate(tx, t);
      if (!g.ok && g.code === "validation") problems[t.id] = g.issues ?? [];
    }
    if (Object.keys(problems).length > 0) throw new ValidationIssuesError(problems);
    await applyDerivedStatus(tx, id);
    return detail(tx, id);
  });
}

const variantEditsSchema = z.object({
  edits: z
    .array(z.object({ accountIds: z.array(z.uuid()).min(1).max(50), text: baseTextSchema }))
    .min(1)
    .max(50),
});

/**
 * Sets the text of every live (draft) target of the listed accounts, through `updatePost`. Scheduled targets
 * keep their text. The returned problems are the blocking issues left on those targets.
 */
export async function updatePostVariants(
  scope: ProjectScope,
  postId: string,
  input: unknown,
): Promise<{ detail: PostDetail; problems: { accountIds: string[]; targetId: string; issues: ValidationIssue[] }[] }> {
  const id = uuid.parse(postId);
  const { edits } = variantEditsSchema.parse(input);
  need(scope, { post: ["edit"] });
  const edit = new Map<string, { text: string; accountIds: string[] }>();
  for (const e of edits) for (const accountId of e.accountIds) edit.set(accountId, e);
  const current = (await scope.targets.listForPost(id)).filter((t) => t.status !== "cancelled");
  const detail = await updatePost(scope, id, {
    targets: current.map((t) => {
      const text = t.status === "draft" ? edit.get(t.socialAccountId)?.text : undefined;
      return { accountId: t.socialAccountId, overrideText: text ?? t.overrideText };
    }),
  });
  const accountOf = new Map(current.map((t) => [t.id, t.socialAccountId]));
  const problems: { accountIds: string[]; targetId: string; issues: ValidationIssue[] }[] = [];
  for (const r of await validatePost(scope, id)) {
    const accountId = accountOf.get(r.targetId);
    const issues = errorsOf(r.issues);
    const edited = accountId ? edit.get(accountId) : undefined;
    if (edited && issues.length > 0) problems.push({ accountIds: edited.accountIds, targetId: r.targetId, issues });
  }
  return { detail, problems };
}

export async function setReviewState(scope: ProjectScope, postId: string, state: unknown): Promise<void> {
  const id = uuid.parse(postId);
  const reviewState = REVIEW.parse(state);
  if (reviewState === "rejected") throw new ConflictError("Use reject to reject a post.");
  need(scope, { post: ["edit"] });
  await scope.transaction(async (tx) => {
    need(tx, { post: ["edit"] });
    await lockPost(tx, id);
    await tx.posts.update(id, { reviewState });
    await applyDerivedStatus(tx, id);
  });
}

export async function deletePost(scope: ProjectScope, postId: string): Promise<void> {
  const id = uuid.parse(postId);
  need(scope, { post: ["delete"] });
  await scope.transaction(async (tx) => {
    need(tx, { post: ["delete"] });
    await lockPost(tx, id);
    const targets = await tx.targets.listForPost(id);
    if (targets.some((t) => STARTED.includes(t.status))) {
      throw new ConflictError("Publishing has started. Cancel the remaining targets instead.");
    }
    for (const t of targets) if (t.status !== "cancelled") await cancelTargetRow(tx, t.id);
    await tx.posts.softDelete(id, await clock.now());
  });
}

export async function getPost(scope: ProjectScope, postId: string): Promise<PostDetail> {
  const id = uuid.parse(postId);
  need(scope, { post: ["view"] });
  return detail(scope, id);
}

export async function validatePost(
  scope: ProjectScope,
  postId: string,
): Promise<{ targetId: string; issues: ValidationIssue[] }[]> {
  const id = uuid.parse(postId);
  need(scope, { post: ["view"] });
  if (!(await scope.posts.get(id))) throw new NotFoundError();
  await prepareForScheduling(scope, id);
  const out: { targetId: string; issues: ValidationIssue[] }[] = [];
  for (const t of await scope.targets.listForPost(id)) {
    if (t.status === "cancelled") continue;
    const account = await scope.accounts.get(t.socialAccountId);
    out.push({ targetId: t.id, issues: (account ? await issuesFor(scope, t, account) : null) ?? [] });
  }
  return out;
}

// ---------------------------------------------------------------- queue / schedule / publish now

/** Same computation as allocation, with no writes and nothing reserved (FR-025). */
export async function previewQueue(
  scope: ProjectScope,
  postId: string,
): Promise<TargetResult<PlannedTime & { issues: ValidationIssue[] }>[]> {
  const id = uuid.parse(postId);
  need(scope, { post: ["view"] });
  const post = await scope.posts.get(id);
  if (!post) throw new NotFoundError();
  await prepareForScheduling(scope, id);
  const now = await clock.now();
  const out: TargetResult<PlannedTime & { issues: ValidationIssue[] }>[] = [];
  for (const t of await scope.targets.listForPost(id)) {
    if (t.status !== "draft" && t.status !== "cancelled") continue;
    const blocked = queueableGate(post, t);
    if (blocked) {
      out.push(blocked);
      continue;
    }
    const g = await gate(scope, t);
    if (!g.ok) {
      out.push(fail(t, g.code, g.message, g.issues));
      continue;
    }
    const slot = await peekNextFree(scope, t.socialAccountId, { after: now });
    out.push(
      slot.ok
        ? { targetId: t.id, accountId: t.socialAccountId, ok: true, ...slot.planned, issues: g.issues }
        : fail(t, slot.code, slot.message),
    );
  }
  return out;
}

const queueSchema = selectSchema.extend({ expected: z.record(z.string(), z.string()).optional() });

export async function addToQueue(
  scope: ProjectScope,
  postId: string,
  input: unknown = {},
): Promise<TargetResult<PlannedTime & { changedFromPreview: boolean }>[]> {
  const id = uuid.parse(postId);
  const opts = queueSchema.parse(input);
  need(scope, { post: ["schedule"] });
  await prepareForScheduling(scope, id, opts.targetIds ? { targetIds: opts.targetIds } : undefined);
  return scope.transaction(async (tx) => {
    need(tx, { post: ["schedule"] });
    const post = await lockPost(tx, id);
    const all = await tx.targets.listForPost(id);
    const chosen = pickTargets(all, opts.targetIds).filter((t) => opts.targetIds || t.status === "draft" || t.status === "cancelled");
    return queueTargetsInTx(tx, post, chosen, opts.expected ? { expected: opts.expected } : undefined);
  });
}

/**
 * The body of `addToQueue` after the post is locked, for callers that already hold the lock (the generation
 * policy, a review approval). `targets` are the chosen targets of `post`; `expected` maps target id to the
 * previewed instant so a result can say it changed.
 */
export async function queueTargetsInTx(
  tx: Tx,
  post: PostRecord,
  targets: TargetRecord[],
  opts: { expected?: Record<string, string> } = {},
): Promise<TargetResult<PlannedTime & { changedFromPreview: boolean }>[]> {
  const id = post.id;
  const chosen = targets;
  const now = await clock.now();
  const out: TargetResult<PlannedTime & { changedFromPreview: boolean }>[] = [];
  // Hold occurrences in one global order (by account) so two posts sharing accounts
  // queue concurrently without deadlocking on each other's unique-index entries (F20).
  const byAccount = [...chosen].sort((a, b) =>
    a.socialAccountId < b.socialAccountId ? -1 : a.socialAccountId > b.socialAccountId ? 1 : a.id < b.id ? -1 : 1,
  );
  for (const t of byAccount) {
    const blocked = queueableGate(post, t);
    if (blocked) {
      out.push(blocked);
      continue;
    }
    const g = await gate(tx, t);
    if (!g.ok) {
      out.push(fail(t, g.code, g.message, g.issues));
      continue;
    }
    const slot = await allocateNextFree(tx, { id: t.id, accountId: t.socialAccountId }, { after: now });
    if (!slot.ok) {
      out.push(fail(t, slot.code, slot.message));
      continue;
    }
    await tx.targets.update(t.id, {
      status: "scheduled",
      attemptCount: 0,
      lastError: null,
      stepState: null,
      firstStepAt: null,
      publishStartedAt: null,
    });
    const expected = opts.expected?.[t.id];
    out.push({
      targetId: t.id,
      accountId: t.socialAccountId,
      ok: true,
      ...slot.planned,
      changedFromPreview: expected !== undefined && new Date(expected).getTime() !== slot.instant.getTime(),
    });
  }
  await applyDerivedStatus(tx, id);
  const order = new Map(chosen.map((t, i) => [t.id, i]));
  return out.sort((a, b) => order.get(a.targetId)! - order.get(b.targetId)!);
}

/** Shared by `scheduleAt` and `publishNow`: an explicit instant with no held occurrence. */
async function scheduleExplicit(
  tx: Tx,
  postId: string,
  targetIds: string[] | undefined,
  kind: "explicit" | "now",
  at: (now: Date) => Date,
): Promise<TargetResult<PlannedTime & { warnings: Warning[] }>[]> {
  const post = await lockPost(tx, postId);
  const now = await clock.now();
  const when = at(now);
  const all = await tx.targets.listForPost(postId);
  const chosen = pickTargets(all, targetIds).filter((t) => targetIds || t.status === "draft" || t.status === "cancelled" || t.status === "scheduled");
  const out: TargetResult<PlannedTime & { warnings: Warning[] }>[] = [];
  for (const t of chosen) {
    if (kind === "explicit" && when.getTime() <= now.getTime()) {
      out.push(fail(t, "in_past", "That time has passed. Use Publish now instead."));
      continue;
    }
    if (t.status !== "scheduled") {
      const blocked = queueableGate(post, t);
      if (blocked) {
        out.push(blocked);
        continue;
      }
    }
    const g = await gate(tx, t);
    if (!g.ok) {
      out.push(fail(t, g.code, g.message, g.issues));
      continue;
    }
    // Reschedule: the single update frees any held occurrence and switches the kind together.
    const moved = await tx.targets.update(
      t.id,
      {
        status: "scheduled",
        ...explicitSchedulePatch(kind, when),
        attemptCount: 0,
        lastError: null,
        stepState: null,
        firstStepAt: null,
        publishStartedAt: null,
      },
      { statuses: ["draft", "cancelled", "scheduled"] },
    );
    if (!moved) {
      out.push(fail(t, "not_queueable", "Publishing in progress. Try again in a moment."));
      continue;
    }
    out.push({
      targetId: t.id,
      accountId: t.socialAccountId,
      ok: true,
      ...plannedTime(when, null, tx.project.timezone),
      warnings: kind === "explicit" ? await nearQueuedWarnings(tx, t.socialAccountId, when, t.id) : [],
    });
  }
  await applyDerivedStatus(tx, postId);
  return out;
}

export async function scheduleAt(
  scope: ProjectScope,
  postId: string,
  input: unknown,
): Promise<TargetResult<PlannedTime & { warnings: Warning[] }>[]> {
  const id = uuid.parse(postId);
  const opts = selectSchema.extend({ at: atSchema }).parse(input);
  need(scope, { post: ["schedule"] });
  await prepareForScheduling(scope, id, opts.targetIds ? { targetIds: opts.targetIds } : undefined);
  return scope.transaction((tx) => {
    need(tx, { post: ["schedule"] });
    return scheduleExplicit(tx, id, opts.targetIds, "explicit", () => new Date(opts.at));
  });
}

export async function publishNow(
  scope: ProjectScope,
  postId: string,
  input: unknown = {},
): Promise<TargetResult<PlannedTime & { warnings: Warning[] }>[]> {
  const id = uuid.parse(postId);
  const opts = selectSchema.parse(input);
  need(scope, { post: ["schedule"] });
  await prepareForScheduling(scope, id, opts.targetIds ? { targetIds: opts.targetIds } : undefined);
  return scope.transaction((tx) => {
    need(tx, { post: ["schedule"] });
    return scheduleExplicit(tx, id, opts.targetIds, "now", (now) => now);
  });
}

// ---------------------------------------------------------------- single-target actions

export async function cancelTarget(scope: ProjectScope, targetId: string): Promise<void> {
  await withLockedTarget(scope, targetId, { post: ["schedule"] }, async (tx, post, target, now) => {
    if (target.status === "publishing" && hasLiveLease(target, now)) {
      throw new ConflictError("Publishing in progress. Try again in a moment.");
    }
    if (target.status !== "draft" && target.status !== "scheduled" && target.status !== "publishing") {
      throw new ConflictError("This post can no longer be cancelled.");
    }
    await cancelTargetRow(tx, target.id);
    await resetEmptyReview(tx, post.id);
  });
}

const publishedResolution = z.object({ outcome: z.literal("published"), url: externalUrlSchema.optional() });
const resolveSchema = z.union([
  publishedResolution,
  z.object({ outcome: z.literal("not_published"), requeue: z.literal(true), expected: z.iso.datetime().optional() }),
  z.object({ outcome: z.literal("not_published"), requeue: z.literal(false) }),
  z.object({ outcome: z.literal("failed") }).transform(() => ({ outcome: "not_published" as const, requeue: false as const })),
]);

export type ResolveResult =
  | { status: "published" }
  | { status: "scheduled"; scheduledAt: string; localTime: string; slotId: string; changedFromPreview: boolean }
  | { status: "failed"; reason: "not_requeued" | "no_free_slot"; message: string };

const NOT_REQUEUED = "Marked not published by a team member. Retry or schedule it.";
const NO_FREE_SLOT = "Not published — no free posting slot. Retry or schedule it.";

/** FR-007, FR-008, FR-010: confirms what happened to an ambiguous target and, if wanted, requeues it. */
export async function resolveAmbiguous(
  scope: ProjectScope,
  targetId: string,
  input: unknown,
  opts?: { postId?: string },
): Promise<ResolveResult> {
  // A union reports a bad link as one opaque issue; parse the "published" shape alone so the error names `url`.
  const resolution = (input as { outcome?: unknown } | null)?.outcome === "published" ? publishedResolution.parse(input) : resolveSchema.parse(input);
  return withLockedTarget(scope, targetId, { post: ["schedule"] }, async (tx, _post, target, now): Promise<ResolveResult> => {
    if (target.status !== "ambiguous") throw new ConflictError("This post was already resolved.", { reason: "already_resolved" });
    const common = { ...resolverColumns(tx), resolvedAt: now };
    const lost = () => new ConflictError("This post was already resolved.", { reason: "already_resolved" });
    const providerKey = (await tx.accounts.get(target.socialAccountId))?.providerKey ?? "unknown";
    const record = (extra: Pick<Parameters<typeof resolvedEvent>[0], "action" | "url" | "scheduledAt" | "requeue">) =>
      recordTargetEvent(tx, resolvedEvent({ target, providerKey, actor: attemptActor(tx), now, ...extra }));
    if (resolution.outcome === "published") {
      const done = await tx.targets.update(
        target.id,
        { ...common, status: "published", publishedAt: now, externalUrl: resolution.url ?? null, lastError: null },
        { statuses: ["ambiguous"] },
      );
      if (!done) throw lost();
      await tx.attempts.insert({ postTargetId: target.id, step: "user", outcome: "resolved_published", ...attemptActor(tx), at: now });
      await record({ action: "marked_published", url: resolution.url ?? null });
      return { status: "published" };
    }
    if (!resolution.requeue) {
      const done = await tx.targets.update(
        target.id,
        { ...common, status: "failed", lastError: NOT_REQUEUED },
        { statuses: ["ambiguous"] },
      );
      if (!done) throw lost();
      await tx.attempts.insert({ postTargetId: target.id, step: "user", outcome: "resolved_failed", ...attemptActor(tx), at: now });
      await record({ action: "marked_not_published" });
      return { status: "failed", reason: "not_requeued", message: NOT_REQUEUED };
    }
    const g = await gate(tx, target);
    if (!g.ok) throw new ConflictError(g.message, { reason: "cannot_publish" });
    const slot = await allocateNextFree(tx, { id: target.id, accountId: target.socialAccountId }, { after: now });
    if (!slot.ok) {
      const done = await tx.targets.update(
        target.id,
        { ...common, status: "failed", lastError: NO_FREE_SLOT },
        { statuses: ["ambiguous"] },
      );
      if (!done) throw lost();
      await tx.attempts.insert({
        postTargetId: target.id,
        step: "user",
        outcome: "resolved_not_published",
        error: "no_free_slot",
        ...attemptActor(tx),
        at: now,
      });
      await record({ action: "marked_not_published", requeue: "no_free_slot" });
      return { status: "failed", reason: "no_free_slot", message: NO_FREE_SLOT };
    }
    const done = await tx.targets.update(
      target.id,
      {
        ...common,
        status: "scheduled",
        attemptCount: 0,
        lastError: null,
        stepState: null,
        inFlightStep: null,
        inFlightMayPublish: null,
        firstStepAt: null,
        publishStartedAt: null,
        externalId: null,
        externalUrl: null,
      },
      { statuses: ["ambiguous"] },
    );
    if (!done) throw lost();
    await tx.attempts.insert({ postTargetId: target.id, step: "user", outcome: "resolved_not_published", ...attemptActor(tx), at: now });
    await tx.attempts.insert({
      postTargetId: target.id,
      step: "user",
      outcome: "requeued",
      requestSummary: { scheduledAt: slot.planned.scheduledAt, slotId: slot.slotId },
      ...attemptActor(tx),
      at: new Date(now.getTime() + 1),
    });
    await record({ action: "requeued", scheduledAt: slot.instant });
    return {
      status: "scheduled",
      scheduledAt: slot.planned.scheduledAt,
      localTime: slot.planned.localTime,
      slotId: slot.slotId,
      changedFromPreview:
        resolution.expected !== undefined && new Date(resolution.expected).getTime() !== slot.instant.getTime(),
    };
  }, opts);
}

export async function listAttempts(scope: ProjectScope, targetId: string) {
  const id = uuid.parse(targetId);
  need(scope, { post: ["view"] });
  if (!(await scope.targets.get(id))) throw new NotFoundError();
  return (await scope.attempts.listForTarget(id)).reverse();
}
