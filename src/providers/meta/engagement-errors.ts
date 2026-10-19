import type { EngagementReadResult } from "../types";
import { classifyGraphError, scrub } from "./errors";
import type { GraphOutcome } from "./graph";

/** Graph's generic "object does not exist" code (`facebook/insights.ts`'s `GONE_CODE`). */
const GONE_CODE = 100;

type Mapped = Exclude<EngagementReadResult, { kind: "page" | "unavailable" }>;

function codeSuffix(code: number | null, subcode: number | null): string {
  if (code === null) return "";
  return subcode !== null ? ` (code ${code}/${subcode})` : ` (code ${code})`;
}

/**
 * Maps a non-`ok` `GraphOutcome` to one of the engagement seam's non-`page` outcomes
 * (contracts/meta-engagement-sweep.md §6). `hasCursor` is true when the failing request carried
 * `catchUp.postsAfter` or a `pending[].after`: on those requests a Graph code 100 means the stored
 * position is gone (`cursor_lost`, FR-020), never a drain-step "this one post is gone" (FR-017),
 * which the sweep handles itself before this function is ever called. Every message passes
 * through `scrub` with the caller's own secrets (FR-023).
 */
export function classifyEngagementOutcome(
  outcome: Exclude<GraphOutcome, { kind: "ok" }>,
  opts: { platform: string; secrets: readonly string[]; hasCursor: boolean },
): Mapped {
  const { platform, secrets, hasCursor } = opts;

  switch (outcome.kind) {
    case "network":
      return { kind: "retryable_error", error: scrub(`${platform}: could not reach Meta; will retry.`, secrets) };
    case "unparseable":
      return { kind: "retryable_error", error: scrub(`${platform}: Meta answered with an unreadable response.`, secrets) };
    case "http_error": {
      const msg = scrub(`${platform}: Meta answered HTTP ${outcome.status}.`, secrets);
      if (outcome.status >= 500 || outcome.status === 429) return { kind: "retryable_error", error: msg };
      return { kind: "fatal_error", error: msg };
    }
    case "graph_error": {
      const e = outcome.error;
      const suffix = codeSuffix(e.code, e.subcode);
      const cls = classifyGraphError(e);
      if (cls === "invalid_token") {
        return { kind: "credentials_invalid", error: scrub(`${platform} says the access token is no longer valid${suffix}.`, secrets) };
      }
      if (hasCursor && e.code === GONE_CODE) {
        return { kind: "cursor_lost", error: scrub(`${platform} rejected the read position; restarting from the newest posts${suffix}.`, secrets) };
      }
      const msg = `${platform}: ${scrub(e.message, secrets)}${suffix}`;
      if (cls === "rate_limited") return { kind: "rate_limited", error: msg };
      if (cls === "temporary" || outcome.status >= 500) return { kind: "retryable_error", error: msg };
      return { kind: "fatal_error", error: msg };
    }
  }
}
