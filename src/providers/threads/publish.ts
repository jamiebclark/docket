import { docsUrl } from "@/lib/docs";
import { graphRequest, type GraphOutcome } from "../meta/graph";
import { classifyGraphError, graphStepError, graphSummary, scrub } from "../meta/errors";
import type { AttemptSummary, PublishContext, StepResult } from "../types";
import { threadsApp } from "./config";
import { readThreadsCredentials } from "./credentials";
import { QUOTA_RETRY_MS, readQuota } from "./quota";
import { CHECK_INTERVAL_MS, CONTAINER_SAFE_AGE_MS, FIRST_CHECK_DELAY_MS, initialState, MAX_RECREATIONS, PROCESSING_CAP_MS, type ThreadsState } from "./state";
import { threadsStepFor, validState } from "./steps";

const PLATFORM = "Threads";
const URL_HINT = ` Images must be at a public URL (see ${docsUrl("storage")}).`;
const RETRY_HINT = " Retry the post to create it again.";

const fatal = (error: string, summary?: AttemptSummary): StepResult => ({ kind: "fatal_error", error, ...(summary ? { summary } : {}) });

function idOf(body: unknown): string | null {
  const v = (body as Record<string, unknown> | null)?.id;
  return typeof v === "string" && v.length > 0 ? v : null;
}

function summarize(
  step: string,
  state: ThreadsState,
  outcome: GraphOutcome | null,
  extra: Record<string, string | number> = {},
  request: Record<string, unknown> = {},
): AttemptSummary {
  return {
    request: { step, mediaType: state.mediaType, ...request },
    response: { ...(outcome ? graphSummary(outcome) : {}), ...extra },
  };
}

/** A fresh state for a container that must be created again, or null when the cap is reached. */
function recreated(s: ThreadsState, count: number): ThreadsState | null {
  if (s.recreations >= MAX_RECREATIONS) return null;
  return { ...initialState(count), recreations: s.recreations + 1 };
}

function recreate(s: ThreadsState, count: number, why: string): StepResult {
  const next = recreated(s, count);
  if (!next) {
    return fatal(`Threads media expired before it could be published (tried ${MAX_RECREATIONS + 1} times). Retry the post.`, {
      response: { statusCode: why, recreations: s.recreations },
    });
  }
  return { kind: "continue", state: next, summary: { response: { statusCode: why, recreations: next.recreations } } };
}

