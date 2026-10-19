import { z } from "zod";
import type {
  AccountMetricsReadContext,
  AccountMetricsReadResult,
  InsightsSupport,
  PostMetricEntry,
  PostMetricsReadContext,
  PostMetricsReadResult,
} from "../types";
import { graphVersion, metaUsageCeiling } from "../meta/config";
import { readPageToken } from "../meta/credentials";
import { classifyGraphError, scrub } from "../meta/errors";
import { DEFAULT_GRAPH_BASE, graphRequest, type GraphOutcome, type MetaApp } from "../meta/graph";
import { activeUsageBackoff, recordUsageBackoff, type UsageSignal } from "../meta/usage";
import type { InstagramSettings } from "./settings";

const PLATFORM = "Instagram";

/** docs/research/meta.md, "Instagram media (post) insights" — all CONFIRMED. */
export const INSTAGRAM_POST_METRICS = ["views", "reach", "likes", "comments", "saved", "shares", "total_interactions"] as const;
/**
 * docs/research/meta.md, "Instagram user (account) insights". `profile_views` was REMOVED here:
 * Meta's user-insights reference no longer lists it (it lists `profile_links_taps`), and it was
 * deprecated in January 2025 and dropped that April. Graph errors the whole request on an unknown
 * metric name, so leaving it in would have taken `reach` and `follower_count` down with it.
 */
export const INSTAGRAM_ACCOUNT_METRICS = ["reach", "follower_count"] as const;
/** Deprecated (`impressions` 2025-11-15, `profile_views` 2025-01) or never documented for media/user insights; never requested (FR-004). */
export const INSTAGRAM_PROHIBITED_METRICS = [
  "impressions",
  "plays",
  "clips_replays_count",
  "ig_reels_aggregated_all_plays_count",
  "profile_views",
] as const;

const postMetricsSchema = z
  .object({
    views: z.number().optional(),
    reach: z.number().optional(),
    likes: z.number().optional(),
    comments: z.number().optional(),
    saved: z.number().optional(),
    shares: z.number().optional(),
    total_interactions: z.number().optional(),
  })
  .strict();

const accountMetricsSchema = z
  .object({
    reach: z.number().optional(),
    follower_count: z.number().optional(),
  })
  .strict();

/** Graph's `{ data: [{ name, values: [{ value }] }] }` shape. An empty or absent `values` leaves the key out — absent, not zero (FR-035). */
function metricsFromBody(body: unknown, keys: readonly string[]): Record<string, number> {
  const data = (body as { data?: unknown } | null)?.data;
  const out: Record<string, number> = {};
  if (!Array.isArray(data)) return out;
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const name = (item as Record<string, unknown>).name;
    if (typeof name !== "string" || !keys.includes(name)) continue;
    const values = (item as Record<string, unknown>).values;
    if (!Array.isArray(values) || values.length === 0) continue;
    const value = (values[values.length - 1] as Record<string, unknown> | null)?.value;
    if (typeof value === "number") out[name] = value;
  }
  return out;
}

type Failure = Extract<PostMetricsReadResult, { kind: "retryable_error" | "fatal_error" | "credentials_invalid" | "rate_limited" }>;

function codeSuffix(code: number | null, subcode: number | null): string {
  if (code === null) return "";
  return subcode !== null ? ` (code ${code}/${subcode})` : ` (code ${code})`;
}

/** Maps a non-ok outcome to one of the four non-`page` result kinds (contracts/provider-insights-081.md §5). Never throws. */
function mapOutcome(outcome: Exclude<GraphOutcome, { kind: "ok" }>, secrets: readonly string[]): Failure {
  switch (outcome.kind) {
    case "network":
      return { kind: "retryable_error", error: `${PLATFORM}: could not reach Meta; will retry.` };
    case "unparseable":
      return { kind: "retryable_error", error: `${PLATFORM}: Meta answered with an unreadable response.` };
    case "http_error":
      if (outcome.status >= 500 || outcome.status === 429) return { kind: "retryable_error", error: `${PLATFORM}: Meta answered HTTP ${outcome.status}.` };
      return { kind: "fatal_error", error: `${PLATFORM}: Meta answered HTTP ${outcome.status}.` };
    case "graph_error": {
      const e = outcome.error;
      const cls = classifyGraphError(e);
      const suffix = codeSuffix(e.code, e.subcode);
      if (cls === "invalid_token") return { kind: "credentials_invalid", error: `${PLATFORM} says the access token is no longer valid${suffix}.` };
      if (cls === "rate_limited") return { kind: "rate_limited", error: `${PLATFORM}: ${scrub(e.message, secrets)}${suffix}` };
      if (cls === "temporary" || outcome.status >= 500) return { kind: "retryable_error", error: `${PLATFORM}: ${scrub(e.message, secrets)}${suffix}` };
      return { kind: "fatal_error", error: `${PLATFORM}: ${scrub(e.message, secrets)}${suffix}` };
    }
  }
}

/** Graph's generic "object does not exist" code for a node that is gone — judgement call, not yet in research.md. */
const GONE_CODE = 100;

