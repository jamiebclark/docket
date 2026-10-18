import { z } from "zod";
import type {
  AccountMetricsReadContext,
  AccountMetricsReadResult,
  InsightsSupport,
  PostMetricEntry,
  PostMetricsReadContext,
  PostMetricsReadResult,
} from "../types";
import { readPinterestCredentials } from "./credentials";
import { pinterestRequest, readPinterestMessage, scrubPinterest, type PinterestOutcome } from "./http";
import { pinterestAnalyticsWindow } from "./window";

const SETUP = "pinterest-setup#insights";
const PINNER_DATA_ACCESS_DENIED = "PINNER_DATA_ACCESS_DENIED";
const MISSING_SCOPE_REASON = "A Pinterest account needs the pins:read permission before Docket can read a pin's analytics.";
const PINNER_DENIED_REASON =
  "Pinterest does not give Docket pin analytics for this account; it needs a business account with pinner-data access.";

const DECLARED_POST_KEYS = ["IMPRESSION", "PIN_CLICK", "OUTBOUND_CLICK", "SAVE"] as const;

const postMetricsSchema = z
  .object({
    IMPRESSION: z.number().optional(),
    PIN_CLICK: z.number().optional(),
    OUTBOUND_CLICK: z.number().optional(),
    SAVE: z.number().optional(),
  })
  .strict();

// `pinterest_follower_count`, not Pinterest's own raw field name: that collides with Instagram's
// declared `follower_count` (FR-018, constitution V).
const accountMetricsSchema = z
  .object({
    pinterest_follower_count: z.number().optional(),
    monthly_views: z.number().optional(),
  })
  .strict();

type Classified =
  | { tag: "ok"; body: unknown }
  | { tag: "credentials_invalid" }
  | { tag: "rate"; resetSeconds: number | null }
  | { tag: "pinner_denied" }
  | { tag: "gone" }
  | { tag: "retryable" }
  | { tag: "fatal"; status: number; message: string | null };

/** contracts/platform-readers-082.md §2's error table, read once per outcome. Never throws. */
function classify(out: PinterestOutcome): Classified {
  if (out.kind === "network") return { tag: "retryable" };
  if (out.kind === "unparseable") return { tag: "retryable" };
  if (out.kind === "ok") return { tag: "ok", body: out.body };
  const status = out.status;
  const message = readPinterestMessage(out.body);
  if (status === 401) return { tag: "credentials_invalid" };
  if (status === 429) return { tag: "rate", resetSeconds: out.rate.resetSeconds };
  if (status === 403 && message === PINNER_DATA_ACCESS_DENIED) return { tag: "pinner_denied" };
  if (status === 404) return { tag: "gone" };
  if (status >= 500) return { tag: "retryable" };
  return { tag: "fatal", status, message };
}

/** `now + clamp(resetSeconds, 1, 3600) × 1000`, matching `publish.ts`'s rate-limit handling. */
function rateLimitRetryAt(now: Date, resetSeconds: number | null): Date | undefined {
  if (resetSeconds === null) return undefined;
  const clamped = Math.min(Math.max(resetSeconds, 1), 3600);
  return new Date(now.getTime() + clamped * 1000);
}

function sentenceFor(status: number): string {
  if (status >= 400 && status < 500) return `Pinterest refused the request (HTTP ${status}).`;
  return `Pinterest answered with an error (HTTP ${status}).`;
}

function explain(status: number, message: string | null, secrets: readonly string[]): string {
  const sentence = sentenceFor(status);
  if (!message) return sentence;
  const detail = scrubPinterest(message, secrets);
  return detail ? `${sentence} (Pinterest: ${detail})` : sentence;
}

type Failure = Exclude<PostMetricsReadResult, { kind: "page" }>;

function failureFor(r: Exclude<Classified, { tag: "ok" } | { tag: "gone" }>, now: Date, secrets: readonly string[]): Failure {
  switch (r.tag) {
    case "credentials_invalid":
      return { kind: "credentials_invalid", error: "Pinterest rejected the access token; reconnect the account." };
    case "rate":
      return { kind: "rate_limited", error: "Pinterest asked Docket to slow down.", retryAt: rateLimitRetryAt(now, r.resetSeconds) };
    case "pinner_denied":
      return { kind: "unavailable", reason: PINNER_DENIED_REASON, docsPath: SETUP };
    case "retryable":
      return { kind: "retryable_error", error: "Pinterest did not answer cleanly; will retry." };
    case "fatal":
      return { kind: "fatal_error", error: explain(r.status, r.message, secrets) };
  }
}

