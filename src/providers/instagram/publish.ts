import { docsUrl } from "@/lib/docs";
import { graphRequest, DEFAULT_GRAPH_BASE, type GraphOutcome, type MetaApp } from "../meta/graph";
import { graphVersion } from "../meta/config";
import { readPageToken } from "../meta/credentials";
import { classifyGraphError, graphStepError, graphSummary, scrub } from "../meta/errors";
import type { AttemptSummary, PublishContext, StepResult } from "../types";
import { QUOTA_RETRY_MS, readQuota } from "./quota";
import { IMAGE_STATUS_FIELDS, itemParams, reelContainerParams, VIDEO_STATUS_FIELDS } from "./requests";
import {
  checkIntervalMs,
  FIRST_CHECK_DELAY_MS,
  CONTAINER_SAFE_AGE_MS,
  initialState,
  MAX_RECREATIONS,
  PROCESSING_CAP_MS,
  VIDEO_FIRST_CHECK_DELAY_MS,
  videoCheckDelayMs,
  type InstagramState,
} from "./state";
import { instagramStepFor, planOf, validState } from "./steps";

const PLATFORM = "Instagram";
const URL_HINT = ` Images must be at a public URL (see ${docsUrl("storage")}).`;
const VIDEO_URL_HINT = ` Media must be at a public URL (see ${docsUrl("storage")}).`;
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

/** What Instagram said about a failed video, read defensively: a string, no control characters, at most 300 characters. */
function statusDetail(body: unknown): string {
  const v = (body as { status?: unknown } | null)?.status;
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001f\u007f]+/g, "").trim().slice(0, 300).trim();
}

