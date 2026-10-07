import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import * as clock from "../../dal/clock";
import { ConflictError, ForbiddenError, NotFoundError } from "../../dal/errors";
import type { ProjectScope } from "../../dal/scope";
import { getEnv } from "../../env";
import { hasLiveLease } from "../posts/cancel";
import { applyDerivedStatus } from "../posts/status";
import { occurrencesBetween } from "./occurrences";

export interface PlannedTime {
  scheduledAt: string;
  localTime: string;
  slotId: string | null;
}

export interface Warning {
  code: "near_queued_target";
  message: string;
  targetId: string;
  scheduledAt: string;
}

export type AllocationFailure = { ok: false; code: "no_active_slots" | "no_free_occurrence"; message: string };
export type Allocation = { ok: true; instant: Date; slotId: string; planned: PlannedTime } | AllocationFailure;

type Tx = Pick<ProjectScope, "project" | "slots" | "targets" | "accounts">;

export function plannedTime(instant: Date, slotId: string | null, timeZone: string): PlannedTime {
  const zoned = Temporal.Instant.fromEpochMilliseconds(instant.getTime()).toZonedDateTimeISO(timeZone);
  return {
    scheduledAt: instant.toISOString(),
    localTime: `${zoned.toPlainDateTime().toString({ smallestUnit: "minute" })} ${timeZone}`,
    slotId,
  };
}

/** Free occurrences of the account after `after`, nearest first, skipping `held` and `exclude`. */
async function freeCandidates(tx: Tx, accountId: string, after: Date, exclude: readonly Date[], ownOccurrence?: Date | null) {
  const slots = await tx.slots.listActiveForAccount(accountId);
  if (slots.length === 0) return null;
  const horizonMs = getEnv().QUEUE_HORIZON_DAYS * 86_400_000;
  const to = new Date(after.getTime() + horizonMs);
  const held = new Set((await tx.targets.heldInstants(accountId, after, to)).map((d) => d.getTime()));
  // The target's own held occurrence is free to it again; `exclude` is applied after.
  if (ownOccurrence) held.delete(ownOccurrence.getTime());
  for (const d of exclude) held.add(d.getTime());
  const tz = tx.project.timezone;
  return occurrencesBetween(
    slots,
    tz,
    Temporal.Instant.fromEpochMilliseconds(after.getTime()),
    Temporal.Instant.fromEpochMilliseconds(to.getTime()),
  ).filter((o) => !held.has(o.instant.epochMilliseconds));
}

/** The earliest free occurrence, without reserving it (preview, FR-025). */
export async function peekNextFree(tx: Tx, accountId: string, opts: { after: Date; exclude?: readonly Date[]; ownOccurrence?: Date | null }): Promise<Allocation> {
  const account = await tx.accounts.get(accountId);
  const name = account?.displayName ?? "That account";
  const candidates = await freeCandidates(tx, accountId, opts.after, opts.exclude ?? [], opts.ownOccurrence);
  if (candidates === null) {
    return { ok: false, code: "no_active_slots", message: `${name} has no active posting slots. Add or resume a slot first.` };
  }
  const first = candidates[0];
  if (!first) {
    return { ok: false, code: "no_free_occurrence", message: `${name} has no free posting slot in the next ${getEnv().QUEUE_HORIZON_DAYS} days.` };
  }
  const instant = new Date(first.instant.epochMilliseconds);
  return { ok: true, instant, slotId: first.slotId, planned: plannedTime(instant, first.slotId, tx.project.timezone) };
}

/**
 * Takes the earliest free occurrence for the target. Each candidate is tried in a savepoint; a unique
 * violation means another transaction got there first, so the walk moves on (research D3).
 */
