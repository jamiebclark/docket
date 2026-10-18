import { z } from "zod";
import type {
  AccountMetricsReadContext,
  AccountMetricsReadResult,
  InsightsSupport,
  PostMetricEntry,
  PostMetricsReadContext,
  PostMetricsReadResult,
} from "../types";
import { RATE_RETRY_MS } from "./state";
import { readTikTokCredentials } from "./credentials";
import { explainTikTok } from "./errors";
import { readEnvelope, tiktokRequest, type TikTokOutcome } from "./http";

const PLATFORM = "TikTok";
const SETUP = "tiktok-setup#insights";

const UNQUERYABLE_REASON =
  "TikTok did not return this post for this account; it may have been deleted, or the stored id may not be a video id.";
const MISSING_SCOPE_REASON = "A TikTok account needs the video.list permission before Docket can read its post numbers.";
const MISSING_ACCOUNT_SCOPE_REASON = "A TikTok account needs the user.info.stats permission before Docket can read its account numbers.";

const postMetricsSchema = z
  .object({
    like_count: z.number().optional(),
    comment_count: z.number().optional(),
    share_count: z.number().optional(),
    view_count: z.number().optional(),
  })
  .strict();

const accountMetricsSchema = z
  .object({
    follower_count: z.number().optional(),
    likes_count: z.number().optional(),
    video_count: z.number().optional(),
  })
  .strict();

type Classified =
  | { tag: "ok"; data: Record<string, unknown> | null }
  | { tag: "credentials_invalid" }
  | { tag: "rate"; ms: number }
  | { tag: "retryable" }
  | { tag: "unavailable" }
  | { tag: "fatal"; code: string | null; message: string | null };

const CAP_CODES = new Set(["spam_risk_too_many_posts", "reached_active_user_cap"]);

/** contracts/platform-readers-082.md §1's error table, read once per outcome. Never throws. */
function classify(out: TikTokOutcome): Classified {
  if (out.kind === "network") return { tag: "retryable" };
  if (out.kind === "unparseable") return { tag: "retryable" };
  const env = readEnvelope(out.body);
  const status = out.status;
  if (status === 401 || env.code === "access_token_invalid") return { tag: "credentials_invalid" };
  if (status === 429 || env.code === "rate_limit_exceeded") return { tag: "rate", ms: out.retryAfterMs ?? RATE_RETRY_MS };
  if (env.code && CAP_CODES.has(env.code)) return { tag: "retryable" };
  if (out.kind === "http_error" && status >= 500) return { tag: "retryable" };
  if (env.code === "scope_not_authorized") return { tag: "unavailable" };
  if (env.code || out.kind === "http_error") return { tag: "fatal", code: env.code, message: env.message };
  return { tag: "ok", data: env.data };
}

type Failure = Exclude<PostMetricsReadResult, { kind: "page" }>;

function failureFor(r: Exclude<Classified, { tag: "ok" }>, now: Date, secrets: readonly string[]): Failure {
  switch (r.tag) {
    case "credentials_invalid":
      return { kind: "credentials_invalid", error: "TikTok rejected the access token; reconnect the account." };
    case "rate":
      return { kind: "rate_limited", error: "TikTok asked Docket to slow down.", retryAt: new Date(now.getTime() + r.ms) };
    case "retryable":
      return { kind: "retryable_error", error: `${PLATFORM} did not answer cleanly; will retry.` };
    case "unavailable":
      return { kind: "unavailable", reason: MISSING_SCOPE_REASON, docsPath: SETUP };
    case "fatal":
      return { kind: "fatal_error", error: explainTikTok(r.code, r.message, secrets) };
  }
}

