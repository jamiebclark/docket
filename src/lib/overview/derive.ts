// Pure derivation of the project overview from plain facts. No I/O, no clock besides `facts.now`.
// The service (src/server/services/overview.ts) gathers OverviewFacts; the page renders OverviewView.

import { docsUrl } from "@/lib/docs";
import { roleLabel } from "@/lib/roles/roles";
import { joinNames } from "@/lib/roles/names";
import { hasActiveSlot } from "@/lib/roles/slots";

export const EXPIRY_WINDOW_DAYS = 14;

export type PostStatusKey =
  | "draft"
  | "needs_review"
  | "approved"
  | "scheduled"
  | "publishing"
  | "published"
  | "partially_failed"
  | "failed"
  | "rejected";

export type ViewerRole = "owner" | "admin" | "editor";

export type OverviewAccount = {
  id: string;
  providerKey: string;
  providerName: string;
  displayName: string;
  status: "active" | "needs_reauth";
  providerAvailable: boolean;
  credentialsExpireAt: Date | null;
  slots: { active: number; paused: number };
};

export type UpcomingPost = {
  id: string;
  excerpt: string;
  scheduledAt: Date | null;
  accountNames: string[];
};

export type OverviewFacts = {
  project: { slug: string; name: string; timezone: string };
  viewer: {
    role: ViewerRole;
    can: {
      manageAccounts: boolean;
      manageSlots: boolean;
      manageVoice: boolean;
      invite: boolean;
      writePosts: boolean;
      editMedia: boolean;
    };
  };
  managers: { name: string; role: "owner" | "admin" }[];
  memberCount: number;
  pendingInvitations: number | null;
  accounts: OverviewAccount[];
  postCounts: Partial<Record<PostStatusKey, number>>;
  upcoming: UpcomingPost[];
  reviewCount: number;
  needsDecisionCount: number;
  ai: { configured: boolean; voiceProfiles: number | null };
  storage: { configured: boolean; libraryItems: number | null };
  scheduler: "ok" | "stale" | "never";
  unconfiguredPlatforms: { key: string; displayName: string; setupDoc: string | null }[] | null;
  now: Date;
};

export type Action = { label: string; href: string };

export type ChecklistStep = {
  key: "account" | "slots" | "first_post" | "voice" | "media" | "invite";
  title: string;
  description: string;
  optional: boolean;
  status: { kind: "done" } | { kind: "todo" } | { kind: "waiting"; on: string };
  action: Action | null;
  blocked: string | null;
};

export type ServerSetupItem = {
  key: "scheduler" | "ai" | "storage" | "platforms";
  label: string;
  href: string;
};

export type ChecklistView = {
  mode: "full" | "collapsed";
  steps: ChecklistStep[];
  serverSetup: ServerSetupItem[] | null;
};

export type AttentionItem = {
  kind: "review" | "decision" | "failed" | "reconnect" | "expiry";
  label: string;
  badge: { tone: "warning" | "danger"; text: string };
  href: string | null;
  /** Shown instead of a link when the viewer can't act, e.g. "Ask Ana or Sam to reconnect it." */
  hint: string | null;
  /** Credential expiry time, rendered with LocalTime by the page. */
  at: Date | null;
};

export type AccountRow = {
  id: string;
  providerKey: string;
  providerName: string;
  displayName: string;
  badge: { tone: "neutral" | "danger" | "success"; text: string };
  slotsText: string;
  slotsHref: string | null;
  expiry: { expired: boolean; at: Date } | null;
};

export type ToolLine = { text: string; action: Action | null };

type Empty = { kind: "empty"; message: string; action: Action | null };

export type OverviewView = {
  title: string;
  description: string;
  primaryAction: Action | null;
  checklist: ChecklistView | null;
  needsAttention: AttentionItem[] | null;
  comingUp: { kind: "list"; items: UpcomingPost[] } | Empty;
  accounts: { kind: "list"; rows: AccountRow[] } | Empty;
  postsByStatus:
    | { kind: "counts"; items: { label: string; count: number; href: string }[] }
    | { kind: "empty"; action: Action | null };
  contentTools: { voice: ToolLine | null; media: ToolLine | null } | null;
};

export { joinNames } from "@/lib/roles/names";

/** `names(and)` / `names(or)` for the managers, used by every section that tells an editor who to ask. */
export function names(facts: Pick<OverviewFacts, "managers">, conjunction: "and" | "or"): string {
  return joinNames(
    facts.managers.map((m) => m.name),
    conjunction,
  );
}

const ROLE_LABEL: Record<ViewerRole, string> = {
  owner: `an ${roleLabel("owner")}`,
  admin: `an ${roleLabel("admin")}`,
  editor: `an ${roleLabel("editor")}`,
};

