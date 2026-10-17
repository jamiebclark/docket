import { z } from "zod";
import type { AccountMetricsReadContext, AccountMetricsReadResult, InsightsSupport, PostMetricEntry, PostMetricsReadContext, PostMetricsReadResult } from "../types";
import { mockSettingsSchema, type MockSettings } from "./settings";

const mockMetricsSchema = z.object({ likeCount: z.number().int().optional(), repostCount: z.number().int().optional(), viewCount: z.number().int().optional() }).strict();
const mockAccountMetricsSchema = z.object({ followersCount: z.number().int().optional(), postsCount: z.number().int().optional() }).strict();

function stopResult(
  behaviour: MockSettings["insightsPostReadBehaviour"],
): PostMetricsReadResult | AccountMetricsReadResult | null {
  switch (behaviour) {
    case "page":
      return null;
    case "retryable_error":
      return { kind: "retryable_error", error: "Mock retryable insights failure." };
    case "rate_limited":
      return { kind: "rate_limited", error: "Mock insights rate limited." };
    case "credentials_invalid":
      return { kind: "credentials_invalid", error: "Mock insights credentials invalid." };
    case "fatal_error":
      return { kind: "fatal_error", error: "Mock fatal insights failure." };
    case "unavailable":
      return { kind: "unavailable", reason: "Mock insights set to unavailable for this account." };
  }
}

function metricsFor(settings: MockSettings): Record<string, number> {
  const base = settings.insightsPostMetrics;
  return settings.insightsReturnUndeclaredKey ? { ...base, notDeclared: 1 } : base;
}

function accountMetricsFor(settings: MockSettings): Record<string, number> {
  const base = settings.insightsAccountMetrics;
  return settings.insightsReturnUndeclaredKey ? { ...base, notDeclared: 1 } : base;
}

/**
 * Declares post keys `likeCount`/"Likes", `repostCount`/"Reposts", `viewCount`/"Views" (a key
 * Bluesky has no equivalent of) and account keys `followersCount`/"Followers",
 * `postsCount`/"Posts". `maxPostsPerRead: 3`, so batching is exercisable with four fixture
 * targets. Every scripted behaviour is reachable from settings alone, with no platform credentials
 * (contracts/provider-insights.md §6, SC-004).
 */
export const mockInsights: InsightsSupport<MockSettings> = {
  declaration: {
    post: [
      { key: "likeCount", label: "Likes" },
      { key: "repostCount", label: "Reposts" },
      { key: "viewCount", label: "Views" },
    ],
    account: [
      { key: "followersCount", label: "Followers" },
      { key: "postsCount", label: "Posts" },
    ],
    maxPostsPerRead: 3,
    readBudget: { count: 1000, windowSeconds: 3_600 },
  },
  postMetricsSchema: mockMetricsSchema,
  accountMetricsSchema: mockAccountMetricsSchema,

  async readPostMetrics(ctx: PostMetricsReadContext<MockSettings>): Promise<PostMetricsReadResult> {
    const settings = mockSettingsSchema.parse(ctx.account.settings ?? {});
    if (settings.insightsUnavailable) return { kind: "unavailable", reason: "Mock insights set to unavailable for this account." };
    const stop = stopResult(settings.insightsPostReadBehaviour) as PostMetricsReadResult | null;
    if (stop) return stop;
    // `metrics` is typed `unknown` on the wire; an oversized or malformed payload is the caller's
    // job to refuse against `postMetricsSchema` and the 2,000-byte CHECK, never the provider's.
    const metrics: unknown = settings.insightsOversizedPayload ? { padding: "x".repeat(2_200) } : metricsFor(settings);
    const entries: PostMetricEntry[] = ctx.posts.map((p) =>
      settings.insightsGoneExternalIds.includes(p.externalId) ? { externalId: p.externalId, kind: "gone" } : { externalId: p.externalId, kind: "metrics", metrics },
    );
    return { kind: "page", entries };
  },

  async readAccountMetrics(ctx: AccountMetricsReadContext<MockSettings>): Promise<AccountMetricsReadResult> {
    const settings = mockSettingsSchema.parse(ctx.account.settings ?? {});
    if (settings.insightsUnavailable) return { kind: "unavailable", reason: "Mock insights set to unavailable for this account." };
    const stop = stopResult(settings.insightsAccountReadBehaviour) as AccountMetricsReadResult | null;
    if (stop) return stop;
    const metrics: unknown = settings.insightsOversizedPayload ? { padding: "x".repeat(2_200) } : accountMetricsFor(settings);
    return { kind: "page", metrics };
  },
};
