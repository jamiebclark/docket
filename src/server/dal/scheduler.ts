import { and, asc, count, eq, gt, inArray, isNotNull, isNull, lt, lte, ne, notInArray, or, sql } from "drizzle-orm";
import { getDb, type Database } from "../db/client";
import { allowanceUses, mediaAssets, postMedia, postTargets, posts, socialAccounts, type SocialAccountRow } from "../db/schema";
import { resolvePostType } from "../../providers/post-type";
import type { PostType, SocialProvider, StepContent } from "../../providers/types";
import { videoRecipeKey } from "../media/hash";
import { itemOf, planVideoFor } from "../services/media-variants";
import { createPostsRepo } from "./posts";
import { createVideoVersionsRepo } from "./video-versions";
import { createActivityRepo, type NewActivityEvent } from "./activity";
import { createAttemptsRepo, type AttemptEntry } from "./attempts";
import { createSchedulingRepos, crossProject } from "./scope";
import type { TargetPatch, TargetRecord } from "./targets";

/**
 * The only DAL surface the scheduler uses. The claim queries span projects, so each runs inside
 * `crossProject` with a fixed reason; everything after a claim goes through `forSchedulerProject`.
 */

export type ClaimedAccount = Omit<SocialAccountRow, "credentialsEncrypted">;

/** What the engine decided for one claimed target. The DAL applies it inside the claim transaction. */
export interface ClaimDecision {
  /** Column changes for the target (status, lease, in-flight step, attempt count …). */
  patch: TargetPatch;
  /** Attempt rows to append in the same transaction. */
  attempts?: Omit<AttemptEntry, "postTargetId" | "at">[];
  /** Activity event to append in the same transaction, right after the attempts. */
  activity?: NewActivityEvent;
}

/** What the claim-time video gate found for a target's post (contracts/video-publishing.md). */
export type VideoGate =
  | { kind: "none" }
  | { kind: "ready" }
  | { kind: "waiting"; platform: string }
  | { kind: "failed"; reason: string; platform: string };

export interface ClaimContext {
  now: Date;
  /** Targets of the account whose `publish_started_at` is later than `since` (limit counting, D8). */
  startedSince(accountId: string, since: Date, excludeTargetId?: string): Promise<Date[]>;
  /**
   * What `stepFor` may look at: the target's effective text (`override_text ?? base_text`) and its post's media count,
   * pinned by `project_id`. `null` when the post row is gone.
   */
  contentShape(target: { id: string; projectId: string; postId: string }): Promise<ContentShape | null>;
  /**
   * Whether every video on the post that needs adapting for this provider has a ready version. Queues a missing row; makes
   * no storage, tool or provider call. A video that needs no adapting (or none at all) is `none`.
   */
  videoGate(
    target: { id: string; projectId: string; postId: string; chosenPostType: PostType | null },
    provider: SocialProvider,
  ): Promise<VideoGate>;
  /** Creation-allowance reservations for the account since `since`, oldest first. */
  allowanceUsed(accountId: string, projectId: string, since: Date): Promise<{ at: Date; units: number }[]>;
  /** Records a reservation stamped with the claim's clock; commits with the lease patch. */
  reserveAllowance(input: { accountId: string; projectId: string; targetId: string; units: number }): Promise<void>;
}

export interface ClaimDueOptions {
  now: Date;
  /** Max rows to claim in this round. */
  limit: number;
  /** Ids already handled this tick (each tick advances a target at most once). */
  excludeIds: readonly string[];
  /** Per target: return a decision, or `null` to leave it untouched. */
  decide(target: TargetRecord, account: ClaimedAccount, ctx: ClaimContext): Promise<ClaimDecision | null>;
}

/** `StepContent` plus the target's stored post type choice. */
export type ContentShape = StepContent & { chosenPostType: PostType | null };

export interface ClaimedTarget {
  target: TargetRecord;
  account: ClaimedAccount;
  /** The decision that was applied; `null` when the target was left untouched. */
  decision: ClaimDecision | null;
}