function withStatus(done: boolean, canAct: boolean, managers: string): ChecklistStep["status"] {
  if (done) return { kind: "done" };
  return canAct ? { kind: "todo" } : { kind: "waiting", on: managers };
}

/** What an owner still has to set up on the server, each with its docs page. `[]` for anyone else (FR-025–FR-027). */
export function serverSetupItems(facts: OverviewFacts): ServerSetupItem[] {
  if (facts.viewer.role !== "owner") return [];
  const items: ServerSetupItem[] = [];
  if (facts.scheduler !== "ok")
    items.push({ key: "scheduler", label: "The scheduler isn't running", href: docsUrl("deployment", "9-is-the-scheduler-running") });
  if (!facts.ai.configured)
    items.push({ key: "ai", label: "AI generation isn't set up", href: docsUrl("generator", "configuring-a-provider") });
  if (!facts.storage.configured) items.push({ key: "storage", label: "Media storage isn't set up", href: docsUrl("storage") });
  // A platform nobody here posts to is not missing, so they share one line instead of one "isn't set up" each.
  const platforms = facts.unconfiguredPlatforms ?? [];
  if (platforms.length > 0)
    items.push({
      key: "platforms",
      label: `More platforms you can set up: ${platforms.map((p) => p.displayName).join(", ")}`,
      href: platforms.length === 1 ? (platforms[0]!.setupDoc ?? docsUrl("accounts")) : docsUrl("accounts"),
    });
  return items;
}

/** The overview's "Write and schedule your first post" rule. */
export function countsTowardFirstPost(counts: Partial<Record<PostStatusKey, number>>): boolean {
  return (counts.scheduled ?? 0) + (counts.publishing ?? 0) + (counts.published ?? 0) + (counts.partially_failed ?? 0) >= 1;
}

/** Required steps 1–3 and the collapse rules. `null` when there is nothing left to show. */
export function deriveChecklist(facts: OverviewFacts): ChecklistView | null {
  const base = `/p/${facts.project.slug}`;
  const { can } = facts.viewer;
  const managers = names(facts, "and");
  const hasAccount = facts.accounts.length >= 1;
  const slotsDone = facts.accounts.some((a) => hasActiveSlot({ providerAvailable: a.providerAvailable, active: a.slots.active }));
  const c = facts.postCounts;
  const postDone = countsTowardFirstPost(c);
  const slotsAccount = facts.accounts.find((a) => a.providerAvailable) ?? facts.accounts[0];
  const needsAccount = "Needs an account first";

  const required: ChecklistStep[] = [
    {
      key: "account",
      title: "Connect an account",
      description: "Link the social profile Docket posts to.",
      optional: false,
      status: withStatus(hasAccount, can.manageAccounts, managers),
      action: !hasAccount && can.manageAccounts ? { label: "Connect an account", href: `${base}/accounts#add-account` } : null,
      blocked: null,
    },
    {
      key: "slots",
      title: "Add posting slots",
      description: "Weekly times Docket uses when you Add to queue.",
      optional: false,
      status: withStatus(slotsDone, can.manageSlots, managers),
      action:
        !slotsDone && hasAccount && can.manageSlots && slotsAccount
          ? { label: "Add posting slots", href: `${base}/accounts#account-${slotsAccount.id}-slots` }
          : null,
      blocked: !slotsDone && !hasAccount && can.manageSlots ? needsAccount : null,
    },
    {
      key: "first_post",
      title: "Write and schedule your first post",
      description: "Draft something and put it on the calendar.",
      optional: false,
      status: withStatus(postDone, true, managers),
      action: !postDone && hasAccount && can.writePosts ? { label: "Write a post", href: `${base}/compose` } : null,
      blocked: !postDone && !hasAccount ? needsAccount : null,
    },
  ];

  const optional: ChecklistStep[] = [];
  const voices = facts.ai.voiceProfiles;
  if (facts.ai.configured && voices !== null) {
    const done = voices >= 1;
    optional.push({
      key: "voice",
      title: "Create a voice profile",
      description: "Teaches the generator how your posts sound.",
      optional: true,
      status: withStatus(done, can.manageVoice, managers),
      action: !done && can.manageVoice ? { label: "Create a voice profile", href: `${base}/voice/new` } : null,
      blocked: null,
    });
  }
  const library = facts.storage.libraryItems;
  if (facts.storage.configured && library !== null && can.editMedia) {
    const done = library >= 1;
    optional.push({
      key: "media",
      title: "Upload images or videos",
      description: "Attach media to your posts from the library.",
      optional: true,
      status: withStatus(done, true, managers),
      action: !done ? { label: "Upload images or videos", href: `${base}/media` } : null,
      blocked: null,
    });
  }
  if (can.invite) {
    const done = facts.memberCount > 1 || (facts.pendingInvitations ?? 0) > 0;
    optional.push({
      key: "invite",
      title: "Invite a teammate",
      description: "Add an editor or admin to share the work.",
      optional: true,
      status: withStatus(done, true, managers),
      action: !done ? { label: "Invite a teammate", href: `${base}/settings/members` } : null,
      blocked: null,
    });
  }

  const setupItems = serverSetupItems(facts);
  const serverSetup: ServerSetupItem[] | null = setupItems.length > 0 ? setupItems : null;
  const allDone = required.every((s) => s.status.kind === "done");
  if (!allDone) return { mode: "full", steps: [...required, ...optional], serverSetup };
  // The server-setup row never blocks collapse (FR-028).
  const unfinishedOptional = optional.filter((s) => s.status.kind !== "done");
  if (unfinishedOptional.length === 0 && serverSetup === null) return null;
  return { mode: "collapsed", steps: unfinishedOptional, serverSetup };
}

