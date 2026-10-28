import { z } from "zod";
import type {
  AccountMetricsReadContext,
  AccountMetricsReadResult,
  InsightsSupport,
  PostMetricEntry,
  PostMetricsReadContext,
  PostMetricsReadResult,
} from "../types";
import { classifyGraphError, scrub } from "../meta/errors";
import { graphRequest, type GraphOutcome } from "../meta/graph";
import { activeUsageBackoff, recordUsageBackoff, type UsageSignal } from "../meta/usage";
import { threadsApp, threadsInsightsUsageCeiling } from "./config";
import { readThreadsCredentials } from "./credentials";
import type { ThreadsSettings } from "./settings";

const PLATFORM = "Threads";

/**
 * docs/research/meta.md, "Threads media (post) insights" — the official metric enum, CONFIRMED
 * against <https://developers.facebook.com/docs/threads/insights> (R3). Every one of them is
 * `period: lifetime`, so every declared shape is `cumulative`.
 *
 * Meta marks `views` and `shares` **"in development"**: both are part of the documented enum, so
 * the request is not rejected, but either may simply not come back. That costs nothing here — a key
 * absent from a reading renders no row at all, never a zero (FR-035).
 */
const THREADS_RAW_POST_METRICS = ["views", "likes", "replies", "reposts", "quotes", "shares"] as const;

type ThreadsRawMetric = (typeof THREADS_RAW_POST_METRICS)[number];

/**
 * The keys stored in a snapshot's `metrics`, which are deliberately **not** all Threads' own raw
 * field names. `views`, `likes` and `shares` collide with Instagram's declared keys, and
 * `tests/integration/insights/provider-seam.test.ts` requires every provider's declared keys to be
 * disjoint — that is what stops a shared mapping table growing between two platforms that happen to
 * use the same word for different events. Prefixed exactly like TikTok's `tiktok_like_count`, and
 * only the three that actually collide, following that precedent.
 */
const STORED_KEY: Readonly<Record<ThreadsRawMetric, string>> = {
  views: "threads_views",
  likes: "threads_likes",
  shares: "threads_shares",
  replies: "replies",
  reposts: "reposts",
  quotes: "quotes",
};

export { THREADS_RAW_POST_METRICS };

/**
 * Never requested. Graph fails the **whole** call on one unknown metric name, so a stale name here
 * would take every other metric down with it rather than only itself. `profile_views` was removed
 * from Meta's user-insights reference (deprecated 2025-01, gone that April).
 */
export const THREADS_PROHIBITED_METRICS = ["profile_views", "impressions", "plays"] as const;

const postMetricsSchema = z
  .object({
    threads_views: z.number().optional(),
    threads_likes: z.number().optional(),
    threads_shares: z.number().optional(),
    replies: z.number().optional(),
    reposts: z.number().optional(),
    quotes: z.number().optional(),
  })
  .strict();

/** The account surface is not declared (research R4), so this is never claimed and never read. */
const accountMetricsSchema = z.object({}).strict();

const ACCOUNT_UNAVAILABLE = {
  reason: "Docket does not read account-level numbers from Threads.",
  docsPath: "insights",
} as const;

/**
 * Graph's `{ data: [{ name, period, values: [{ value }] }] }` shape, confirmed on the Threads
 * insights page. An empty or absent `values` leaves the key out — absent, not zero (FR-035). Raw
 * metric names become stored keys here, inside the provider folder, which is the only place FR-034
 * allows a metric key to be renamed.
 */
function metricsFromBody(body: unknown): Record<string, number> {
  const data = (body as { data?: unknown } | null)?.data;
  const out: Record<string, number> = {};
  if (!Array.isArray(data)) return out;
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const name = (item as Record<string, unknown>).name;
    if (typeof name !== "string" || !(name in STORED_KEY)) continue;
    const values = (item as Record<string, unknown>).values;
    if (!Array.isArray(values) || values.length === 0) continue;
    const value = (values[values.length - 1] as Record<string, unknown> | null)?.value;
    if (typeof value === "number") out[STORED_KEY[name as ThreadsRawMetric]] = value;
  }
  return out;
}

type Failure = Extract<PostMetricsReadResult, { kind: "retryable_error" | "fatal_error" | "credentials_invalid" | "rate_limited" }>;

function codeSuffix(code: number | null, subcode: number | null): string {
  if (code === null) return "";
  return subcode !== null ? ` (code ${code}/${subcode})` : ` (code ${code})`;
}