function strip(row: SocialAccountRow): ClaimedAccount {
  const { credentialsEncrypted: _c, ...rest } = row;
  void _c;
  return rest;
}

/**
 * Claims due targets: `FOR UPDATE SKIP LOCKED` on targets, then `FOR NO KEY UPDATE SKIP LOCKED` on
 * their accounts. Never waits, takes no post lock. Targets whose account is locked elsewhere are
 * left untouched (not returned, not excluded).
 */
export function claimDueTargets(opts: ClaimDueOptions): Promise<ClaimedTarget[]> {
  return crossProject("scheduler: claim due targets", async () => {
    if (opts.limit <= 0) return [];
    return getDb().transaction(async (tx) => {
      const exec = tx as unknown as Database;
      const rows = await exec
        .select()
        .from(postTargets)
        .where(
          and(
            inArray(postTargets.status, ["scheduled", "publishing"]),
            lte(postTargets.nextAttemptAt, opts.now),
            or(isNull(postTargets.leaseUntil), lte(postTargets.leaseUntil, opts.now)),
            opts.excludeIds.length > 0 ? notInArray(postTargets.id, [...opts.excludeIds]) : undefined,
          ),
        )
        .orderBy(asc(postTargets.nextAttemptAt), asc(postTargets.id))
        .limit(opts.limit)
        .for("update", { skipLocked: true });
      if (rows.length === 0) return [];

      const accountIds = [...new Set(rows.map((r) => r.socialAccountId))].sort();
      const accounts = await exec
        .select()
        .from(socialAccounts)
        .where(inArray(socialAccounts.id, accountIds))
        .orderBy(asc(socialAccounts.id))
        .for("no key update", { skipLocked: true });
      const byId = new Map(accounts.map((a) => [a.id, strip(a)]));

      const ctx: ClaimContext = {
        now: opts.now,
        async startedSince(accountId, since, excludeTargetId) {
          const started = await exec
            .select({ at: postTargets.publishStartedAt })
            .from(postTargets)
            .where(
              and(
                eq(postTargets.socialAccountId, accountId),
                isNotNull(postTargets.publishStartedAt),
                gt(postTargets.publishStartedAt, since),
                excludeTargetId ? ne(postTargets.id, excludeTargetId) : undefined,
              ),
            );
          return started.map((s) => s.at!);
        },
        async contentShape(target) {
          const [head] = await exec
            .select({
              overrideText: postTargets.overrideText,
              baseText: posts.baseText,
              chosenPostType: postTargets.chosenPostType,
            })
            .from(postTargets)
            .innerJoin(posts, and(eq(posts.id, postTargets.postId), eq(posts.projectId, postTargets.projectId)))
            .where(and(eq(postTargets.projectId, target.projectId), eq(postTargets.id, target.id)))
            .limit(1);
          if (!head) return null;
          const items = await exec
            .select({ kind: mediaAssets.kind })
            .from(postMedia)
            .innerJoin(mediaAssets, and(eq(mediaAssets.id, postMedia.mediaAssetId), eq(mediaAssets.projectId, postMedia.projectId)))
            .where(and(eq(postMedia.projectId, target.projectId), eq(postMedia.postId, target.postId)))
            .orderBy(asc(postMedia.position));
          const kinds = items.map((i) => (i.kind === "video" ? ("video" as const) : ("image" as const)));
          return {
            text: head.overrideText ?? head.baseText,
            mediaCount: kinds.length,
            videoCount: kinds.filter((k) => k === "video").length,
            kinds,
            chosenPostType: head.chosenPostType,
          };
        },
        async videoGate(target, provider) {
          const assets = await exec
            .select({ asset: mediaAssets })
            .from(postMedia)
            .innerJoin(mediaAssets, and(eq(mediaAssets.id, postMedia.mediaAssetId), eq(mediaAssets.projectId, postMedia.projectId)))
            .where(and(eq(postMedia.projectId, target.projectId), eq(postMedia.postId, target.postId), isNull(mediaAssets.deletedAt)))
            .orderBy(asc(postMedia.position))
            .then((rows) => rows.map((r) => r.asset));
          if (!assets.some((a) => a.kind === "video")) return { kind: "none" };
          const postType = resolvePostType(provider.capabilities, assets.map((a) => itemOf(a)), target.chosenPostType);
          const edits = await createPostsRepo(exec, target.projectId).listVideoEdits(target.postId);
          const needed: { assetId: string; key: string; plan: Extract<NonNullable<ReturnType<typeof planVideoFor>>, { kind: "derive" }> }[] = [];
          let checking = false;
          for (const [i, asset] of assets.entries()) {
            const plan = planVideoFor(asset, provider.capabilities, postType, i, provider.displayName, edits.get(asset.id));
            if (plan?.kind === "checking") checking = true;
            if (plan?.kind === "derive") needed.push({ assetId: asset.id, key: videoRecipeKey("full", plan.recipe), plan });
          }
          const platform = provider.displayName;
          if (needed.length === 0) return checking ? { kind: "waiting", platform } : { kind: "none" };
          const repo = createVideoVersionsRepo(exec, target.projectId);
          const rows = await repo.getByKeys(needed.map((n) => ({ assetId: n.assetId, kind: "full" as const, key: n.key })));
          const rowOf = (n: { assetId: string; key: string }) => rows.find((r) => r.mediaAssetId === n.assetId && r.kind === "full" && r.key === n.key);
          const missing = needed.filter((n) => !rowOf(n));
          if (missing.length > 0) {
            await repo.ensureQueued(
              missing.map((n) => ({ assetId: n.assetId, kind: "full" as const, key: n.key, recipe: n.plan.recipe, steps: n.plan.steps, dueAt: opts.now })),
            );
          }
          const failed = needed.map(rowOf).find((r) => r?.state === "failed");
          if (failed) return { kind: "failed", reason: failed.error ?? "Docket could not adapt the video.", platform };
          if (checking || missing.length > 0 || needed.some((n) => rowOf(n)?.state !== "ready")) return { kind: "waiting", platform };
          return { kind: "ready" };
        },
        async allowanceUsed(accountId, projectId, since) {
          const used = await exec
            .select({ at: allowanceUses.createdAt, units: allowanceUses.units })
            .from(allowanceUses)
            .where(
              and(
                eq(allowanceUses.projectId, projectId),
                eq(allowanceUses.socialAccountId, accountId),
                gt(allowanceUses.createdAt, since),
              ),
            )
            .orderBy(asc(allowanceUses.createdAt), asc(allowanceUses.id));
          return used;
        },
        async reserveAllowance({ accountId, projectId, targetId, units }) {
          await exec
            .insert(allowanceUses)
            .values({ projectId, socialAccountId: accountId, postTargetId: targetId, units, createdAt: opts.now });
        },
      };

      const claimed: ClaimedTarget[] = [];
      for (const row of rows) {
        const account = byId.get(row.socialAccountId);
        if (!account) continue; // account locked by someone else: leave the target for later
        const decision = await opts.decide(row, account, ctx);
        if (!decision) {
          claimed.push({ target: row, account, decision: null });
          continue;
        }
        const [updated] = await exec
          .update(postTargets)
          .set(decision.patch)
          .where(and(eq(postTargets.id, row.id), eq(postTargets.projectId, row.projectId)))
          .returning();
        const attempts = createAttemptsRepo(exec, row.projectId);
        for (const attempt of decision.attempts ?? []) {
          await attempts.insert({ ...attempt, postTargetId: row.id, at: opts.now });
        }
        if (decision.activity) await createActivityRepo(exec, row.projectId).insert(decision.activity);
        claimed.push({ target: updated ?? row, account, decision });
      }
      return claimed;
    });
  });
}