const nf = new Intl.NumberFormat("en-US");

export function formatCount(n: number): string {
  return nf.format(n);
}

/** Problems the viewer should look at, or `null` when there are none (FR-030). */
export function deriveNeedsAttention(facts: OverviewFacts): AttentionItem[] | null {
  const base = `/p/${facts.project.slug}`;
  const manage = facts.viewer.can.manageAccounts;
  const items: AttentionItem[] = [];
  const failed = (facts.postCounts.failed ?? 0) + (facts.postCounts.partially_failed ?? 0);
  if (facts.reviewCount > 0)
    items.push({ kind: "review", label: "Awaiting review", badge: { tone: "warning", text: formatCount(facts.reviewCount) }, href: `${base}/review`, hint: null, at: null });
  if (facts.needsDecisionCount > 0)
    items.push({ kind: "decision", label: "Needs your decision", badge: { tone: "warning", text: formatCount(facts.needsDecisionCount) }, href: `${base}/failures`, hint: null, at: null });
  if (failed > 0)
    items.push({ kind: "failed", label: "Failed", badge: { tone: "danger", text: formatCount(failed) }, href: `${base}/failures`, hint: null, at: null });

  const accountLink = (a: OverviewAccount) => (manage ? `${base}/accounts#account-${a.id}` : null);
  const hint = manage ? null : `Ask ${names(facts, "or")} to reconnect it.`;
  const horizon = facts.now.getTime() + EXPIRY_WINDOW_DAYS * 86_400_000;
  for (const a of facts.accounts) {
    const who = `${a.displayName} (${a.providerName})`;
    if (a.status === "needs_reauth") {
      items.push({ kind: "reconnect", label: `${who} needs reconnecting`, badge: { tone: "danger", text: "Needs reconnecting" }, href: accountLink(a), hint, at: null });
    } else if (a.credentialsExpireAt && a.credentialsExpireAt.getTime() <= horizon) {
      const expired = a.credentialsExpireAt.getTime() <= facts.now.getTime();
      items.push({
        kind: "expiry",
        label: `${who}: credentials ${expired ? "expired" : "expire"}`,
        badge: expired ? { tone: "danger", text: "Expired" } : { tone: "warning", text: "Expires soon" },
        href: accountLink(a),
        hint,
        at: a.credentialsExpireAt,
      });
    }
  }
  return items.length > 0 ? items : null;
}

export function deriveComingUp(facts: OverviewFacts): OverviewView["comingUp"] {
  const base = `/p/${facts.project.slug}`;
  const items = [...facts.upcoming]
    .filter((p) => p.scheduledAt !== null)
    .sort((a, b) => (a.scheduledAt as Date).getTime() - (b.scheduledAt as Date).getTime())
    .slice(0, 5);
  if (items.length > 0) return { kind: "list", items };
  const { can } = facts.viewer;
  if (facts.accounts.length > 0)
    return {
      kind: "empty",
      message: "No scheduled posts yet. Write one and schedule it.",
      action: can.writePosts ? { label: "Write a post", href: `${base}/compose` } : null,
    };
  if (can.manageAccounts)
    return {
      kind: "empty",
      message: "No scheduled posts yet. Connect an account first.",
      action: { label: "Connect an account", href: `${base}/accounts#add-account` },
    };
  return { kind: "empty", message: `No scheduled posts yet. Connect an account first. Ask ${names(facts, "or")} to connect one.`, action: null };
}

