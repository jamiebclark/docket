import { docsUrl } from "@/lib/docs";
import { graphRequest, DEFAULT_GRAPH_BASE, type GraphOutcome, type MetaApp } from "../meta/graph";
import { graphVersion } from "../meta/config";
import { readPageToken } from "../meta/credentials";
import { classifyGraphError, graphStepError, graphSummary } from "../meta/errors";
import type { AttemptSummary, PublishContext, StepResult } from "../types";
import { QUOTA_RETRY_MS, readQuota } from "./quota";
import { checkIntervalMs, FIRST_CHECK_DELAY_MS, CONTAINER_SAFE_AGE_MS, initialState, MAX_RECREATIONS, PROCESSING_CAP_MS, type InstagramState } from "./state";
import { instagramStepFor, validState } from "./steps";

const PLATFORM = "Instagram";
const URL_HINT = ` Images must be at a public URL (see ${docsUrl("storage")}).`;
const RETRY_HINT = " Retry the post to create the media again.";

const fatal = (error: string, summary?: AttemptSummary): StepResult => ({ kind: "fatal_error", error, ...(summary ? { summary } : {}) });

function idOf(body: unknown): string | null {
  const v = (body as Record<string, unknown> | null)?.id;
  return typeof v === "string" && v.length > 0 ? v : null;
}

