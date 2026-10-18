import { XRPCError } from "@atproto/api";
import { z } from "zod";
import type {
  AccountMetricsReadContext,
  AccountMetricsReadResult,
  InsightsSupport,
  PostMetricEntry,
  PostMetricsReadContext,
  PostMetricsReadResult,
} from "../types";
import { agentFor } from "./client";
import { isCredentialRejection, isPreSend, rateLimitNotBefore, safeReason } from "./errors";
import { blueskyCredentialsSchema, type BlueskySettings } from "./settings";

const postMetricsSchema = z
  .object({
    likeCount: z.number().int().optional(),
    repostCount: z.number().int().optional(),
    replyCount: z.number().int().optional(),
    quoteCount: z.number().int().optional(),
  })
  .strict();

const accountMetricsSchema = z
  .object({
    followersCount: z.number().int().optional(),
    followsCount: z.number().int().optional(),
    postsCount: z.number().int().optional(),
  })
  .strict();

/** Only the fields the response actually contained; an omitted count stays omitted (FR-054). */
function pickDefined(obj: Record<string, number | undefined>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj)) if (typeof v === "number") out[k] = v;
  return out;
}

/** Maps a thrown platform error to one of the four non-`page` result kinds; never rethrows (FR-011, FR-057). */
function mapError(err: unknown, now: Date): Extract<PostMetricsReadResult, { kind: "retryable_error" | "fatal_error" | "credentials_invalid" | "rate_limited" }> {
  if (isPreSend(err)) return { kind: "retryable_error", error: "Could not reach Bluesky; will retry." };
  if (!(err instanceof XRPCError)) return { kind: "fatal_error", error: "Bluesky returned an unreadable response." };
  if (err.status === 429) {
    const retryAt = rateLimitNotBefore(err.headers, now) ?? undefined;
    return { kind: "rate_limited", error: "Bluesky is rate limiting requests.", ...(retryAt ? { retryAt } : {}) };
  }
  if (isCredentialRejection(err)) return { kind: "credentials_invalid", error: "Bluesky rejected the session; reconnect the account." };
  if (err.status >= 500 || err.status <= 2) return { kind: "retryable_error", error: `Bluesky did not give a usable answer (${safeReason(err)}).` };
  return { kind: "fatal_error", error: `Bluesky refused the request (${safeReason(err)}).` };
}

async function readPostMetrics(ctx: PostMetricsReadContext<BlueskySettings>): Promise<PostMetricsReadResult> {
  const creds = blueskyCredentialsSchema.safeParse(ctx.account.credentials);
  if (!creds.success) return { kind: "credentials_invalid", error: "Stored Bluesky credentials are unreadable; reconnect the account." };

  try {
    const res = await agentFor(ctx.account.settings.pdsUrl, creds.data.accessJwt).app.bsky.feed.getPosts(
      { uris: ctx.posts.map((p) => p.externalId) },
      { signal: ctx.signal },
    );
    const byUri = new Map(res.data.posts.map((post) => [post.uri, post]));
    const entries: PostMetricEntry[] = ctx.posts.map((p): PostMetricEntry => {
      const post = byUri.get(p.externalId);
      if (!post) return { externalId: p.externalId, kind: "gone" };
      return {
        externalId: p.externalId,
        kind: "metrics",
        metrics: pickDefined({
          likeCount: post.likeCount,
          repostCount: post.repostCount,
          replyCount: post.replyCount,
          quoteCount: post.quoteCount,
        }),
      };
    });
    return { kind: "page", entries };
  } catch (err) {
    return mapError(err, ctx.now);
  }
}

async function readAccountMetrics(ctx: AccountMetricsReadContext<BlueskySettings>): Promise<AccountMetricsReadResult> {
  const creds = blueskyCredentialsSchema.safeParse(ctx.account.credentials);
  if (!creds.success) return { kind: "credentials_invalid", error: "Stored Bluesky credentials are unreadable; reconnect the account." };

  try {
    const res = await agentFor(ctx.account.settings.pdsUrl, creds.data.accessJwt).app.bsky.actor.getProfile(
      { actor: ctx.account.externalId },
      { signal: ctx.signal },
    );
    return {
      kind: "page",
      metrics: pickDefined({
        followersCount: res.data.followersCount,
        followsCount: res.data.followsCount,
        postsCount: res.data.postsCount,
      }),
    };
  } catch (err) {
    return mapError(err, ctx.now);
  }
}

/**
 * No `views` key and no `reach` key: `PostView` and `ProfileViewDetailed` have no such property —
 * a confirmed negative (research.md §1, FR-052). Verified with mocked HTTP only until the live
 * check in Phase 8 runs (FR-058, constitution II).
 */
export const blueskyInsights: InsightsSupport<BlueskySettings> = {
  declaration: {
    post: [
      { key: "likeCount", label: "Likes" },
      { key: "repostCount", label: "Reposts" },
      { key: "replyCount", label: "Replies" },
      { key: "quoteCount", label: "Quotes" },
    ],
    account: [
      { key: "followersCount", label: "Followers" },
      { key: "followsCount", label: "Following" },
      { key: "postsCount", label: "Posts" },
    ],
    maxPostsPerRead: 25, // the lexicon's own maxLength (FR-053)
    readBudget: { count: 1_666, windowSeconds: 3_600 }, // interim, UNVERIFIED (research.md §3)
  },
  postMetricsSchema,
  accountMetricsSchema,
  readPostMetrics,
  readAccountMetrics,
};