export async function allocateNextFree(
  tx: Tx,
  target: { id: string; accountId: string },
  opts: { after: Date; exclude?: readonly Date[]; ownOccurrence?: Date | null },
): Promise<Allocation> {
  const account = await tx.accounts.get(target.accountId);
  const name = account?.displayName ?? "That account";
  const candidates = await freeCandidates(tx, target.accountId, opts.after, opts.exclude ?? [], opts.ownOccurrence);
  if (candidates === null) {
    return { ok: false, code: "no_active_slots", message: `${name} has no active posting slots. Add or resume a slot first.` };
  }
  for (const c of candidates) {
    const instant = new Date(c.instant.epochMilliseconds);
    if (await tx.targets.tryHoldOccurrence(target.id, instant, c.slotId)) {
      return { ok: true, instant, slotId: c.slotId, planned: plannedTime(instant, c.slotId, tx.project.timezone) };
    }
  }
  return { ok: false, code: "no_free_occurrence", message: `${name} has no free posting slot in the next ${getEnv().QUEUE_HORIZON_DAYS} days.` };
}

/** Queued targets of the account within `EXPLICIT_TIME_WARNING_MINUTES` of `instant`. */
export async function nearQueuedWarnings(
  tx: Pick<ProjectScope, "targets">,
  accountId: string,
  instant: Date,
  excludeTargetId?: string,
): Promise<Warning[]> {
  const windowMs = getEnv().EXPLICIT_TIME_WARNING_MINUTES * 60_000;
  if (windowMs <= 0) return [];
  const near = await tx.targets.nearScheduled(accountId, instant, windowMs);
  return near
    .filter((t) => t.id !== excludeTargetId && t.scheduledAt)
    .map((t) => ({
      code: "near_queued_target" as const,
      message: `Another post is already queued within ${getEnv().EXPLICIT_TIME_WARNING_MINUTES} minutes of that time on this account.`,
      targetId: t.id,
      scheduledAt: t.scheduledAt!.toISOString(),
    }));
}

// ---------------------------------------------------------------- queue actions (D10)

const uuid = z.uuid();
const MAX_RANGE_DAYS = 92;

function need(scope: Pick<ProjectScope, "can">, request: Parameters<ProjectScope["can"]>[0]): void {
  if (!scope.can(request)) throw new ForbiddenError();
}

type ActionTx = Pick<ProjectScope, "project" | "slots" | "targets" | "accounts" | "posts" | "can">;

/** Locks the posts of the given targets in id order (the contract's locking order), before any target lock. */
async function lockPostsOf(tx: ActionTx, targets: readonly { postId: string }[]): Promise<void> {
  for (const postId of [...new Set(targets.map((t) => t.postId))].sort()) {
    if (!(await tx.posts.lockForUpdate(postId))) throw new NotFoundError();
    await tx.targets.lockForPost(postId);
  }
}

/** Takes the earliest free occurrence after now for a scheduled target, releasing the one it held. */
export async function moveToNextFreeSlot(scope: ProjectScope, targetId: string): Promise<PlannedTime> {
  const id = uuid.parse(targetId);
  need(scope, { post: ["schedule"] });
  return scope.transaction(async (tx) => {
    need(tx, { post: ["schedule"] });
    const first = await tx.targets.get(id);
    if (!first) throw new NotFoundError();
    await lockPostsOf(tx, [first]);
    const target = await tx.targets.get(id);
    if (!target) throw new NotFoundError();
    if (target.status !== "scheduled") throw new ConflictError("Only a scheduled post can be moved.");
    const exclude = [target.slotOccurrenceAt, target.scheduledAt].filter((d): d is Date => d !== null);
    const result = await allocateNextFree(tx, { id, accountId: target.socialAccountId }, { after: await clock.now(), exclude });
    if (!result.ok) throw new ConflictError(result.message);
    await applyDerivedStatus(tx, target.postId);
    return result.planned;
  });
}