async function readPostMetrics(ctx: PostMetricsReadContext<unknown>): Promise<PostMetricsReadResult> {
  const credentials = readTikTokCredentials(ctx.account.credentials);
  if (!credentials) return { kind: "credentials_invalid", error: "The stored token is unreadable; reconnect the account." };
  const secrets = [credentials.accessToken, credentials.refreshToken];

  const ids = ctx.posts.map((p) => p.externalId);
  const out = await tiktokRequest({
    method: "POST",
    path: "/v2/video/query/?fields=like_count,comment_count,share_count,view_count,id",
    token: credentials.accessToken,
    json: { filters: { video_ids: ids } },
    signal: ctx.signal,
  });
  const r = classify(out);
  if (r.tag !== "ok") return failureFor(r, ctx.now, secrets);

  const videos = Array.isArray(r.data?.videos) ? (r.data!.videos as unknown[]) : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const v of videos) {
    if (typeof v !== "object" || v === null) continue;
    const id = (v as Record<string, unknown>).id;
    if (typeof id === "string" || typeof id === "number") byId.set(String(id), v as Record<string, unknown>);
  }

  const entries: PostMetricEntry[] = [];
  for (const id of ids) {
    const video = byId.get(id);
    if (!video) {
      entries.push({ externalId: id, kind: "unqueryable", reason: UNQUERYABLE_REASON });
      continue;
    }
    const metrics: Record<string, number> = {};
    for (const key of ["like_count", "comment_count", "share_count", "view_count"]) {
      const value = video[key];
      if (typeof value === "number") metrics[key] = value;
    }
    entries.push({ externalId: id, kind: "metrics", metrics });
  }
  return { kind: "page", entries };
}

async function readAccountMetrics(ctx: AccountMetricsReadContext<unknown>): Promise<AccountMetricsReadResult> {
  const credentials = readTikTokCredentials(ctx.account.credentials);
  if (!credentials) return { kind: "credentials_invalid", error: "The stored token is unreadable; reconnect the account." };
  const secrets = [credentials.accessToken, credentials.refreshToken];

  const out = await tiktokRequest({
    method: "GET",
    path: "/v2/user/info/?fields=follower_count,likes_count,video_count",
    token: credentials.accessToken,
    signal: ctx.signal,
  });
  const r = classify(out);
  if (r.tag !== "ok") {
    const failure = failureFor(r, ctx.now, secrets);
    if (failure.kind === "unavailable") return { kind: "unavailable", reason: MISSING_ACCOUNT_SCOPE_REASON, docsPath: SETUP };
    return failure;
  }

  const user = r.data && typeof r.data.user === "object" && r.data.user !== null ? (r.data.user as Record<string, unknown>) : r.data;
  const metrics: Record<string, number> = {};
  for (const key of ["follower_count", "likes_count", "video_count"]) {
    const value = user?.[key];
    if (typeof value === "number") metrics[key] = value;
  }
  return { kind: "page", metrics };
}

/** Verified with mocked HTTP only until the live check in Phase 8 runs (contracts/platform-readers-082.md §1). */
export const tiktokInsights: InsightsSupport<unknown> = {
  declaration: {
    postScopes: ["video.list"],
    missingPostScopes: { reason: MISSING_SCOPE_REASON, docsPath: SETUP },
    accountScopes: ["user.info.stats"],
    missingAccountScopes: { reason: MISSING_ACCOUNT_SCOPE_REASON, docsPath: SETUP },
    post: [
      { key: "like_count", label: "Likes" },
      { key: "comment_count", label: "Comments" },
      { key: "share_count", label: "Shares" },
      { key: "view_count", label: "Views" },
    ],
    account: [
      { key: "follower_count", label: "Followers" },
      { key: "likes_count", label: "Likes" },
      { key: "video_count", label: "Videos" },
    ],
    maxPostsPerRead: 20,
    postIdSource: "publicPostId",
    missingPostId: { reason: "This post has no queryable public post id.", docsPath: SETUP },
    readBudget: { count: 600, windowSeconds: 60 }, // PARTLY CONFIRMED, per-app token (research.md §1)
  },
  postMetricsSchema,
  accountMetricsSchema,
  readPostMetrics,
  readAccountMetrics,
};
