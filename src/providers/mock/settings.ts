import { z } from "zod";

/** A scripted inbound item for the mock provider's `engagement.read()` (tested with no platform credentials). */
export const mockEngagementItemSchema = z.object({
  kind: z.enum(["reply", "comment", "mention", "direct_message"]),
  externalId: z.string().min(1),
  text: z.string(),
  authorDisplayName: z.string().nullable().default(null),
  authorHandle: z.string().nullable().default(null),
  authorExternalId: z.string().nullable().default(null),
  identityStable: z.boolean().default(false),
  saidAt: z.string().default(() => new Date().toISOString()),
  parentExternalId: z.string().nullable().default(null),
  upstream: z.enum(["withdrawn", "edited"]).optional(),
});
export type MockEngagementItem = z.infer<typeof mockEngagementItemSchema>;

export const mockEngagementSendBehaviours = ["sent", "duplicate", "ambiguous", "fatal_error", "credentials_invalid"] as const;
export const mockEngagementReadBehaviours = ["page", "retryable_error", "rate_limited", "credentials_invalid", "cursor_lost", "fatal_error"] as const;
export const mockInsightsReadBehaviours = ["page", "retryable_error", "rate_limited", "credentials_invalid", "fatal_error", "unavailable"] as const;

export const mockBehaviours = [
  "succeed",
  "multi_step",
  "retryable",
  "fatal",
  "ambiguous",
  "rate_limited",
  "throw",
] as const;

export const mockSettingsSchema = z.object({
  behaviour: z.enum(mockBehaviours).default("succeed"),
  /** multi_step: continues before the publish step */
  steps: z.number().int().min(1).max(10).default(1),
  /** retryable: fail the first N attempts, then succeed; omitted = always */
  failTimes: z.number().int().min(1).max(100).optional(),
  /** rate_limited: how far ahead `notBefore` is */
  retryAfterSeconds: z.number().int().min(1).max(86400).default(300),
  /** slow provider (respects ctx.signal) */
  delayMs: z.number().int().min(0).max(60000).default(0),
  refresh: z.enum(["succeed", "fail"]).default("succeed"),
  /** The engagement surface is declared but unavailable, with a reason and no call ever made (FR-055). */
  engagementUnavailable: z.boolean().default(false),
  /** Items `engagement.read()` returns, paged `ctx.limit` at a time in array order, so the cursor and backfill machinery is exercisable with no credentials. */
  engagementItems: z.array(mockEngagementItemSchema).default([]),
  engagementSendBehaviour: z.enum(mockEngagementSendBehaviours).default("sent"),
  /** Forces `engagement.read()` to return this stop result instead of a page (default: page normally). */
  engagementReadBehaviour: z.enum(mockEngagementReadBehaviours).default("page"),
  /** Serves pages normally through this many pages, then returns `engagementReadBehaviour` instead — so a run can insert items on one page and stop on the next. */
  engagementReadFailAfterPages: z.number().int().min(1).max(100).optional(),
  /** The insights surface is declared but unavailable, with a reason and no call ever made (FR-003). */
  insightsUnavailable: z.boolean().default(false),
  /** The values a post metrics read returns, for every requested id not listed in `insightsGoneExternalIds`. */
  insightsPostMetrics: z.record(z.string(), z.number()).default({ likeCount: 4, repostCount: 1 }),
  /** The values an account metrics read returns. */
  insightsAccountMetrics: z.record(z.string(), z.number()).default({ followersCount: 100 }),
  /** These post ids come back `kind: "gone"` instead of `metrics`. */
  insightsGoneExternalIds: z.array(z.string()).default([]),
  insightsPostReadBehaviour: z.enum(mockInsightsReadBehaviours).default("page"),
  insightsAccountReadBehaviour: z.enum(mockInsightsReadBehaviours).default("page"),
  /** A response holding a key the declaration omits — must be dropped before storage. */
  insightsReturnUndeclaredKey: z.boolean().default(false),
  /** A payload over the 2,000-byte size check — must be refused with no partial row. */
  insightsOversizedPayload: z.boolean().default(false),
  /** G37: drives the eligibility matrix test's `InsightsProviderRule.postScopes`, without touching a real provider. */
  insightsPostScopes: z.array(z.string()).default([]),
  /** G37: drives the eligibility matrix test's `InsightsProviderRule.accountScopes`, without touching a real provider. */
  insightsAccountScopes: z.array(z.string()).default([]),
  /** G35: which stored column a test target's post reader is given. */
  insightsPostIdSource: z.enum(["externalId", "publicPostId"]).default("externalId"),
  /** G35: the `docsPath` carried on `missingPostId` when `insightsPostIdSource` is `"publicPostId"`. */
  insightsMissingPostIdDocsPath: z.string().nullable().default(null),
  /** FR-050: the `docsPath` carried on a scripted run-time `unavailable` result. */
  insightsUnavailableDocsPath: z.string().nullable().default(null),
  /** 081: drives the ephemeral schedule and the `expired` freeze, end to end, via a test-built `InsightsProviderRule.ephemeralPostTypes`. */
  insightsEphemeralLifetimeMs: z.number().int().min(60_000).max(30 * 86_400_000).nullable().default(null),
  /** 081: these post ids come back `kind: "unqueryable"` instead of `metrics` or `gone`. */
  insightsUnqueryableIds: z.array(z.string()).default([]),
  /** 081: when set alongside `insightsPostReadBehaviour`/`insightsAccountReadBehaviour: "rate_limited"`, carried into the error message and `retryAt`. */
  insightsUsagePercent: z.number().min(0).max(100).nullable().default(null),
  insightsRetryAfterMinutes: z.number().int().min(0).max(1440).nullable().default(null),
});

export type MockSettings = z.infer<typeof mockSettingsSchema>;
export type MockState = { done: number; video?: "uploaded" | "polled" };