/** Exchanges the occurrences of two queued targets of one account, atomically. */
export async function swapQueuedTargets(scope: ProjectScope, targetIdA: string, targetIdB: string): Promise<void> {
  const idA = uuid.parse(targetIdA);
  const idB = uuid.parse(targetIdB);
  need(scope, { post: ["schedule"] });
  if (idA === idB) throw new ConflictError("Pick two different posts to swap.");
  await scope.transaction(async (tx) => {
    need(tx, { post: ["schedule"] });
    const [ra, rb] = await Promise.all([tx.targets.get(idA), tx.targets.get(idB)]);
    if (!ra || !rb) throw new NotFoundError();
    await lockPostsOf(tx, [ra, rb]);
    const [a, b] = await Promise.all([tx.targets.get(idA), tx.targets.get(idB)]);
    if (!a || !b) throw new NotFoundError();
    if (a.socialAccountId !== b.socialAccountId) throw new ConflictError("Posts can only be swapped within the same account.");
    const queued = (t: typeof a) => t.status === "scheduled" && t.scheduleKind === "slot" && t.slotOccurrenceAt !== null && t.slotId !== null;
    if (!queued(a) || !queued(b)) throw new ConflictError("Only queued posts can be swapped.");
    const place = (t: typeof a) => ({ slotOccurrenceAt: t.slotOccurrenceAt, slotId: t.slotId, scheduledAt: t.slotOccurrenceAt, nextAttemptAt: t.slotOccurrenceAt });
    const [pa, pb] = [place(a), place(b)];
    // A lets go first, so B can take its instant; then A takes B's old one. All inside this transaction.
    await tx.targets.releaseOccurrence(a.id);
    if (!(await tx.targets.update(b.id, pa, { statuses: ["scheduled"] }))) throw new ConflictError("A post changed while swapping. Try again.");
    if (!(await tx.targets.update(a.id, pb, { statuses: ["scheduled"] }))) throw new ConflictError("A post changed while swapping. Try again.");
  });
}

export interface PullMove {
  targetId: string;
  from: string;
  to: string;
  fromLocal: string;
  toLocal: string;
  /** Only set when `expected` was given: the move is not what the preview showed. */
  differsFromPreview?: boolean;
}

export interface PullExpected {
  targetId: string;
  to: string;
}

async function pullForwardBody(tx: ActionTx, id: string): Promise<PullMove[]> {
  if (!(await tx.accounts.get(id))) throw new NotFoundError();
  const tz = tx.project.timezone;
  const now = await clock.now();
  // Posts first (by id), then the targets in scheduled_at order.
  await lockPostsOf(tx, await tx.targets.listOpenForAccount(id));
  const queued = await tx.targets.queuedForAccount(id, now);
  for (const t of queued) await tx.targets.releaseOccurrence(t.id);
  const moved: PullMove[] = [];
  let after = now;
  for (const t of queued) {
    const from = t.slotOccurrenceAt!;
    const r = await allocateNextFree(tx, { id: t.id, accountId: id }, { after });
    if (r.ok && r.instant.getTime() > from.getTime()) {
      // Only active slots are candidates, so a target on a paused or deleted slot can be
      // offered something later. Never move later: keep the occurrence it held (F19).
      await tx.targets.releaseOccurrence(t.id);
      await tx.targets.tryHoldOccurrence(t.id, from, t.slotId as string);
      after = from;
    } else if (r.ok) {
      after = r.instant;
      if (r.instant.getTime() !== from.getTime()) {
        moved.push({
          targetId: t.id,
          from: from.toISOString(),
          to: r.instant.toISOString(),
          fromLocal: plannedTime(from, t.slotId, tz).localTime,
          toLocal: r.planned.localTime,
        });
      }
    } else {
      // Beyond the search horizon: it keeps what it had.
      await tx.targets.tryHoldOccurrence(t.id, from, t.slotId!);
      after = from;
    }
  }
  return moved;
}

/** Closes gaps: every queued target takes the earliest free occurrence, in order, never later than it held. */
export async function pullQueueForward(
  scope: ProjectScope,
  accountId: string,
  opts: { expected?: readonly PullExpected[] } = {},
): Promise<{ moved: PullMove[] }> {
  const id = uuid.parse(accountId);
  need(scope, { post: ["schedule"] });
  const moved = await scope.transaction(async (tx) => {
    need(tx, { post: ["schedule"] });
    return pullForwardBody(tx, id);
  });
  const expected = opts.expected;
  if (!expected) return { moved };
  const byTarget = new Map(expected.map((e) => [e.targetId, e.to]));
  return { moved: moved.map((m) => ({ ...m, differsFromPreview: byTarget.get(m.targetId) !== m.to })) };
}

class PreviewRollback extends Error {
  constructor(readonly moved: PullMove[]) {
    super("preview rollback");
  }
}

