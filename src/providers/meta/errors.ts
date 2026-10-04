import type { StepResult } from "../types";
import type { GraphError, GraphOutcome } from "./graph";

export const GRAPH_ERROR_TABLE = {
  invalidToken: [190],
  // R3 interim, UNVERIFIED
  rateLimited: [4, 17, 32, 613],
  temporary: [1, 2],
} as const;

export type GraphClass = "invalid_token" | "rate_limited" | "temporary" | "rejected";

export function classifyGraphError(e: GraphError): GraphClass {
  const code = e.code;
  if (code !== null) {
    if ((GRAPH_ERROR_TABLE.invalidToken as readonly number[]).includes(code)) return "invalid_token";
    if ((GRAPH_ERROR_TABLE.rateLimited as readonly number[]).includes(code)) return "rate_limited";
    if ((GRAPH_ERROR_TABLE.temporary as readonly number[]).includes(code)) return "temporary";
  }
  if (e.transient) return "temporary";
  return "rejected";
}

const SECRET_PARAMS = /\b(access_token|client_secret|code|fb_exchange_token)=[^&\s"']*/gi;

/** Replaces known secrets and secret-bearing query values; caps at 500 chars. */
export function scrub(text: string, secrets: readonly string[]): string {
  let out = text.replace(SECRET_PARAMS, "$1=[redacted]");
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join("[redacted]");
  }
  return out.length > 500 ? `${out.slice(0, 497)}...` : out;
}

function codeSuffix(e: GraphError): string {
  if (e.code === null) return "";
  return e.subcode !== null ? ` (code ${e.code}/${e.subcode})` : ` (code ${e.code})`;
}

/** Secret-free summary fields for an outcome. */
export function graphSummary(outcome: GraphOutcome): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (outcome.kind === "network") return out;
  out.httpStatus = outcome.status;
  if (outcome.kind === "graph_error") {
    const e = outcome.error;
    if (e.code !== null) out.graphCode = e.code;
    if (e.subcode !== null) out.graphSubcode = e.subcode;
    if (e.type) out.graphType = e.type;
    if (e.traceId) out.traceId = e.traceId;
  }
  return out;
}

type Failure = Extract<StepResult, { kind: "retryable_error" | "fatal_error" | "ambiguous" }>;

/**
 * Maps a non-ok outcome to a step result (research D12). On a `mayPublish` step only a rate-limit
 * code is retryable (the request was not executed); everything that may have reached Meta is ambiguous.
 */
export function graphStepError(
  outcome: GraphOutcome,
  opts: { mayPublish: boolean; platform: string; secrets: readonly string[] },
): Failure | null {
  if (outcome.kind === "ok") return null;
  const { platform, mayPublish, secrets } = opts;
  const summary = { response: graphSummary(outcome) };
  const retry = (error: string): Failure => ({ kind: "retryable_error", error, summary });
  const ambiguous = (error: string): Failure => ({ kind: "ambiguous", error, summary });
  const fatal = (error: string): Failure => ({ kind: "fatal_error", error, summary });

  switch (outcome.kind) {
    case "network":
      if (outcome.phase === "before_send") return retry(`${platform}: could not reach Meta (the request was not sent).`);
      return mayPublish
        ? ambiguous(`${platform}: the connection failed after the request was sent; the post may or may not exist.`)
        : retry(`${platform}: the connection failed; trying again.`);
    case "unparseable":
      return mayPublish
        ? ambiguous(`${platform}: Meta answered with an unreadable response; the post may or may not exist.`)
        : retry(`${platform}: Meta answered with an unreadable response.`);
    case "http_error": {
      const msg = `${platform}: Meta answered HTTP ${outcome.status}.`;
      if (outcome.status >= 500 || outcome.status === 429) return mayPublish ? ambiguous(msg) : retry(msg);
      return fatal(msg);
    }
    case "graph_error": {
      const e = outcome.error;
      const cls = classifyGraphError(e);
      if (cls === "invalid_token") {
        return {
          kind: "fatal_error",
          error: `${platform} says the access token is no longer valid${codeSuffix(e)}.`,
          credentialsInvalid: true,
          summary,
        };
      }
      const msg = `${platform}: ${scrub(e.message, secrets)}${codeSuffix(e)}`;
      if (cls === "rate_limited") return retry(msg);
      if (cls === "temporary") return mayPublish ? ambiguous(msg) : retry(msg);
      if (outcome.status >= 500) return mayPublish ? ambiguous(msg) : retry(msg);
      return fatal(msg);
    }
  }
}
