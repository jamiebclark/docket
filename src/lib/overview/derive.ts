// Pure derivation of the project overview from plain facts. No I/O, no clock besides `facts.now`.
// The service (src/server/services/overview.ts) gathers OverviewFacts; the page renders OverviewView.

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
  key: "scheduler" | "ai" | "storage" | `platform:${string}`;
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
