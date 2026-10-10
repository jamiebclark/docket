import { getLlmStatus } from "../llm";
import * as clock from "../dal/clock";
import { ForbiddenError } from "../dal/errors";
import type { ProjectScope } from "../dal/scope";
import { listAccounts } from "./accounts";
import { listConnectGroups } from "./connect";
import { countNeedsDecision } from "./failures";
import * as invitations from "./invitations";
import * as members from "./members";
import { listMedia, mediaStatus } from "./media";
import { listPosts } from "./posts";
import { countReviewQueue } from "./review";
import { getSchedulerHealth } from "./scheduler-health";
import { listSlotCounts } from "./slots";
import { listVoiceProfiles } from "./voice";
import { managersOf } from "@/lib/roles/names";
import { countsTowardFirstPost, type OverviewAccount, type OverviewFacts, type PostStatusKey, type UpcomingPost } from "@/lib/overview/derive";

export type * from "@/lib/overview/derive";

const UPCOMING_MAX = 5;

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
  const llm = getLlmStatus();
  const media = await mediaStatus(scope);

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
      llm.configured ? listVoiceProfiles(scope) : Promise.resolve(null),
      media.enabled ? listMedia(scope, { limit: 1 }) : Promise.resolve(null),
    ]);

  const slotCounts = new Map((await listSlotCounts(scope)).map((c) => [c.accountId, c]));
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
    reviewCount,
    needsDecisionCount,
    ai: { configured: llm.configured, voiceProfiles: voices ? voices.length : null },
    storage: { configured: media.enabled, libraryItems: library ? library.total : null },
    scheduler: health.state,
    unconfiguredPlatforms,
    now,
  };
}