/** Threads publishing: containers created, polled without sleeping, then one `threads_publish`. */
export async function advanceThreads(ctx: PublishContext): Promise<StepResult> {
  const creds = readThreadsCredentials(ctx.account.credentials);
  if (!creds) return { kind: "fatal_error", error: "The stored token is unreadable.", credentialsInvalid: true };
  const token = creds.accessToken;

  const { text, media } = ctx.content;
  const count = media.length;
  const expected = threadsStepFor(ctx.state, { text, mediaCount: count });
  if (expected.name !== ctx.step.name || expected.name === "invalid") return fatal("The post changed while publishing.");

  const state = validState(ctx.state, count) ?? initialState(count);
  const graph = threadsApp();
  const user = ctx.account.externalId;
  const name = ctx.step.name;
  const now = ctx.now;
  const call = (method: "GET" | "POST", path: string, params: Record<string, string>) =>
    graphRequest(graph, { method, path, params, token, signal: ctx.signal });
  const failure = (outcome: GraphOutcome, request: Record<string, unknown>) => {
    const err = graphStepError(outcome, { mayPublish: ctx.step.mayPublish, platform: PLATFORM, secrets: [token] });
    return err && { ...err, summary: summarize(name, state, outcome, {}, request) };
  };

  // --- create steps -------------------------------------------------------------------------
  if (name === "create_container" || name.startsWith("create_item_") || name === "create_carousel") {
    const params: Record<string, string> = {};
    const request: Record<string, unknown> = {};
    if (name === "create_carousel") {
      params.media_type = "CAROUSEL";
      params.children = state.items.join(",");
      if (text.length > 0) params.text = text;
    } else if (name === "create_container" && state.mediaType === "TEXT") {
      params.media_type = "TEXT";
      params.text = text;
    } else {
      const index = name === "create_container" ? 1 : Number(name.slice("create_item_".length));
      const item = media[index - 1];
      if (!item) return fatal("The post changed while publishing.");
      params.media_type = "IMAGE";
      params.image_url = item.url;
      if (name !== "create_container") {
        params.is_carousel_item = "true";
        request.imageIndex = index;
      } else if (text.length > 0) {
        params.text = text;
      }
      if (item.altText.trim().length > 0) params.alt_text = item.altText;
    }
    const outcome = await call("POST", `/${user}/threads`, params);
    const failed = failure(outcome, request);
    if (failed) {
      if (failed.kind === "fatal_error" && !failed.credentialsInvalid && /fetch|download|retriev|url/i.test(failed.error)) {
        return { ...failed, error: failed.error + URL_HINT };
      }
      return failed;
    }
    if (outcome.kind !== "ok") return fatal("Unexpected Threads response.");
    const id = idOf(outcome.body);
    const summary = summarize(name, state, outcome, id ? { containerId: id } : {}, request);
    if (!id) return { kind: "retryable_error", error: "Threads did not return a container id; trying again.", summary };
    if (name.startsWith("create_item_")) {
      return { kind: "continue", state: { ...state, items: [...state.items, id] } satisfies ThreadsState, summary };
    }
    return {
      kind: "continue",
      state: { ...state, container: id, createdAt: now.toISOString(), checks: 0, ready: false, quotaChecked: false } satisfies ThreadsState,
      notBefore: new Date(now.getTime() + FIRST_CHECK_DELAY_MS),
      summary,
    };
  }

  const container = state.container;
  if (!container) return fatal("The post changed while publishing.");

  // --- check_status -------------------------------------------------------------------------
  if (name === "check_status") {
    const outcome = await call("GET", `/${container}`, { fields: "status,error_message" });
    const failed = failure(outcome, { containerId: container });
    if (failed) return failed;
    if (outcome.kind !== "ok") return fatal("Unexpected Threads response.");
    const body = outcome.body as { status?: unknown; error_message?: unknown } | null;
    const code = body?.status;
    const summary = (statusCode: string) =>
      summarize(name, state, outcome, { statusCode, checks: state.checks, recreations: state.recreations }, { containerId: container });
    switch (code) {
      case "FINISHED":
        return { kind: "continue", state: { ...state, ready: true, checks: state.checks + 1 } satisfies ThreadsState, summary: summary("FINISHED") };
      case "IN_PROGRESS": {
        const created = state.createdAt ? Date.parse(state.createdAt) : now.getTime();
        if (now.getTime() - created >= PROCESSING_CAP_MS) {
          return fatal("Threads did not finish processing the post.", summary("IN_PROGRESS"));
        }
        return {
          kind: "continue",
          state: { ...state, checks: state.checks + 1 } satisfies ThreadsState,
          notBefore: new Date(now.getTime() + CHECK_INTERVAL_MS),
          summary: summary("IN_PROGRESS"),
        };
      }
      case "ERROR": {
        const reason = typeof body?.error_message === "string" ? scrub(body.error_message, [token]).trim() : "";
        return fatal(`Threads could not process the post${reason ? `: ${reason}` : " (status ERROR)"}.`.replace(/\.\.$/, "."), summary("ERROR"));
      }
      case "EXPIRED":
        return recreate(state, count, "EXPIRED");
      case "PUBLISHED":
        return { kind: "ambiguous", error: "Threads reports this post as already published.", summary: summary("PUBLISHED") };
      default:
        return { kind: "retryable_error", error: "Threads returned an unknown container status.", summary: summary("unknown") };
    }
  }

  // --- check_quota --------------------------------------------------------------------------
  if (name === "check_quota") {
    const created = state.createdAt ? Date.parse(state.createdAt) : now.getTime();
    if (now.getTime() - created >= CONTAINER_SAFE_AGE_MS) return recreate(state, count, "AGED");
    const outcome = await call("GET", `/${user}/threads_publishing_limit`, { fields: "quota_usage,config" });
    if (outcome.kind === "graph_error" && classifyGraphError(outcome.error) === "invalid_token") {
      return failure(outcome, {})!;
    }
    const reading = outcome.kind === "ok" ? readQuota(outcome.body) : null;
    if (!reading) {
      return {
        kind: "continue",
        state: { ...state, quotaChecked: true } satisfies ThreadsState,
        summary: summarize(name, state, outcome, { quota: "unknown" }),
      };
    }
    const summary = summarize(name, state, outcome, { quotaUsage: reading.usage, quotaTotal: reading.total });
    if (reading.usage >= reading.total) {
      return {
        kind: "retryable_error",
        error: `Threads' publishing limit is reached (${reading.usage} of ${reading.total}); trying again in an hour.`,
        notBefore: new Date(now.getTime() + QUOTA_RETRY_MS),
        summary,
      };
    }
    return { kind: "continue", state: { ...state, quotaChecked: true } satisfies ThreadsState, summary };
  }

  // --- publish ------------------------------------------------------------------------------
  if (name === "publish") {
    const outcome = await call("POST", `/${user}/threads_publish`, { creation_id: container });
    const failed = failure(outcome, { containerId: container });
    if (failed) {
      if (failed.kind === "fatal_error" && !failed.credentialsInvalid) return { ...failed, error: failed.error + RETRY_HINT };
      return failed;
    }
    if (outcome.kind !== "ok") return fatal("Unexpected Threads response.");
    const id = idOf(outcome.body);
    if (!id) {
      return {
        kind: "ambiguous",
        error: "Threads accepted the request but its reply could not be read.",
        summary: summarize(name, state, outcome, {}, { containerId: container }),
      };
    }
    return { kind: "done", externalId: id, summary: summarize(name, state, outcome, { externalId: id }, { containerId: container }) };
  }

  return fatal("The post changed while publishing.");
}