function summarize(
  step: string,
  state: InstagramState,
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
function recreated(s: InstagramState): InstagramState | null {
  if (s.recreations >= MAX_RECREATIONS) return null;
  return {
    ...initialState(s.mediaType === "CAROUSEL" ? 2 : 1),
    recreations: s.recreations + 1,
  };
}

function recreate(s: InstagramState, why: string): StepResult {
  const next = recreated(s);
  if (!next) {
    return fatal(`Instagram media expired before it could be published (tried ${MAX_RECREATIONS + 1} times). Retry the post.`, {
      response: { statusCode: why, recreations: s.recreations },
    });
  }
  return { kind: "continue", state: next, summary: { response: { statusCode: why, recreations: next.recreations } } };
}

/** Instagram publishing: containers created, polled without sleeping, then one `media_publish`. */
export async function advanceInstagram(ctx: PublishContext, app?: MetaApp): Promise<StepResult> {
  const token = readPageToken(ctx.account.credentials);
  if (!token) return { kind: "fatal_error", error: "The stored token is unreadable.", credentialsInvalid: true };

  const { text, media } = ctx.content;
  const expected = instagramStepFor(ctx.state, { text, mediaCount: media.length });
  if (expected.name !== ctx.step.name || expected.name === "invalid") return fatal("The post changed while publishing.");

  const state = validState(ctx.state, media.length) ?? initialState(media.length);
  const graph = app ?? { graphBase: DEFAULT_GRAPH_BASE, version: graphVersion() };
  const ig = ctx.account.externalId;
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
      if (text.length > 0) params.caption = text;
    } else {
      const index = name === "create_container" ? 1 : Number(name.slice("create_item_".length));
      const item = media[index - 1];
      if (!item) return fatal("The post changed while publishing.");
      params.image_url = item.url;
      if (name !== "create_container") {
        params.is_carousel_item = "true";
        request.imageIndex = index;
      } else if (text.length > 0) {
        params.caption = text;
      }
      if (item.altText.trim().length > 0) params.alt_text = item.altText;
    }
    const outcome = await call("POST", `/${ig}/media`, params);
    const failed = failure(outcome, request);
    if (failed) {
      if (failed.kind === "fatal_error" && !failed.credentialsInvalid && /fetch|download|retriev|url/i.test(failed.error)) {
        return { ...failed, error: failed.error + URL_HINT };
      }
      return failed;
    }
    if (outcome.kind !== "ok") return fatal("Unexpected Instagram response.");
    const id = idOf(outcome.body);
    const summary = summarize(name, state, outcome, id ? { containerId: id } : {}, request);
    if (!id) return { kind: "retryable_error", error: "Instagram did not return a media id; trying again.", summary };
    if (name.startsWith("create_item_")) {
      return { kind: "continue", state: { ...state, items: [...state.items, id] } satisfies InstagramState, summary };
    }
    return {
      kind: "continue",
      state: { ...state, container: id, createdAt: now.toISOString(), checks: 0, ready: false, quotaChecked: false } satisfies InstagramState,
      notBefore: new Date(now.getTime() + FIRST_CHECK_DELAY_MS),
      summary,
    };
  }

  const container = state.container;
  if (!container) return fatal("The post changed while publishing.");

  // --- check_status -------------------------------------------------------------------------
  if (name === "check_status") {
    const outcome = await call("GET", `/${container}`, { fields: "status_code" });
    const failed = failure(outcome, { containerId: container });
    if (failed) return failed;
    if (outcome.kind !== "ok") return fatal("Unexpected Instagram response.");
    const code = (outcome.body as { status_code?: unknown } | null)?.status_code;
    const summary = (statusCode: string) =>
      summarize(name, state, outcome, { statusCode, checks: state.checks, recreations: state.recreations }, { containerId: container });
    switch (code) {
      case "FINISHED":
        return { kind: "continue", state: { ...state, ready: true, checks: state.checks + 1 } satisfies InstagramState, summary: summary("FINISHED") };
      case "IN_PROGRESS": {
        const created = state.createdAt ? Date.parse(state.createdAt) : now.getTime();
        if (now.getTime() - created >= PROCESSING_CAP_MS) {
          return fatal("Instagram did not finish processing the media.", summary("IN_PROGRESS"));
        }
        return {
          kind: "continue",
          state: { ...state, checks: state.checks + 1 } satisfies InstagramState,
          notBefore: new Date(now.getTime() + checkIntervalMs(state.checks)),
          summary: summary("IN_PROGRESS"),
        };
      }
      case "ERROR":
        return fatal("Instagram could not process the media (status ERROR).", summary("ERROR"));
      case "EXPIRED":
        return recreate(state, "EXPIRED");
      case "PUBLISHED":
        return { kind: "ambiguous", error: "Instagram reports this media as already published.", summary: summary("PUBLISHED") };
      default:
        return { kind: "retryable_error", error: "Instagram returned an unknown media status.", summary: summary("unknown") };
    }
  }

  // --- check_quota --------------------------------------------------------------------------
  if (name === "check_quota") {
    const created = state.createdAt ? Date.parse(state.createdAt) : now.getTime();
    if (now.getTime() - created >= CONTAINER_SAFE_AGE_MS) return recreate(state, "AGED");
    const outcome = await call("GET", `/${ig}/content_publishing_limit`, { fields: "quota_usage,config" });
    if (outcome.kind === "graph_error" && classifyGraphError(outcome.error) === "invalid_token") {
      return failure(outcome, {})!;
    }
    const reading = outcome.kind === "ok" ? readQuota(outcome.body) : null;
    if (!reading) {
      return {
        kind: "continue",
        state: { ...state, quotaChecked: true } satisfies InstagramState,
        summary: summarize(name, state, outcome, { quota: "unknown" }),
      };
    }
    const summary = summarize(name, state, outcome, { quotaUsage: reading.usage, quotaTotal: reading.total });
    if (reading.usage >= reading.total) {
      return {
        kind: "retryable_error",
        error: `Instagram's publishing limit is reached (${reading.usage} of ${reading.total}); trying again in an hour.`,
        notBefore: new Date(now.getTime() + QUOTA_RETRY_MS),
        summary,
      };
    }
    return { kind: "continue", state: { ...state, quotaChecked: true } satisfies InstagramState, summary };
  }

  // --- publish ------------------------------------------------------------------------------
  if (name === "publish") {
    const outcome = await call("POST", `/${ig}/media_publish`, { creation_id: container });
    const failed = failure(outcome, { containerId: container });
    if (failed) {
      if (failed.kind === "fatal_error" && !failed.credentialsInvalid) return { ...failed, error: failed.error + RETRY_HINT };
      return failed;
    }
    if (outcome.kind !== "ok") return fatal("Unexpected Instagram response.");
    const id = idOf(outcome.body);
    if (!id) {
      return {
        kind: "ambiguous",
        error: "Instagram accepted the request but its reply could not be read.",
        summary: summarize(name, state, outcome, {}, { containerId: container }),
      };
    }
    return { kind: "done", externalId: id, summary: summarize(name, state, outcome, { externalId: id }, { containerId: container }) };
  }

  return fatal("The post changed while publishing.");
}