export function deriveAccounts(facts: OverviewFacts): OverviewView["accounts"] {
  const base = `/p/${facts.project.slug}`;
  const { can } = facts.viewer;
  if (facts.accounts.length === 0)
    return can.manageAccounts
      ? { kind: "empty", message: "You don't have any accounts yet.", action: { label: "Add an account", href: `${base}/accounts#add-account` } }
      : { kind: "empty", message: `No accounts yet. Ask ${names(facts, "or")} to connect one.`, action: null };
  const rows = facts.accounts.map((a): AccountRow => {
    const badge: AccountRow["badge"] = !a.providerAvailable
      ? { tone: "neutral", text: "Unavailable" }
      : a.status === "needs_reauth"
        ? { tone: "danger", text: "Needs reconnecting" }
        : { tone: "success", text: "Connected" };
    const { active, paused } = a.slots;
    const slotsText =
      active >= 1
        ? `${formatCount(active)} posting ${active === 1 ? "slot" : "slots"} a week`
        : paused >= 1
          ? "All posting slots paused"
          : can.manageSlots
            ? "No posting slots — add some"
            : "No posting slots";
    const expiry = a.credentialsExpireAt
      ? { expired: a.credentialsExpireAt.getTime() <= facts.now.getTime(), at: a.credentialsExpireAt }
      : null;
    return {
      id: a.id,
      providerKey: a.providerKey,
      providerName: a.providerName,
      displayName: a.displayName,
      badge,
      slotsText,
      slotsHref: active === 0 && paused === 0 && !can.manageSlots ? null : `${base}/accounts#account-${a.id}-slots`,
      expiry,
    };
  });
  return { kind: "list", rows };
}

/** Voice and media status, only for the features the server has configured (FR-035). */
export function deriveContentTools(facts: OverviewFacts): OverviewView["contentTools"] {
  const base = `/p/${facts.project.slug}`;
  const { can } = facts.viewer;
  const voices = facts.ai.voiceProfiles;
  const library = facts.storage.libraryItems;
  const voice: ToolLine | null =
    facts.ai.configured && voices !== null
      ? voices >= 1
        ? { text: `${formatCount(voices)} voice ${voices === 1 ? "profile" : "profiles"}`, action: { label: "Open voice profiles", href: `${base}/voice` } }
        : can.manageVoice
          ? { text: "No voice profile yet. Generated posts need one.", action: { label: "Create a voice profile", href: `${base}/voice/new` } }
          : { text: `No voice profile yet. Generated posts need one. Ask ${names(facts, "or")} to create one.`, action: null }
      : null;
  const media: ToolLine | null =
    facts.storage.configured && library !== null
      ? library >= 1
        ? { text: `${formatCount(library)} images and videos`, action: { label: "Open media library", href: `${base}/media` } }
        : { text: "No images or videos yet.", action: can.editMedia ? { label: "Upload images or videos", href: `${base}/media` } : null }
      : null;
  return voice || media ? { voice, media } : null;
}

export function derivePostsByStatus(facts: OverviewFacts): OverviewView["postsByStatus"] {
  const base = `/p/${facts.project.slug}`;
  const c = facts.postCounts;
  const total = Object.values(c).reduce<number>((sum, n) => sum + (n ?? 0), 0);
  // No action of its own: the header, the checklist and Coming up already offer the next step, and a fourth copy is noise.
  if (total === 0) return { kind: "empty", action: null };
  const line = (label: string, key: "draft" | "needs_review" | "approved" | "scheduled") => ({
    label,
    count: c[key] ?? 0,
    href: `${base}/posts?status=${key}`,
  });
  return {
    kind: "counts",
    items: [line("Drafts", "draft"), line("Needs review", "needs_review"), line("Approved but not scheduled", "approved"), line("Scheduled", "scheduled")],
  };
}

export function deriveOverview(facts: OverviewFacts): Pick<OverviewView, "title" | "description" | "primaryAction" | "checklist" | "needsAttention" | "comingUp" | "accounts" | "postsByStatus" | "contentTools"> {
  const base = `/p/${facts.project.slug}`;
  const { can } = facts.viewer;
  // No account yet: the one primary action is connecting one, and someone who can't gets none rather than a dead end.
  const primaryAction: Action | null =
    facts.accounts.length === 0
      ? can.manageAccounts
        ? { label: "Connect an account", href: `${base}/accounts#add-account` }
        : null
      : can.writePosts
        ? { label: "Write a post", href: `${base}/compose` }
        : null;
  return {
    title: facts.project.name,
    description: `Times in ${facts.project.timezone}. You're ${ROLE_LABEL[facts.viewer.role]}.`,
    primaryAction,
    checklist: deriveChecklist(facts),
    needsAttention: deriveNeedsAttention(facts),
    comingUp: deriveComingUp(facts),
    accounts: deriveAccounts(facts),
    postsByStatus: derivePostsByStatus(facts),
    contentTools: deriveContentTools(facts),
  };
}
