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
import type { FacebookSettings } from "./settings";

const PLATFORM = "Facebook";

/** contracts/provider-insights-081.md §2 — both CONFIRMED. */
export const FACEBOOK_POST_METRICS = ["post_reactions_by_type_total", "post_clicks"] as const;
export const FACEBOOK_ACCOUNT_METRICS = ["page_post_engagements", "page_follows"] as const;
/**
 * Deprecated 2025-11-15 (`post_impressions`, `page_impressions`, `page_fans`) or whose v26.0
 * replacement could not be confirmed (research §2, R2); never requested (FR-004).
 */
export const FACEBOOK_PROHIBITED_METRICS = [
  "post_impressions",
  "post_impressions_unique",
  "post_impressions_paid",
  "post_impressions_organic",
  "page_impressions",
  "page_impressions_unique",
  "page_impressions_paid",
  "page_impressions_organic",
  "page_fans",
  "page_fans_online",
  "page_posts_impressions",
  "page_posts_impressions_unique",
  "post_media_view",
  "page_media_view",
  "post_video_media_view",
  "page_video_media_view",
] as const;

const postMetricsSchema = z
  .object({
    post_reactions_by_type_total: z.number().optional(),
    post_clicks: z.number().optional(),
  })
  .strict();

const accountMetricsSchema = z
  .object({
    page_post_engagements: z.number().optional(),
    page_follows: z.number().optional(),
  })
  .strict();

/** A Page post id, e.g. `{page-id}_{post-id}` — the only id shape Facebook's post insights edge answers for. */
const PAGE_POST_ID = /^\d{1,40}_\d{1,40}$/;
/** A bare video id, e.g. from the Reel publish path (`src/providers/facebook/publish.ts` `externalId: state.videoId`). */
const VIDEO_ID = /^\d{1,40}$/;

/** contracts/provider-insights-081.md §2 — classifies before any request is issued (FR-036). */
function classifyExternalId(externalId: string): { queryable: true } | { queryable: false; reason: string } {
  if (PAGE_POST_ID.test(externalId)) return { queryable: true };
  if (VIDEO_ID.test(externalId)) {
    return { queryable: false, reason: "This Reel was published as a video id, which Facebook's post insights cannot read." };
  }
  return { queryable: false, reason: "This id is not a recognised Facebook post or video id, so it cannot be read." };
}

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

async function readPostMetrics(ctx: PostMetricsReadContext<FacebookSettings>): Promise<PostMetricsReadResult> {
  const backoff = activeUsageBackoff(ctx.account.id, ctx.now);
  if (backoff) return { kind: "rate_limited", error: `${PLATFORM} reports this account is near its call budget.`, retryAt: backoff };
  const token = readPageToken(ctx.account.credentials);
  if (!token) return { kind: "credentials_invalid", error: "The stored token is unreadable; reconnect the account." };
  const graph: MetaApp = { graphBase: DEFAULT_GRAPH_BASE, version: graphVersion() };

  const entries: PostMetricEntry[] = [];
  for (const post of ctx.posts) {
    const classification = classifyExternalId(post.externalId);
    if (!classification.queryable) {
      entries.push({ externalId: post.externalId, kind: "unqueryable", reason: classification.reason });
      continue;
    }
    const outcome = await graphRequest(graph, {
      method: "GET",
      path: `/${post.externalId}/insights`,
      params: { metric: FACEBOOK_POST_METRICS.join(",") },
      token,
      signal: ctx.signal,
    });
    applyUsageSignal(ctx.account.id, outcome, ctx.now);
    if (outcome.kind === "ok") {
      entries.push({ externalId: post.externalId, kind: "metrics", metrics: metricsFromBody(outcome.body, FACEBOOK_POST_METRICS) });
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

async function readAccountMetrics(ctx: AccountMetricsReadContext<FacebookSettings>): Promise<AccountMetricsReadResult> {
  const backoff = activeUsageBackoff(ctx.account.id, ctx.now);
  if (backoff) return { kind: "rate_limited", error: `${PLATFORM} reports this account is near its call budget.`, retryAt: backoff };
  const token = readPageToken(ctx.account.credentials);
  if (!token) return { kind: "credentials_invalid", error: "The stored token is unreadable; reconnect the account." };
  const graph: MetaApp = { graphBase: DEFAULT_GRAPH_BASE, version: graphVersion() };

  const outcome = await graphRequest(graph, {
    method: "GET",
    path: `/${ctx.account.externalId}/insights`,
    params: { metric: FACEBOOK_ACCOUNT_METRICS.join(",") },
    token,
    signal: ctx.signal,
  });
  applyUsageSignal(ctx.account.id, outcome, ctx.now);
  if (outcome.kind !== "ok") return mapOutcome(outcome, [token]);
  return { kind: "page", metrics: metricsFromBody(outcome.body, FACEBOOK_ACCOUNT_METRICS) };
}

/**
 * Verified with mocked HTTP only until the live check in Phase 8 runs (FR-037, constitution II).
 * One post per call (`maxPostsPerRead: 1`) — Graph's insights edge documents no batch parameter.
 */
export const facebookInsights: InsightsSupport<FacebookSettings> = {
  declaration: {
    requiredScopes: ["pages_read_engagement", "read_insights"],
    missingScopes: {
      reason: "A Facebook Page needs the read_insights permission before Docket can read its numbers.",
      docsPath: "meta-setup#insights",
    },
    post: [
      { key: "post_reactions_by_type_total", label: "Reactions" },
      { key: "post_clicks", label: "Clicks" },
    ],
    account: [
      { key: "page_post_engagements", label: "Engagements" },
      { key: "page_follows", label: "Follows" },
    ],
    maxPostsPerRead: 1,
    readBudget: { count: 48_000, windowSeconds: 86_400 }, // interim, UNVERIFIED (research §4)
    // no ephemeralPostTypes: Facebook Page Stories are out of scope by the constitution
  },
  postMetricsSchema,
  accountMetricsSchema,
  readPostMetrics,
  readAccountMetrics,
};