/** contracts/meta-usage.md §3: a ceiling-reaching usage signal backs off this account's *next* read, not this one. */
function applyUsageSignal(accountId: string, outcome: GraphOutcome, now: Date): void {
  const usage: UsageSignal | undefined = outcome.kind === "network" ? undefined : outcome.usage;
  if (!usage || usage.maxPercent < metaUsageCeiling() || usage.retryAfterMinutes === null) return;
  recordUsageBackoff(accountId, new Date(now.getTime() + usage.retryAfterMinutes * 60_000));
}

async function readPostMetrics(ctx: PostMetricsReadContext<InstagramSettings>): Promise<PostMetricsReadResult> {
  const backoff = activeUsageBackoff(ctx.account.id, ctx.now);
  if (backoff) return { kind: "rate_limited", error: `${PLATFORM} reports this account is near its call budget.`, retryAt: backoff };
  const token = readPageToken(ctx.account.credentials);
  if (!token) return { kind: "credentials_invalid", error: "The stored token is unreadable; reconnect the account." };
  const graph: MetaApp = { graphBase: DEFAULT_GRAPH_BASE, version: graphVersion() };

  const entries: PostMetricEntry[] = [];
  for (const post of ctx.posts) {
    const outcome = await graphRequest(graph, {
      method: "GET",
      path: `/${post.externalId}/insights`,
      params: { metric: INSTAGRAM_POST_METRICS.join(",") },
      token,
      signal: ctx.signal,
    });
    applyUsageSignal(ctx.account.id, outcome, ctx.now);
    if (outcome.kind === "ok") {
      entries.push({ externalId: post.externalId, kind: "metrics", metrics: metricsFromBody(outcome.body, INSTAGRAM_POST_METRICS) });
      continue;
    }
    if (outcome.kind === "graph_error" && outcome.error.code === GONE_CODE) {
      entries.push({ externalId: post.externalId, kind: "gone" });
      continue;
    }
    return mapOutcome(outcome, [token]);
  }
  return { kind: "page", entries };
}

async function readAccountMetrics(ctx: AccountMetricsReadContext<InstagramSettings>): Promise<AccountMetricsReadResult> {
  const backoff = activeUsageBackoff(ctx.account.id, ctx.now);
  if (backoff) return { kind: "rate_limited", error: `${PLATFORM} reports this account is near its call budget.`, retryAt: backoff };
  const token = readPageToken(ctx.account.credentials);
  if (!token) return { kind: "credentials_invalid", error: "The stored token is unreadable; reconnect the account." };
  const graph: MetaApp = { graphBase: DEFAULT_GRAPH_BASE, version: graphVersion() };

  const outcome = await graphRequest(graph, {
    method: "GET",
    path: `/${ctx.account.externalId}/insights`,
    // `metric_type: total_value` is required for every interaction metric on user insights
    // (Meta's user-insights reference); without it the request is rejected.
    params: { metric: INSTAGRAM_ACCOUNT_METRICS.join(","), period: "day", metric_type: "total_value" },
    token,
    signal: ctx.signal,
  });
  applyUsageSignal(ctx.account.id, outcome, ctx.now);
  if (outcome.kind !== "ok") return mapOutcome(outcome, [token]);
  return { kind: "page", metrics: metricsFromBody(outcome.body, INSTAGRAM_ACCOUNT_METRICS) };
}

/**
 * Verified with mocked HTTP only until the live check in Phase 8 runs (FR-037, constitution II).
 * One media per call (`maxPostsPerRead: 1`) — Graph's insights edge documents no batch parameter.
 */
export const instagramInsights: InsightsSupport<InstagramSettings> = {
  declaration: {
    postScopes: ["instagram_basic", "instagram_manage_insights", "pages_read_engagement"],
    missingPostScopes: {
      reason: "Instagram needs the instagram_manage_insights permission before Docket can read its numbers.",
      docsPath: "meta-setup#insights",
    },
    accountScopes: ["instagram_basic", "instagram_manage_insights", "pages_read_engagement"],
    missingAccountScopes: {
      reason: "Instagram needs the instagram_manage_insights permission before Docket can read its numbers.",
      docsPath: "meta-setup#insights",
    },
    post: [
      { key: "views", label: "Views", shape: { kind: "cumulative" } },
      { key: "reach", label: "Reach", shape: { kind: "cumulative" } },
      { key: "likes", label: "Likes", shape: { kind: "cumulative" } },
      { key: "comments", label: "Comments", shape: { kind: "cumulative" } },
      { key: "saved", label: "Saved", shape: { kind: "cumulative" } },
      { key: "shares", label: "Shares", shape: { kind: "cumulative" } },
      { key: "total_interactions", label: "Interactions", shape: { kind: "cumulative" } },
    ],
    account: [
      { key: "reach", label: "Reach", shape: { kind: "windowed", windowMs: 86_400_000 } },
      { key: "follower_count", label: "New followers", shape: { kind: "windowed", windowMs: 86_400_000 } },
    ],
    maxPostsPerRead: 1,
    readBudget: { count: 48_000, windowSeconds: 86_400 }, // interim, UNVERIFIED (research §4)
    ephemeralPostTypes: [{ postType: "story", lifetimeMs: 86_400_000 }],
  },
  postMetricsSchema,
  accountMetricsSchema,
  readPostMetrics,
  readAccountMetrics,
};
