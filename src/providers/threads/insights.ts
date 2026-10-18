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

// T080 (contracts/meta-usage.md §3) does not apply to this shape: `unavailable` is never claimed, so no
// Graph call is ever made here to carry a usage header. `THREADS_INSIGHTS_USAGE_CEILING` is still parsed
// (threads/config.ts) and takes effect the moment T099 upgrades this file to a real reader.

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
