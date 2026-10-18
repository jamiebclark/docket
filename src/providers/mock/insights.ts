import { z } from "zod";
import type { AccountMetricsReadContext, AccountMetricsReadResult, InsightsSupport, PostMetricEntry, PostMetricsReadContext, PostMetricsReadResult } from "../types";
import { mockSettingsSchema, type MockSettings } from "./settings";

const mockMetricsSchema = z.object({ likeCount: z.number().int().optional(), repostCount: z.number().int().optional(), viewCount: z.number().int().optional() }).strict();
const mockAccountMetricsSchema = z.object({ followersCount: z.number().int().optional(), postsCount: z.number().int().optional() }).strict();

function stopResult(
  behaviour: MockSettings["insightsPostReadBehaviour"],
  settings: MockSettings,
  now: Date,
): PostMetricsReadResult | AccountMetricsReadResult | null {
  switch (behaviour) {
    case "page":
      return null;
    case "retryable_error":
      return { kind: "retryable_error", error: "Mock retryable insights failure." };
    case "rate_limited":
      return {
        kind: "rate_limited",
        error: `Mock reports this account is at ${settings.insightsUsagePercent ?? 100}% of its call budget.`,
        ...(settings.insightsRetryAfterMinutes !== null
          ? { retryAt: new Date(now.getTime() + settings.insightsRetryAfterMinutes * 60_000) }
          : {}),
      };
    case "credentials_invalid":
      return { kind: "credentials_invalid", error: "Mock insights credentials invalid." };
    case "fatal_error":
      return { kind: "fatal_error", error: "Mock fatal insights failure." };
    case "unavailable":
      return { kind: "unavailable", reason: "Mock insights set to unavailable for this account.", docsPath: settings.insightsUnavailableDocsPath ?? undefined };
  }
}

/**
 * Test-only convenience: builds the `InsightsProviderRule` shape (data-model.md §4) a test can pass
 * to `src/server/dal/insights-claims.ts` from a mock account's own scripted settings, so the
 * eligibility matrix and ephemeral-schedule tests exercise real rule shapes without a real provider.
 */
export function mockInsightsRuleFor(settings: MockSettings): {
  providerKey: "mock";
  postScopes: readonly string[];
  accountScopes: readonly string[];
  postIdSource: "externalId" | "publicPostId";
  missingPostId: { reason: string; docsPath?: string } | null;
  postMetricsDeclared: boolean;
  accountMetricsDeclared: boolean;
  ephemeralPostTypes: readonly { postType: string; lifetimeMs: number }[];
} {
  return {
    providerKey: "mock",
    postScopes: settings.insightsPostScopes,
    accountScopes: settings.insightsAccountScopes,
    postIdSource: settings.insightsPostIdSource,
    missingPostId:
      settings.insightsPostIdSource === "publicPostId"
        ? { reason: "This target has no queryable public post id.", docsPath: settings.insightsMissingPostIdDocsPath ?? undefined }
        : null,
    postMetricsDeclared: true,
    accountMetricsDeclared: true,
    ephemeralPostTypes:
      settings.insightsEphemeralLifetimeMs !== null ? [{ postType: "story", lifetimeMs: settings.insightsEphemeralLifetimeMs }] : [],
  };
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
    const stop = stopResult(settings.insightsPostReadBehaviour, settings, ctx.now) as PostMetricsReadResult | null;
    if (stop) return stop;
    // `metrics` is typed `unknown` on the wire; an oversized or malformed payload is the caller's
    // job to refuse against `postMetricsSchema` and the 2,000-byte CHECK, never the provider's.
    const metrics: unknown = settings.insightsOversizedPayload ? { padding: "x".repeat(2_200) } : metricsFor(settings);
    const entries: PostMetricEntry[] = ctx.posts.map((p) => {
      if (settings.insightsUnqueryableIds.includes(p.externalId)) {
        return { externalId: p.externalId, kind: "unqueryable", reason: "Mock insights scripted this id as unqueryable." };
      }
      if (settings.insightsGoneExternalIds.includes(p.externalId)) return { externalId: p.externalId, kind: "gone" };
      return { externalId: p.externalId, kind: "metrics", metrics };
    });
    return { kind: "page", entries };
  },

  async readAccountMetrics(ctx: AccountMetricsReadContext<MockSettings>): Promise<AccountMetricsReadResult> {
    const settings = mockSettingsSchema.parse(ctx.account.settings ?? {});
    if (settings.insightsUnavailable) return { kind: "unavailable", reason: "Mock insights set to unavailable for this account." };
    const stop = stopResult(settings.insightsAccountReadBehaviour, settings, ctx.now) as AccountMetricsReadResult | null;
    if (stop) return stop;
    const metrics: unknown = settings.insightsOversizedPayload ? { padding: "x".repeat(2_200) } : accountMetricsFor(settings);
    return { kind: "page", metrics };
  },
};