/** A fresh state for a container that must be created again, keeping the plan, or null when the cap is reached. */
function recreated(s: InstagramState): InstagramState | null {
  if (s.recreations >= MAX_RECREATIONS) return null;
  return {
    ...initialState({ mediaType: s.mediaType, shareToFeed: s.shareToFeed, kinds: s.kinds }),
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
  const kinds = media.map((m) => m.kind ?? "image");
  const expected = instagramStepFor(ctx.state, { text, mediaCount: media.length, kinds, postType: ctx.postType });
  const plan = planOf({ mediaCount: media.length, kinds, postType: ctx.postType });
  if (!plan || expected.name !== ctx.step.name || expected.name === "invalid") return fatal("The post changed while publishing.");

  const state = validState(ctx.state, plan) ?? initialState(plan);
  const hasVideo = kinds.includes("video");
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
      if (plan.mediaType === "REELS") {
        Object.assign(params, reelContainerParams(item, text, plan.shareToFeed === true));
        request.shareToFeed = plan.shareToFeed === true;
      } else if (name !== "create_container") {
        Object.assign(params, itemParams(kinds[index - 1]!, item));
        request.itemIndex = index;
        request.itemKind = kinds[index - 1];
        if (kinds[index - 1] !== "video") request.imageIndex = index;
      } else {
        params.image_url = item.url;
        if (text.length > 0) params.caption = text;
        if (item.altText.trim().length > 0) params.alt_text = item.altText;
      }
    }
    const outcome = await call("POST", `/${ig}/media`, params);
    const failed = failure(outcome, request);
    if (failed) {
      if (failed.kind === "fatal_error" && !failed.credentialsInvalid && /fetch|download|retriev|url/i.test(failed.error)) {
        return { ...failed, error: failed.error + (hasVideo ? VIDEO_URL_HINT : URL_HINT) };
      }
      return failed;
    }
    if (outcome.kind !== "ok") return fatal("Unexpected Instagram response.");
    const id = idOf(outcome.body);
    const summary = summarize(name, state, outcome, id ? { containerId: id } : {}, request);
    if (!id) return { kind: "retryable_error", error: "Instagram did not return a media id; trying again.", summary };
    if (name.startsWith("create_item_")) {
      const index = Number(name.slice("create_item_".length));
      const isVideo = kinds[index - 1] === "video";
      const next: InstagramState = { ...state, items: [...state.items, id] };
      if (!hasVideo) return { kind: "continue", state: next, summary };
      next.itemProgress = [...(state.itemProgress ?? []), { createdAt: now.toISOString(), checks: 0, ready: !isVideo }];
      const last = index === kinds.length;
      const wait = last && next.itemProgress.some((p) => !p.ready);
      return { kind: "continue", state: next, ...(wait ? { notBefore: new Date(now.getTime() + VIDEO_FIRST_CHECK_DELAY_MS) } : {}), summary };
    }
    return {
      kind: "continue",
      state: { ...state, container: id, createdAt: now.toISOString(), checks: 0, ready: false, quotaChecked: false } satisfies InstagramState,
      notBefore: new Date(now.getTime() + (hasVideo ? VIDEO_FIRST_CHECK_DELAY_MS : FIRST_CHECK_DELAY_MS)),
      summary,
    };
  }

  // --- check_item_<k> (a video item, polled before the carousel is created) -----------------
  if (name.startsWith("check_item_")) {
    const index = Number(name.slice("check_item_".length));
    const itemId = state.items[index - 1];
    const progress = state.itemProgress?.[index - 1];
    if (!itemId || !progress) return fatal("The post changed while publishing.");
    const request = { itemIndex: index, itemKind: "video", containerId: itemId };
    const outcome = await call("GET", `/${itemId}`, { fields: VIDEO_STATUS_FIELDS });
    const failed = failure(outcome, request);
    if (failed) return failed;
    if (outcome.kind !== "ok") return fatal("Unexpected Instagram response.");
    const code = (outcome.body as { status_code?: unknown } | null)?.status_code;
    const detail = scrub(statusDetail(outcome.body), [token]);
    const summary = (statusCode: string) =>
      summarize(name, state, outcome, { statusCode, checks: progress.checks, recreations: state.recreations, ...(detail ? { statusDetail: detail } : {}) }, request);
    const withProgress = (p: { createdAt: string; checks: number; ready: boolean }): InstagramState => ({
      ...state,
      itemProgress: (state.itemProgress ?? []).map((q, i) => (i === index - 1 ? p : q)),
    });
    switch (code) {
      case "FINISHED":
        return { kind: "continue", state: withProgress({ ...progress, ready: true, checks: progress.checks + 1 }), summary: summary("FINISHED") };
      case "IN_PROGRESS": {
        const age = now.getTime() - Date.parse(progress.createdAt);
        if (age >= PROCESSING_CAP_MS) {
          return fatal(
            "Instagram did not finish processing the video within 60 minutes; nothing was published. Retry the post to try again.",
            summary("IN_PROGRESS"),
          );
        }
        return {
          kind: "continue",
          state: withProgress({ ...progress, checks: progress.checks + 1 }),
          notBefore: new Date(now.getTime() + videoCheckDelayMs(age)),
          summary: summary("IN_PROGRESS"),
        };
      }
      case "ERROR": {
        const why = detail ? `: ${detail.replace(/\.+$/, "")}` : "";
        return fatal(
          `Instagram could not process video ${index} of the carousel (item ${index})${why}. Check its format, codec, frame rate and bitrate; nothing was published.`,
          summary("ERROR"),
        );
      }
      case "EXPIRED":
        return recreate(state, "EXPIRED");
      case "PUBLISHED":
        return { kind: "ambiguous", error: "Instagram reports this media as already published.", summary: summary("PUBLISHED") };
      default:
        return { kind: "retryable_error", error: "Instagram returned an unknown media status.", summary: summary("unknown") };
    }
  }

  const container = state.container;
  if (!container) return fatal("The post changed while publishing.");

  // --- check_status -------------------------------------------------------------------------
  if (name === "check_status") {
    const outcome = await call("GET", `/${container}`, { fields: hasVideo ? VIDEO_STATUS_FIELDS : IMAGE_STATUS_FIELDS });
    const failed = failure(outcome, { containerId: container });
    if (failed) return failed;
    if (outcome.kind !== "ok") return fatal("Unexpected Instagram response.");
    const code = (outcome.body as { status_code?: unknown } | null)?.status_code;
    const detail = hasVideo ? scrub(statusDetail(outcome.body), [token]) : "";
    const summary = (statusCode: string) =>
      summarize(
        name,
        state,
        outcome,
        { statusCode, checks: state.checks, recreations: state.recreations, ...(detail ? { statusDetail: detail } : {}) },
        { containerId: container, ...(plan.mediaType === "REELS" ? { shareToFeed: plan.shareToFeed === true } : {}) },
      );
    switch (code) {
      case "FINISHED":
        return { kind: "continue", state: { ...state, ready: true, checks: state.checks + 1 } satisfies InstagramState, summary: summary("FINISHED") };
      case "IN_PROGRESS": {
        const created = state.createdAt ? Date.parse(state.createdAt) : now.getTime();
        if (now.getTime() - created >= PROCESSING_CAP_MS) {
          return fatal(
            hasVideo
              ? "Instagram did not finish processing the video within 60 minutes; nothing was published. Retry the post to try again."
              : "Instagram did not finish processing the media.",
            summary("IN_PROGRESS"),
          );
        }
        return {
          kind: "continue",
          state: { ...state, checks: state.checks + 1 } satisfies InstagramState,
          notBefore: new Date(now.getTime() + (hasVideo ? videoCheckDelayMs(now.getTime() - created) : checkIntervalMs(state.checks))),
          summary: summary("IN_PROGRESS"),
        };
      }
      case "ERROR": {
        if (!hasVideo) return fatal("Instagram could not process the media (status ERROR).", summary("ERROR"));
        const why = detail ? `: ${detail.replace(/\.+$/, "")}` : "";
        const what = plan.mediaType === "REELS" ? "the video" : "the carousel";
        const check = plan.mediaType === "REELS" ? "Check its format" : "Check each video's format";
        return fatal(`Instagram could not process ${what}${why}. ${check}, codec, frame rate and bitrate; nothing was published.`, summary("ERROR"));
      }
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
    // The oldest container counts: a carousel's video items were created before the carousel itself.
    const created = Math.min(
      state.createdAt ? Date.parse(state.createdAt) : now.getTime(),
      ...(state.itemProgress ?? []).map((p) => Date.parse(p.createdAt)),
    );
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