/** Maps a non-ok outcome to one of the four non-`page` kinds (contracts/provider-insights-081.md §5). Never throws. */
function mapOutcome(outcome: Exclude<GraphOutcome, { kind: "ok" }>, secrets: readonly string[]): Failure {
  switch (outcome.kind) {
    case "network":
      return { kind: "retryable_error", error: `${PLATFORM}: could not reach Threads; will retry.` };
    case "unparseable":
      return { kind: "retryable_error", error: `${PLATFORM}: Threads answered with an unreadable response.` };
    case "http_error":
      if (outcome.status >= 500 || outcome.status === 429) {
        return { kind: "retryable_error", error: `${PLATFORM}: Threads answered HTTP ${outcome.status}.` };
      }
      return { kind: "fatal_error", error: `${PLATFORM}: Threads answered HTTP ${outcome.status}.` };
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

/** Graph's generic "object does not exist" code for a node that is gone. */
const GONE_CODE = 100;

/** contracts/meta-usage.md §3: a ceiling-reaching usage signal backs off this account's *next* read, not this one. */
function applyUsageSignal(accountId: string, outcome: GraphOutcome, now: Date): void {
  const usage: UsageSignal | undefined = outcome.kind === "network" ? undefined : outcome.usage;
  if (!usage || usage.maxPercent < threadsInsightsUsageCeiling() || usage.retryAfterMinutes === null) return;
  recordUsageBackoff(accountId, new Date(now.getTime() + usage.retryAfterMinutes * 60_000));
}

async function readPostMetrics(ctx: PostMetricsReadContext<ThreadsSettings>): Promise<PostMetricsReadResult> {
  const backoff = activeUsageBackoff(ctx.account.id, ctx.now);
  if (backoff) return { kind: "rate_limited", error: `${PLATFORM} reports this account is near its call budget.`, retryAt: backoff };
  const creds = readThreadsCredentials(ctx.account.credentials);
  if (!creds) return { kind: "credentials_invalid", error: "The stored token is unreadable; reconnect the account." };
  const token = creds.accessToken;
  const graph = threadsApp();

  const entries: PostMetricEntry[] = [];
  for (const post of ctx.posts) {
    const outcome = await graphRequest(graph, {
      method: "GET",
      path: `/${post.externalId}/insights`,
      params: { metric: THREADS_RAW_POST_METRICS.join(",") },
      token,
      signal: ctx.signal,
    });
    applyUsageSignal(ctx.account.id, outcome, ctx.now);
    if (outcome.kind === "ok") {
      entries.push({ externalId: post.externalId, kind: "metrics", metrics: metricsFromBody(outcome.body) });
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

/**
 * Never reached: `account` is empty, so `insights-poll` never claims this surface
 * (`accountMetricsDeclared` is false). Returns the honest reason rather than throwing, so a future
 * caller cannot mistake silence for a zero.
 */
async function readAccountMetrics(_ctx: AccountMetricsReadContext<ThreadsSettings>): Promise<AccountMetricsReadResult> {
  return { kind: "unavailable", ...ACCOUNT_UNAVAILABLE };
}

/**
 * Verified with mocked HTTP only. One media per call (`maxPostsPerRead: 1`) — the insights edge
 * documents no batch parameter.
 *
 * The account surface stays undeclared: Threads' *profile* edge exposes `follower_count` and some
 * 7-day counters, but those are profile fields rather than `user_insights` metrics, and declaring a
 * profile field as an insights metric key would be a category error (research R4).
 */
export const threadsInsights: InsightsSupport<ThreadsSettings> = {
  declaration: {
    postScopes: ["threads_manage_insights"],
    missingPostScopes: {
      reason: "Threads needs the threads_manage_insights permission before Docket can read its numbers.",
      docsPath: "meta-setup#insights",
    },
    post: [
      { key: STORED_KEY.views, label: "Views", shape: { kind: "cumulative" } },
      { key: STORED_KEY.likes, label: "Likes", shape: { kind: "cumulative" } },
      { key: STORED_KEY.replies, label: "Replies", shape: { kind: "cumulative" } },
      { key: STORED_KEY.reposts, label: "Reposts", shape: { kind: "cumulative" } },
      { key: STORED_KEY.quotes, label: "Quotes", shape: { kind: "cumulative" } },
      { key: STORED_KEY.shares, label: "Shares", shape: { kind: "cumulative" } },
    ],
    account: [],
    maxPostsPerRead: 1,
    readBudget: { count: 48_000, windowSeconds: 86_400 }, // 4800 x 10, the documented floor (research §Q5)
  },
  postMetricsSchema,
  accountMetricsSchema,
  readPostMetrics,
  readAccountMetrics,
};