export interface ClaimRefreshOptions {
  now: Date;
  refreshWindowMs: number;
  limit: number;
  leaseMs: number;
  /** Provider keys that define `refreshCredentials`. */
  providerKeys: readonly string[];
  /** Lease token written to `refresh_lease_owner`. */
  token: string;
}

/** Claims accounts whose credentials are due for refresh, setting a refresh lease. */
export function claimRefreshAccounts(opts: ClaimRefreshOptions): Promise<ClaimedAccount[]> {
  return crossProject("scheduler: claim token refresh", async () => {
    if (opts.limit <= 0 || opts.providerKeys.length === 0) return [];
    return getDb().transaction(async (tx) => {
      const exec = tx as unknown as Database;
      const rows = await exec
        .select()
        .from(socialAccounts)
        .where(
          and(
            eq(socialAccounts.status, "active"),
            isNull(socialAccounts.removedAt),
            isNotNull(socialAccounts.credentialsEncrypted),
            lte(socialAccounts.credentialsExpiresAt, new Date(opts.now.getTime() + opts.refreshWindowMs)),
            inArray(socialAccounts.providerKey, [...opts.providerKeys]),
            or(isNull(socialAccounts.refreshLeaseUntil), lte(socialAccounts.refreshLeaseUntil, opts.now)),
          ),
        )
        .orderBy(asc(socialAccounts.credentialsExpiresAt), asc(socialAccounts.id))
        .limit(opts.limit)
        .for("update", { skipLocked: true });
      const leaseUntil = new Date(opts.now.getTime() + opts.leaseMs);
      const out: ClaimedAccount[] = [];
      for (const row of rows) {
        await exec
          .update(socialAccounts)
          .set({ refreshLeaseUntil: leaseUntil, refreshLeaseOwner: opts.token })
          .where(and(eq(socialAccounts.id, row.id), eq(socialAccounts.projectId, row.projectId)));
        out.push(strip({ ...row, refreshLeaseUntil: leaseUntil, refreshLeaseOwner: opts.token }));
      }
      return out;
    });
  });
}

