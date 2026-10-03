import { z } from "zod";
import { findProvider } from "@/providers/registry";
import type { ValidationIssue } from "@/providers/types";
import { atSchema, baseTextSchema, POST_MEDIA_MAX, postInputSchema, postTargetInputSchema } from "@/lib/validation/scheduling";
import type { AccountRecord } from "../../dal/accounts";
import * as clock from "../../dal/clock";
import { ConflictError, ForbiddenError, NotFoundError, ValidationIssuesError } from "../../dal/errors";
import type { PostRecord } from "../../dal/posts";
import type { ProjectScope } from "../../dal/scope";
import type { TargetRecord } from "../../dal/targets";
import { allocateNextFree, nearQueuedWarnings, peekNextFree, plannedTime, type PlannedTime, type Warning } from "../queue";
import { cancelTargetRow, hasLiveLease, resetEmptyReview } from "./cancel";
import { effectiveContent } from "./content";
import { applyDerivedStatus } from "./status";

export { applyDerivedStatus, derivePostStatus } from "./status";

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
const REVIEW = z.enum(["draft", "needs_review", "approved"]);
const STARTED: readonly TargetRecord["status"][] = ["publishing", "published", "ambiguous"];

const createSchema = postInputSchema.extend({
  origin: z.enum(["manual", "generated", "api"]).optional(),
  generationMetadata: z.record(z.string(), z.unknown()).nullish(),
  reviewState: REVIEW.optional(),
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

function need(scope: ProjectScope, request: Parameters<ProjectScope["can"]>[0]): void {
  if (!scope.can(request)) throw new ForbiddenError();
}

async function lockPost(tx: Tx, postId: string): Promise<PostRecord> {
  const post = await tx.posts.lockForUpdate(postId);
  if (!post) throw new NotFoundError();
  // Post lock first, then the target rows: waits out a scheduler claim so later reads see its lease.
  await tx.targets.lockForPost(postId);
  return post;
}

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

/** Provider validation of the effective content; `null` when the account's provider is unavailable. */
async function issuesFor(tx: Tx, target: TargetRecord, account: AccountRecord): Promise<ValidationIssue[] | null> {
  const provider = findProvider(account.providerKey);
  if (!provider) return null;
  const content = await effectiveContent(tx, target);
  if (!content) return null;
  return provider.validate(content, provider.capabilities);
}

const errorsOf = (issues: ValidationIssue[]) => issues.filter((i) => i.severity === "error");

type Gate =
  | { ok: true; account: AccountRecord; issues: ValidationIssue[] }
  | { ok: false; code: TargetFailureCode; message: string; issues?: ValidationIssue[] };

/** Account usable, provider registered, validation clean (FR-024–FR-028). */
async function gate(tx: Tx, target: TargetRecord): Promise<Gate> {
  const account = await tx.accounts.get(target.socialAccountId);
  if (!account) return { ok: false, code: "account_unavailable", message: "That account has been removed." };
  if (account.status !== "active") {
    return { ok: false, code: "account_unavailable", message: `${account.displayName} needs to be reconnected.` };
  }
  const issues = await issuesFor(tx, target, account);
  if (issues === null) {
    return { ok: false, code: "account_unavailable", message: `The provider for ${account.displayName} is no longer available.` };
  }
  const errors = errorsOf(issues);
  if (errors.length > 0) {
    return { ok: false, code: "validation", message: errors[0]!.message, issues };
  }
  return { ok: true, account, issues };
}

function fail(t: TargetRecord, code: TargetFailureCode, message: string, issues?: ValidationIssue[]): TargetResult<never> {
  return { targetId: t.id, accountId: t.socialAccountId, ok: false, code, message, ...(issues ? { issues } : {}) };
}

/** Queueable: draft or cancelled, on a post that is not awaiting review. */
function queueableGate(post: PostRecord, t: TargetRecord): TargetResult<never> | null {
  if (t.status !== "draft" && t.status !== "cancelled") {
    return fail(t, "not_queueable", "This post is already scheduled or has been published.");
  }
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
    if ((await tx.media.getMany(parsed.mediaIds)).length !== new Set(parsed.mediaIds).size) throw new NotFoundError();
    const post = await tx.posts.insert({
      baseText: parsed.baseText,
      createdByUserId: tx.membership.userId,
      ...(parsed.origin ? { origin: parsed.origin } : {}),
      ...(parsed.generationMetadata !== undefined ? { generationMetadata: parsed.generationMetadata } : {}),
      ...(parsed.reviewState ? { reviewState: parsed.reviewState } : {}),
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
      if ((await tx.media.getMany(patch.mediaIds)).length !== new Set(patch.mediaIds).size) throw new NotFoundError();
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

export async function setReviewState(scope: ProjectScope, postId: string, state: unknown): Promise<void> {
  const id = uuid.parse(postId);
  const reviewState = REVIEW.parse(state);
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
  return scope.transaction(async (tx) => {
    need(tx, { post: ["schedule"] });
    const post = await lockPost(tx, id);
    const now = await clock.now();
    const all = await tx.targets.listForPost(id);
    const chosen = pickTargets(all, opts.targetIds).filter((t) => opts.targetIds || t.status === "draft" || t.status === "cancelled");
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
  });
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
        scheduleKind: kind,
        scheduledAt: when,
        nextAttemptAt: when,
        slotOccurrenceAt: null,
        slotId: null,
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
  return scope.transaction((tx) => {
    need(tx, { post: ["schedule"] });
    return scheduleExplicit(tx, id, opts.targetIds, "now", (now) => now);
  });
}

// ---------------------------------------------------------------- single-target actions

/** Reads the target to find its post, locks the post, then re-reads the target under the lock. */
async function withLockedTarget<T>(
  scope: ProjectScope,
  targetId: string,
  permission: Parameters<ProjectScope["can"]>[0],
  fn: (tx: Tx, post: PostRecord, target: TargetRecord, now: Date) => Promise<T>,
): Promise<T> {
  const id = uuid.parse(targetId);
  need(scope, permission);
  return scope.transaction(async (tx) => {
    need(tx, permission);
    const first = await tx.targets.get(id);
    if (!first) throw new NotFoundError();
    const post = await lockPost(tx, first.postId);
    const target = await tx.targets.get(id);
    if (!target) throw new NotFoundError();
    const result = await fn(tx, post, target, await clock.now());
    await applyDerivedStatus(tx, post.id);
    return result;
  });
}

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

export async function retryTarget(scope: ProjectScope, targetId: string): Promise<void> {
  await withLockedTarget(scope, targetId, { post: ["schedule"] }, async (tx, _post, target, now) => {
    if (target.status !== "failed") throw new ConflictError("Only a failed post can be retried.");
    const account = await tx.accounts.get(target.socialAccountId);
    if (!account || account.status !== "active" || !findProvider(account.providerKey)) {
      throw new ConflictError("Reconnect the account before retrying.");
    }
    await tx.targets.update(
      target.id,
      { status: "scheduled", attemptCount: 0, stepState: null, firstStepAt: null, publishStartedAt: null, nextAttemptAt: now, lastError: null },
      { statuses: ["failed"] },
    );
    await tx.attempts.insert({ postTargetId: target.id, step: "user", outcome: "retry_requested", actorUserId: tx.membership.userId, at: now });
  });
}

const resolveSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("published"), url: z.url().optional() }),
  z.object({ outcome: z.literal("failed") }),
]);

export async function resolveAmbiguous(scope: ProjectScope, targetId: string, input: unknown): Promise<void> {
  const resolution = resolveSchema.parse(input);
  await withLockedTarget(scope, targetId, { post: ["schedule"] }, async (tx, _post, target, now) => {
    if (target.status !== "ambiguous") throw new ConflictError("Only an unconfirmed post can be resolved.");
    const common = { resolvedByUserId: tx.membership.userId, resolvedAt: now };
    if (resolution.outcome === "published") {
      await tx.targets.update(
        target.id,
        { ...common, status: "published", publishedAt: now, externalUrl: resolution.url ?? null, lastError: null },
        { statuses: ["ambiguous"] },
      );
    } else {
      await tx.targets.update(
        target.id,
        { ...common, status: "failed", lastError: "Marked failed by a team member." },
        { statuses: ["ambiguous"] },
      );
    }
    await tx.attempts.insert({
      postTargetId: target.id,
      step: "user",
      outcome: resolution.outcome === "published" ? "resolved_published" : "resolved_failed",
      actorUserId: tx.membership.userId,
      at: now,
    });
  });
}

export async function listAttempts(scope: ProjectScope, targetId: string) {
  const id = uuid.parse(targetId);
  need(scope, { post: ["view"] });
  if (!(await scope.targets.get(id))) throw new NotFoundError();
  return (await scope.attempts.listForTarget(id)).reverse();
}