/** The declared `summary_metrics` keys of the preferred split: `"ALL"`, else the single value present, else none. */
function summaryMetricsOf(body: unknown): Record<string, number> {
  const metrics: Record<string, number> = {};
  if (!body || typeof body !== "object" || Array.isArray(body)) return metrics;
  const obj = body as Record<string, unknown>;
  const splits = Object.keys(obj);
  const key = splits.includes("ALL") ? "ALL" : splits.length === 1 ? splits[0]! : undefined;
  if (!key) return metrics;
  const split = obj[key];
  if (!split || typeof split !== "object") return metrics;
  const summary = (split as Record<string, unknown>).summary_metrics;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return metrics;
  for (const k of DECLARED_POST_KEYS) {
    const value = (summary as Record<string, unknown>)[k];
    if (typeof value === "number") metrics[k] = value;
  }
  return metrics;
}

async function readPostMetrics(ctx: PostMetricsReadContext<unknown>): Promise<PostMetricsReadResult> {
  const credentials = readPinterestCredentials(ctx.account.credentials);
  if (!credentials) return { kind: "credentials_invalid", error: "The stored token is unreadable; reconnect the account." };
  const secrets = [credentials.accessToken, credentials.refreshToken];

  const post = ctx.posts[0];
  if (!post) return { kind: "page", entries: [] };

  // `ctx` carries no publish date (contracts/provider-insights-082.md §3: "nothing new" on
  // `PostMetricsReadContext`), so the widest allowed window is always requested; Pinterest
  // simply reports no activity for days before the pin existed.
  const window = pinterestAnalyticsWindow({ publishedAt: new Date(0), now: ctx.now });
  const out = await pinterestRequest({
    method: "GET",
    path: `/v5/pins/${encodeURIComponent(post.externalId)}/analytics?start_date=${window.start}&end_date=${window.end}&metric_types=${DECLARED_POST_KEYS.join(",")}`,
    auth: { kind: "bearer", token: credentials.accessToken },
    signal: ctx.signal,
  });
  const r = classify(out);
  const entry: PostMetricEntry =
    r.tag === "gone"
      ? { externalId: post.externalId, kind: "gone" }
      : r.tag === "ok"
        ? { externalId: post.externalId, kind: "metrics", metrics: summaryMetricsOf(r.body) }
        : null!;
  if (entry) return { kind: "page", entries: [entry] };
  return failureFor(r as Exclude<Classified, { tag: "ok" } | { tag: "gone" }>, ctx.now, secrets);
}

async function readAccountMetrics(ctx: AccountMetricsReadContext<unknown>): Promise<AccountMetricsReadResult> {
  const credentials = readPinterestCredentials(ctx.account.credentials);
  if (!credentials) return { kind: "credentials_invalid", error: "The stored token is unreadable; reconnect the account." };
  const secrets = [credentials.accessToken, credentials.refreshToken];

  const out = await pinterestRequest({
    method: "GET",
    path: "/v5/user_account",
    auth: { kind: "bearer", token: credentials.accessToken },
    signal: ctx.signal,
  });
  const r = classify(out);
  if (r.tag === "gone") return { kind: "fatal_error", error: "Pinterest could not find this account." };
  if (r.tag !== "ok") return failureFor(r, ctx.now, secrets);

  const body = r.body && typeof r.body === "object" ? (r.body as Record<string, unknown>) : {};
  const metrics: Record<string, number> = {};
  // Stored under `pinterest_follower_count`, not Pinterest's own raw field name (read as-is above):
  // that collides with Instagram's declared `follower_count` (FR-018, constitution V).
  for (const [rawKey, storedKey] of [
    ["follower_count", "pinterest_follower_count"],
    ["monthly_views", "monthly_views"],
  ] as const) {
    const value = body[rawKey];
    if (typeof value === "number") metrics[storedKey] = value;
  }
  return { kind: "page", metrics };
}

/** Verified with mocked HTTP only until the live check in Phase 10 runs (contracts/platform-readers-082.md §2). */
export const pinterestInsights: InsightsSupport<unknown> = {
  declaration: {
    postScopes: ["pins:read"],
    missingPostScopes: { reason: MISSING_SCOPE_REASON, docsPath: SETUP },
    accountScopes: [],
    post: [
      { key: "IMPRESSION", label: "Impressions", shape: { kind: "windowed", windowMs: null } },
      { key: "PIN_CLICK", label: "Pin clicks", shape: { kind: "windowed", windowMs: null } },
      { key: "OUTBOUND_CLICK", label: "Outbound clicks", shape: { kind: "windowed", windowMs: null } },
      { key: "SAVE", label: "Saves", shape: { kind: "windowed", windowMs: null } },
    ],
    account: [
      { key: "pinterest_follower_count", label: "Followers", shape: { kind: "cumulative" } },
      {
        key: "monthly_views",
        label: "Monthly views",
        shape: {
          kind: "unknown",
          reason: "Pinterest does not document the window this number covers, so Docket cannot plot it over time.",
        },
      },
    ],
    maxPostsPerRead: 1,
    postIdSource: "externalId",
    readBudget: { count: 1000, windowSeconds: 86_400 }, // CONFIRMED, org_read Trial figure (research.md §2)
  },
  postMetricsSchema,
  accountMetricsSchema,
  readPostMetrics,
  readAccountMetrics,
};
