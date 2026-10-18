import { z } from "zod";
import type { AccountMetricsReadResult, InsightsSupport, PostMetricsReadResult } from "../types";
import type { ThreadsSettings } from "./settings";

/**
 * contracts/provider-insights-081.md §3, research.md §3: the official media-insights metric enum
 * (`views`/`likes`/`replies`/`reposts`/`quotes`) is only third-party corroborated, not CONFIRMED —
 * so under FR-003 nothing is declared or requested. `threads_manage_insights` is still requested
 * under `THREADS_INSIGHTS_SCOPES` (connect-group.ts) and the grant is still recorded, so this
 * upgrades to a real reader later with no reconnect needed by anyone who already granted it.
 */
const unreachableMetricsSchema = z.object({}).strict();

const UNAVAILABLE = {
  reason: "Docket has not confirmed which metrics the Threads insights API reports.",
  docsPath: "insights",
} as const;

export const threadsInsights: InsightsSupport<ThreadsSettings> = {
  declaration: {
    post: [],
    account: [],
    maxPostsPerRead: 1,
    readBudget: { count: 48_000, windowSeconds: 86_400 }, // 4800 x 10, the documented floor (research §Q5)
    unavailable: UNAVAILABLE,
  },
  postMetricsSchema: unreachableMetricsSchema,
  accountMetricsSchema: unreachableMetricsSchema,
  async readPostMetrics(): Promise<PostMetricsReadResult> {
    return { kind: "unavailable", ...UNAVAILABLE };
  },
  async readAccountMetrics(): Promise<AccountMetricsReadResult> {
    return { kind: "unavailable", ...UNAVAILABLE };
  },
};
