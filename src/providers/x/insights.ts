import { z } from "zod";
import type {
  AccountMetricsReadContext,
  AccountMetricsReadResult,
  InsightsSupport,
  PostMetricEntry,
  PostMetricsReadContext,
  PostMetricsReadResult,
} from "../types";
import { parseXInsightsEnv } from "./config";
import { readXCredentials } from "./credentials";
import { problemText, xRequest, type XOutcome } from "./http";

const SETUP = "x-setup#insights";
const OPT_IN_OFF_REASON =
  "Reading X numbers is a metered request Docket is not making. X charges $0.001 per post read; turn it on with X_INSIGHTS_ENABLED.";
const X_ACCOUNT_UNPRICED =
  "X's per-user read price is not confirmed to be the $0.001 owned rate; Docket will not spend the operator's money on an unverified assumption.";

const DECLARED_POST_KEYS = ["like_count", "reply_count", "retweet_count", "quote_count", "bookmark_count", "impression_count"] as const;

const postMetricsSchema = z
  .object({
    like_count: z.number().optional(),
    reply_count: z.number().optional(),
    retweet_count: z.number().optional(),
    quote_count: z.number().optional(),
    bookmark_count: z.number().optional(),
    impression_count: z.number().optional(),
  })
  .strict();

const accountMetricsSchema = z.object({}).strict();

type Classified =
  | { tag: "ok"; body: unknown }
  | { tag: "credentials_invalid" }
  | { tag: "rate"; resetAtMs: number | null }
  | { tag: "fatal" }
  | { tag: "retryable" };

const NOT_FOUND_TITLES = new Set(["Not Found Error", "Authorization Error"]);

/** contracts/platform-readers-082.md §3's error table, read once per outcome. Never throws. */
function classify(out: XOutcome): Classified {
  if (out.kind === "network") return { tag: "retryable" };
  if (out.kind === "unparseable") return { tag: "retryable" };
  if (out.kind === "ok") return { tag: "ok", body: out.body };
  const status = out.status;
  const title = out.body && typeof out.body === "object" ? (out.body as { title?: unknown }).title : null;
  const titleInvalid = typeof title === "string" && title.toLowerCase().includes("token");
  if (status === 401 || titleInvalid) return { tag: "credentials_invalid" };
  if (status === 429) return { tag: "rate", resetAtMs: out.rate.resetAtMs };
  if (status === 403) return { tag: "fatal" };
  if (status >= 500) return { tag: "retryable" };
  return { tag: "fatal" };
}

function isNotFound(error: { title?: unknown; type?: unknown }): boolean {
  const title = typeof error.title === "string" ? error.title : "";
  const type = typeof error.type === "string" ? error.type : "";
  return NOT_FOUND_TITLES.has(title) || type.includes("not-found") || type.includes("resource-not-found");
}

type Failure = Exclude<PostMetricsReadResult, { kind: "page" }>;

function failureFor(r: Exclude<Classified, { tag: "ok" }>, body: unknown, secrets: readonly string[]): Failure {
  switch (r.tag) {
    case "credentials_invalid":
      return { kind: "credentials_invalid", error: "X rejected the access token; reconnect the account." };
    case "rate": {
      const retryAt = r.resetAtMs !== null ? new Date(r.resetAtMs) : undefined;
      return { kind: "rate_limited", error: "X's rate limit was reached; will retry after it resets.", retryAt };
    }
    case "fatal": {
      const detail = problemText(body, secrets);
      return { kind: "fatal_error", error: detail ? `X refused the request. (X: ${detail})` : "X refused the request." };
    }
    case "retryable":
      return { kind: "retryable_error", error: "X did not answer cleanly; will retry." };
  }
}

async function readPostMetrics(ctx: PostMetricsReadContext<unknown>): Promise<PostMetricsReadResult> {
  const credentials = readXCredentials(ctx.account.credentials);
  if (!credentials) return { kind: "credentials_invalid", error: "The stored token is unreadable; reconnect the account." };
  const secrets = [credentials.accessToken, credentials.refreshToken];

  if (ctx.posts.length === 0) return { kind: "page", entries: [] };

  const out = await xRequest({
    method: "GET",
    path: "/2/tweets",
    query: { ids: ctx.posts.map((p) => p.externalId).join(","), "tweet.fields": "public_metrics" },
    auth: { kind: "bearer", token: credentials.accessToken },
    signal: ctx.signal,
  });
  const r = classify(out);
  if (r.tag !== "ok") return failureFor(r, out.kind === "http_error" ? out.body : null, secrets);

  const body = r.body && typeof r.body === "object" ? (r.body as Record<string, unknown>) : {};
  const data = Array.isArray(body.data) ? (body.data as unknown[]) : [];
  const errors = Array.isArray(body.errors) ? (body.errors as unknown[]) : [];

  const entries: PostMetricEntry[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id !== "string" || !id) continue;
    const publicMetrics = (item as { public_metrics?: unknown }).public_metrics;
    const metrics: Record<string, number> = {};
    if (publicMetrics && typeof publicMetrics === "object") {
      for (const key of DECLARED_POST_KEYS) {
        const value = (publicMetrics as Record<string, unknown>)[key];
        if (typeof value === "number") metrics[key] = value;
      }
    }
    entries.push({ externalId: id, kind: "metrics", metrics });
  }
  for (const error of errors) {
    if (!error || typeof error !== "object") continue;
    const resourceId = (error as { resource_id?: unknown }).resource_id;
    if (typeof resourceId !== "string" || !resourceId) continue;
    if (isNotFound(error as { title?: unknown; type?: unknown })) entries.push({ externalId: resourceId, kind: "gone" });
  }
  return { kind: "page", entries };
}

async function readAccountMetrics(_ctx: AccountMetricsReadContext<unknown>): Promise<AccountMetricsReadResult> {
  return { kind: "unavailable", reason: X_ACCOUNT_UNPRICED, docsPath: SETUP };
}

/** Verified with mocked HTTP only until the live check in Phase 10 runs (contracts/platform-readers-082.md §3). */
export const xInsights: InsightsSupport<unknown> = {
  get declaration() {
    const { enabled, readCeiling } = parseXInsightsEnv(process.env);
    return {
      post: [
        { key: "like_count", label: "Likes" },
        { key: "reply_count", label: "Replies" },
        { key: "retweet_count", label: "Reposts" },
        { key: "quote_count", label: "Quotes" },
        { key: "bookmark_count", label: "Bookmarks" },
        { key: "impression_count", label: "Impressions" },
      ],
      account: [],
      maxPostsPerRead: 100,
      postIdSource: "externalId" as const,
      readBudget: { count: readCeiling, windowSeconds: 2_592_000 },
      ...(enabled
        ? {
            postScopes: ["tweet.read"],
            missingPostScopes: { reason: "An X account needs the tweet.read permission before Docket can read a post's numbers.", docsPath: SETUP },
            accountScopes: [],
          }
        : { unavailable: { reason: OPT_IN_OFF_REASON, docsPath: SETUP } }),
    };
  },
  postMetricsSchema,
  accountMetricsSchema,
  readPostMetrics,
  readAccountMetrics,
};