/** Repositories pinned to one project with no membership (FR-008). */
export function forSchedulerProject(projectId: string) {
  const build = (exec: Database) => ({ projectId, ...createSchedulingRepos(exec, projectId) });
  type Repos = ReturnType<typeof build>;
  return {
    ...build(getDb()),
    transaction<T>(fn: (tx: Repos) => Promise<T>): Promise<T> {
      return getDb().transaction((tx) => fn(build(tx as unknown as Database)));
    },
  };
}

/** Clears a lease and the in-flight step without counting an attempt (work that could not start). */
export async function releaseLease(projectId: string, targetId: string, token: string): Promise<boolean> {
  const row = await forSchedulerProject(projectId).targets.update(
    targetId,
    { leaseOwner: null, leaseUntil: null, inFlightStep: null, inFlightMayPublish: null },
    { leaseOwner: token },
  );
  return row !== null;
}

/**
 * Applies `patch` only while the caller still holds the lease `token`. `false` means the lease was
 * lost (US2-AS4): the caller records a `stale_result` attempt instead.
 */
export async function recordWithLease(
  projectId: string,
  targetId: string,
  token: string,
  patch: TargetPatch,
  exec?: ReturnType<typeof forSchedulerProject>,
): Promise<boolean> {
  const repos = exec ?? forSchedulerProject(projectId);
  const row = await repos.targets.update(targetId, patch, { leaseOwner: token });
  return row !== null;
}


/** Housekeeping: deletes at most `limit` reservations older than `before`; callers wrap this in `crossProject`. */
export async function pruneAllowanceUsesBefore(before: Date, limit: number): Promise<number> {
  const db = getDb();
  const ids = await db.select({ id: allowanceUses.id }).from(allowanceUses).where(lt(allowanceUses.createdAt, before)).limit(limit);
  if (ids.length === 0) return 0;
  const gone = await db.delete(allowanceUses).where(inArray(allowanceUses.id, ids.map((r) => r.id))).returning({ id: allowanceUses.id });
  return gone.length;
}
