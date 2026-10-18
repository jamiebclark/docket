import { findProvider } from "@/providers/registry";
import { buildTargetInsightsView } from "@/lib/insights/panel";
import { resolveLlmForProject } from "../llm/resolve";
import * as clock from "../dal/clock";
import { ForbiddenError } from "../dal/errors";
import type { ProjectScope } from "../dal/scope";
import { insightsPermissionForAccount, listAccounts } from "./accounts";
import { listConnectGroups } from "./connect";
import { countNeedsDecision } from "./failures";
import * as invitations from "./invitations";
import * as members from "./members";
import { listMedia, mediaStatus } from "./media";
import { listPosts, excerptOf } from "./posts";
import { countReviewQueue } from "./review";
import { getSchedulerHealth } from "./scheduler-health";
import { listSlotCounts } from "./slots";
import { listVoiceProfiles } from "./voice";
import { managersOf } from "@/lib/roles/names";
import {
  countsTowardFirstPost,
  type OverviewAccount,
  type OverviewFacts,
  type PostStatusKey,
  type RecentPublishedPost,
  type UpcomingPost,
} from "@/lib/overview/derive";

export type * from "@/lib/overview/derive";

const UPCOMING_MAX = 5;
const RECENT_PUBLISHED_MAX = 5;

/**
 * Recent published posts with their latest per-target numbers (FR-020, FR-024): one query for the
 * post page, plus the same two batched reads `getPostView` and the posts list already make — bounded
 * by `RECENT_PUBLISHED_MAX`, never by the project's total post count.
 */
async function getRecentPublished(scope: ProjectScope, now: Date): Promise<RecentPublishedPost[]> {
  const { rows } = await scope.posts.list({ status: "published", limit: RECENT_PUBLISHED_MAX, offset: 0 });
  const accounts = new Map((await scope.accounts.list()).map((a) => [a.id, a]));
  const targetIds = rows.flatMap((r) => r.targets.map((t) => t.id));
  const [latestSnapshots, pollStates] = await Promise.all([
    scope.postMetricSnapshots.latestForTargets(targetIds),
    scope.postMetricPollStates.getMany(targetIds),
  ]);
  return rows.map((r) => ({
    id: r.post.id,
    excerpt: excerptOf(r.post.baseText),
    publishedAt: r.relevantAt,
    targets: r.targets.map((t) => {
      const account = accounts.get(t.socialAccountId);
      const providerName = account ? (findProvider(account.providerKey)?.displayName ?? account.providerKey) : "";
      return {
        id: t.id,
        accountName: account?.displayName ?? "Removed account",
        providerName,
        insights: buildTargetInsightsView({
          status: t.status,
          externalId: t.externalId,
          declaration: (account ? findProvider(account.providerKey)?.insights?.declaration : undefined) ?? null,
          providerName,
          permission: account ? insightsPermissionForAccount(account, findProvider(account.providerKey), "post") : null,
          snapshot: (latestSnapshots.get(t.id) as { capturedAt: Date; metrics: Record<string, unknown> } | undefined) ?? null,
          pollState: pollStates.get(t.id) ?? null,
          now,
        }),
      };
    }),
  }));
}

/** Read-only: whether any post counts toward the overview's first-post step. Requires view. */
export async function hasFirstPost(scope: ProjectScope): Promise<boolean> {
  if (!scope.can({ project: ["view"] })) throw new ForbiddenError();
  const { needs_decision: _needsDecision, ...counts } = await scope.posts.counts();
  return countsTowardFirstPost(counts as Partial<Record<PostStatusKey, number>>);
}

/**
 * Everything the project overview shows, gathered through the existing services (each enforces its own
 * permission) and reduced to plain values: no emails, credentials, settings, redirect addresses or error text.
 * Read-only. Errors propagate, so the page never claims something is empty when a read failed.
 */
export async function getOverview(scope: ProjectScope): Promise<OverviewFacts> {
  if (!scope.can({ project: ["view"] })) throw new ForbiddenError();

  const canInvite = scope.can({ invitation: ["create"] });
  const [llm, media] = await Promise.all([resolveLlmForProject(scope.project.id), mediaStatus(scope)]);

  const [accounts, scheduled, reviewCount, needsDecisionCount, memberRows, health, now, invites, voices, library] =
    await Promise.all([
      listAccounts(scope),
      listPosts(scope, { status: "scheduled" }),
      countReviewQueue(scope),
      countNeedsDecision(scope),
      members.list(scope),
      getSchedulerHealth(scope),
      clock.now(),
      canInvite ? invitations.listForProject(scope) : Promise.resolve(null),
      llm.ok ? listVoiceProfiles(scope) : Promise.resolve(null),
      media.enabled ? listMedia(scope, { limit: 1 }) : Promise.resolve(null),
    ]);

  const [slotCountsRaw, recentPublished] = await Promise.all([listSlotCounts(scope), getRecentPublished(scope, now)]);
  const slotCounts = new Map(slotCountsRaw.map((c) => [c.accountId, c]));
  const overviewAccounts: OverviewAccount[] = accounts.map((a) => ({
    id: a.id,
    providerKey: a.providerKey,
    providerName: a.providerName,
    displayName: a.displayName,
    status: a.status === "needs_reauth" ? "needs_reauth" : "active",
    providerAvailable: a.providerAvailable,
    credentialsExpireAt: a.credentialsExpireAt,
    slots: { active: slotCounts.get(a.id)?.active ?? 0, paused: slotCounts.get(a.id)?.paused ?? 0 },
  }));

  const upcoming: UpcomingPost[] = scheduled.items.slice(0, UPCOMING_MAX).map((p) => ({
    id: p.id,
    excerpt: p.excerpt,
    scheduledAt: p.relevantAt,
    accountNames: [...new Set(p.targets.map((t) => t.accountName))],
  }));

  const { needs_decision: _needsDecision, ...postCounts } = scheduled.counts;
  void _needsDecision;

  const managers = managersOf(memberRows);

  const unconfiguredPlatforms =
    scope.membership.role === "owner" && accounts.length === 0
      ? (await listConnectGroups(scope))
          .filter((g) => !g.configured)
          .map((g) => ({ key: g.key, displayName: g.displayName, setupDoc: g.setupDoc }))
      : null;

  return {
    project: { slug: scope.project.slug, name: scope.project.name, timezone: scope.project.timezone },
    viewer: {
      role: scope.membership.role,
      can: {
        manageAccounts: scope.can({ account: ["manage"] }),
        manageSlots: scope.can({ slot: ["manage"] }),
        manageVoice: scope.can({ voice: ["manage"] }),
        invite: canInvite,
        writePosts: scope.can({ post: ["edit"] }),
        editMedia: scope.can({ media: ["edit"] }),
      },
    },
    managers,
    memberCount: memberRows.length,
    pendingInvitations: invites ? invites.filter((i) => i.status === "pending").length : null,
    accounts: overviewAccounts,
    postCounts: postCounts as Partial<Record<PostStatusKey, number>>,
    upcoming,
    recentPublished,
    reviewCount,
    needsDecisionCount,
    ai: { configured: llm.ok, voiceProfiles: voices ? voices.length : null },
    storage: { configured: media.enabled, libraryItems: library ? library.total : null },
    scheduler: health.state,
    unconfiguredPlatforms,
    now,
  };
}