/** The same body as `pullQueueForward`, rolled back: what would move, with nothing changed (D13). */
export async function previewPullQueueForward(scope: ProjectScope, accountId: string): Promise<{ moved: PullMove[] }> {
  const id = uuid.parse(accountId);
  need(scope, { post: ["schedule"] });
  try {
    await scope.transaction(async (tx) => {
      need(tx, { post: ["schedule"] });
      throw new PreviewRollback(await pullForwardBody(tx, id));
    });
  } catch (error) {
    if (error instanceof PreviewRollback) return { moved: error.moved };
    throw error;
  }
  throw new Error("unreachable");
}

export interface QueuedItem {
  targetId: string;
  postId: string;
  scheduledAt: string;
  localTime: string;
  excerpt: string;
}

/** Queued (slot) future targets of the account with the post excerpt: the "Swap with…" picker. */
export async function listQueuedForAccount(scope: ProjectScope, accountId: string): Promise<QueuedItem[]> {
  const id = uuid.parse(accountId);
  need(scope, { post: ["view"] });
  if (!(await scope.accounts.get(id))) throw new NotFoundError();
  const now = await clock.now();
  const to = new Date(now.getTime() + getEnv().QUEUE_HORIZON_DAYS * 86_400_000 * 2);
  const rows = await scope.targets.listInRange(now, to, id);
  return rows
    .filter(({ target: t }) => t.status === "scheduled" && t.scheduleKind === "slot" && t.slotOccurrenceAt !== null && t.slotOccurrenceAt > now)
    .map(({ target: t, baseText }) => ({
      targetId: t.id,
      postId: t.postId,
      scheduledAt: t.slotOccurrenceAt!.toISOString(),
      localTime: plannedTime(t.slotOccurrenceAt!, t.slotId, scope.project.timezone).localTime,
      excerpt: Array.from(baseText).slice(0, 140).join(""),
    }));
}

const moveSchema = z.object({ targetId: uuid, slotId: uuid, scheduledAt: z.coerce.date() });

/** Moves a scheduled target into a specific empty occurrence; the unique index decides races (D12). */
export async function moveTargetToOccurrence(scope: ProjectScope, input: unknown): Promise<PlannedTime> {
  const { targetId, slotId, scheduledAt } = moveSchema.parse(input);
  need(scope, { post: ["schedule"] });
  return scope.transaction(async (tx) => {
    need(tx, { post: ["schedule"] });
    const first = await tx.targets.get(targetId);
    if (!first) throw new NotFoundError();
    await lockPostsOf(tx, [first]);
    const target = await tx.targets.get(targetId);
    if (!target) throw new NotFoundError();
    const now = await clock.now();
    if (target.status !== "scheduled") throw new ConflictError("Only a scheduled post can be moved.");
    if (hasLiveLease(target, now)) throw new ConflictError("Publishing in progress. Try again in a moment.");
    const slot = await tx.slots.get(slotId);
    if (!slot || slot.socialAccountId !== target.socialAccountId) throw new ConflictError("That slot belongs to another account.");
    if (slot.paused) throw new ConflictError("That slot is paused.");
    if (scheduledAt.getTime() <= now.getTime()) throw new ConflictError("That time has passed.");
    const horizon = now.getTime() + getEnv().QUEUE_HORIZON_DAYS * 86_400_000;
    const at = Temporal.Instant.fromEpochMilliseconds(scheduledAt.getTime());
    const isOccurrence =
      scheduledAt.getTime() <= horizon &&
      occurrencesBetween([slot], tx.project.timezone, at.subtract({ minutes: 1 }), at).some((o) => o.instant.epochMilliseconds === scheduledAt.getTime());
    if (!isOccurrence) throw new ConflictError("That is not one of this slot's times.");
    await tx.targets.releaseOccurrence(target.id);
    if (!(await tx.targets.tryHoldOccurrence(target.id, scheduledAt, slot.id))) throw new ConflictError("That slot was just taken.");
    await tx.targets.update(target.id, { attemptCount: 0, stepState: null, firstStepAt: null, publishStartedAt: null, lastError: null }, { statuses: ["scheduled"] });
    await applyDerivedStatus(tx, target.postId);
    return plannedTime(scheduledAt, slot.id, tx.project.timezone);
  });
}

export interface EmptySlot {
  accountId: string;
  slotId: string;
  scheduledAt: string;
  localTime: string;
}

const emptySlotsSchema = z.object({ accountId: uuid.optional(), from: z.coerce.date(), to: z.coerce.date() });

/** Free, unpaused occurrences in `[max(from, now), to]`, per account, in time order. */
export async function listEmptySlots(scope: ProjectScope, input: unknown): Promise<EmptySlot[]> {
  const opts = emptySlotsSchema.parse(input);
  need(scope, { slot: ["view"] });
  const now = await clock.now();
  const from = opts.from.getTime() > now.getTime() ? opts.from : now;
  if (opts.to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000) {
    throw new z.ZodError([{ code: "custom", path: ["to"], message: `Pick a range of ${MAX_RANGE_DAYS} days or fewer.` }]);
  }
  const accountList = opts.accountId ? [await scope.accounts.get(opts.accountId)] : await scope.accounts.list();
  const out: EmptySlot[] = [];
  const tz = scope.project.timezone;
  for (const account of accountList) {
    if (!account) throw new NotFoundError();
    const slots = await scope.slots.listActiveForAccount(account.id);
    if (slots.length === 0 || opts.to.getTime() <= from.getTime()) continue;
    const held = new Set((await scope.targets.heldInstants(account.id, from, opts.to)).map((d) => d.getTime()));
    const found = occurrencesBetween(
      slots,
      tz,
      Temporal.Instant.fromEpochMilliseconds(from.getTime()),
      Temporal.Instant.fromEpochMilliseconds(opts.to.getTime()),
    ).filter((o) => !held.has(o.instant.epochMilliseconds));
    for (const o of found) {
      out.push({
        accountId: account.id,
        slotId: o.slotId,
        scheduledAt: new Date(o.instant.epochMilliseconds).toISOString(),
        localTime: plannedTime(new Date(o.instant.epochMilliseconds), o.slotId, tz).localTime,
      });
    }
  }
  return out.sort((x, y) => x.scheduledAt.localeCompare(y.scheduledAt) || x.accountId.localeCompare(y.accountId));
}

export const UPCOMING_MAX_DAYS = 60;

export interface UpcomingOccurrence {
  accountId: string;
  slotId: string;
  scheduledAt: string;
  localTime: string;
  free: boolean;
  postId: string | null;
  targetId: string | null;
}

const upcomingSchema = z.object({
  accountId: uuid.optional(),
  from: z.coerce.date().optional(),
  days: z.number().int().min(1).max(UPCOMING_MAX_DAYS).default(14),
});

/** Free and taken occurrences of active slots from `max(from, now)` for `days` days, in time order. */
export async function listUpcomingOccurrences(scope: ProjectScope, input: unknown = {}): Promise<UpcomingOccurrence[]> {
  const opts = upcomingSchema.parse(input);
  need(scope, { slot: ["view"] });
  const now = await clock.now();
  const from = opts.from && opts.from.getTime() > now.getTime() ? opts.from : now;
  const to = new Date(from.getTime() + opts.days * 86_400_000);
  const accountList = opts.accountId ? [await scope.accounts.get(opts.accountId)] : await scope.accounts.list();
  const tz = scope.project.timezone;
  const out: UpcomingOccurrence[] = [];
  for (const account of accountList) {
    if (!account) throw new NotFoundError();
    const slots = await scope.slots.listActiveForAccount(account.id);
    if (slots.length === 0) continue;
    const held = new Map((await scope.targets.heldOccurrences(account.id, from, to)).map((h) => [h.at.getTime(), h]));
    const found = occurrencesBetween(
      slots,
      tz,
      Temporal.Instant.fromEpochMilliseconds(from.getTime()),
      Temporal.Instant.fromEpochMilliseconds(to.getTime()),
    );
    for (const o of found) {
      const at = new Date(o.instant.epochMilliseconds);
      const h = held.get(at.getTime());
      out.push({
        accountId: account.id,
        slotId: o.slotId,
        scheduledAt: at.toISOString(),
        localTime: plannedTime(at, o.slotId, tz).localTime,
        free: !h,
        postId: h?.postId ?? null,
        targetId: h?.targetId ?? null,
      });
    }
  }
  return out.sort((x, y) => x.scheduledAt.localeCompare(y.scheduledAt) || x.accountId.localeCompare(y.accountId));
}
