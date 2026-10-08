import { docsUrl } from "@/lib/docs";
import { graphRequest, ruploadRequest, DEFAULT_GRAPH_BASE, type GraphOutcome, type MetaApp } from "../meta/graph";
import { graphVersion } from "../meta/config";
import { readPageToken } from "../meta/credentials";
import { graphStepError, graphSummary, scrub } from "../meta/errors";
import type { PublishContext, StepResult } from "../types";
import { firstUrl } from "./links";
import {
  checkUploadUrl,
  pageVideoParams,
  publishState,
  readReelStatus,
  reelFinishParams,
  reelStartParams,
  reelStatusParams,
  ruploadHeaders,
  uploadState,
} from "./requests";
import { facebookStateSchema, type PhotoState, type ReelState } from "./settings";
import { checkDelayMs, CHECK_FIRST_MS, PUBLISH_CEILING_MS, UPLOAD_CEILING_MS, validReelState } from "./state";
import { facebookStepFor } from "./steps";

const PHOTO_SUFFIX = ` Images must be at a public URL (see ${docsUrl("storage")}).`;
const VIDEO_SUFFIX = ` Facebook could not fetch the video. Media storage must be publicly readable (see ${docsUrl("storage")}).`;

const RECEIVE_SUFFIX = ` Nothing was published. Media storage must be publicly readable (see ${docsUrl("storage")}).`;
const PROCESS_HINT = " Check its shape (9:16), length (3–90 s), frame rate (24–60 fps), resolution (at least 540 × 960) and codec.";

const fatal = (error: string, extra: Partial<Extract<StepResult, { kind: "fatal_error" }>> = {}): StepResult => ({
  kind: "fatal_error",
  error,
  ...extra,
});

function idOf(body: unknown, key: "id" | "post_id" = "id"): string | null {
  const v = (body as Record<string, unknown> | null)?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Facebook publishing: text/link, one photo, or N unpublished photos attached to one feed post. */
export async function advanceFacebook(ctx: PublishContext, app?: MetaApp): Promise<StepResult> {
  const token = readPageToken(ctx.account.credentials);
  if (!token) {
    // After a Reel was started the post may be live: the credentials are flagged, but the target is not failed (G23).
    if (ctx.step.afterPublish) {
      return { kind: "ambiguous", error: "The stored token is unreadable. The post may already be live; check before retrying.", credentialsInvalid: true };
    }
    return fatal("The stored token is unreadable.", { credentialsInvalid: true });
  }

  const text = ctx.content.text;
  const media = ctx.content.media;
  const parsedState = ctx.state === null ? null : facebookStateSchema.safeParse(ctx.state);
  const state: PhotoState | null = parsedState?.success && "photoIds" in parsedState.data ? parsedState.data : null;
  const kinds = media.map((m) => m.kind ?? "image");
  const expected = facebookStepFor(ctx.state, { text, mediaCount: media.length, kinds, postType: ctx.postType });
  if (expected.name === "invalid" && expected.afterPublish) {
    return {
      kind: "ambiguous",
      error: "Docket could not read this Reel's saved progress; check the Page before retrying.",
      summary: { request: { step: "invalid", kind: "reel" } },
    };
  }
  if (expected.name === "invalid" || (expected.name !== ctx.step.name && expected.name !== "check_publish")) {
    return fatal("The post changed while publishing.");
  }

  const graph = app ?? { graphBase: DEFAULT_GRAPH_BASE, version: graphVersion() };
  if (expected.name.endsWith("_reel") || expected.name === "check_upload" || expected.name === "check_publish") {
    return advanceReel(ctx, graph, token, expected.name, validReelState(ctx.state));
  }
  const page = ctx.account.externalId;
  const name = ctx.step.name;
  const photoIds = state?.photoIds ?? [];

  let path = `/${page}/feed`;
  const params: Record<string, string> = {};
  let upload: number | null = null;
  if (name === "publish_video") {
    path = `/${page}/videos`;
    Object.assign(params, pageVideoParams(media[0]!, text));
  } else if (name === "publish_photo") {
    path = `/${page}/photos`;
    params.url = media[0]!.url;
    if (text.length > 0) params.caption = text;
  } else if (name.startsWith("upload_photo_")) {
    upload = Number(name.slice("upload_photo_".length));
    const item = media[upload - 1];
    if (!item) return fatal("The post changed while publishing.");
    path = `/${page}/photos`;
    params.url = item.url;
    params.published = "false";
  } else if (media.length >= 2) {
    if (text.length > 0) params.message = text;
    params.attached_media = JSON.stringify(photoIds.map((id) => ({ media_fbid: id })));
  } else {
    if (text.length > 0) params.message = text;
    const link = firstUrl(text);
    if (link) params.link = link;
  }

  const outcome = await graphRequest(graph, { method: "POST", path, params, token, signal: ctx.signal });
  const isPhotoStep = path.endsWith("/photos");
  const failure = graphStepError(outcome, { mayPublish: ctx.step.mayPublish, platform: "Facebook", secrets: [token] });
  if (failure) {
    if (isPhotoStep && failure.kind === "fatal_error" && !failure.credentialsInvalid) {
      return { ...failure, error: failure.error + PHOTO_SUFFIX };
    }
    if (name === "publish_video" && failure.kind === "fatal_error" && !failure.credentialsInvalid && outcome.kind === "graph_error" && outcome.error.code === 389) {
      return { ...failure, error: failure.error + VIDEO_SUFFIX };
    }
    return failure;
  }
  if (outcome.kind !== "ok") return fatal("Unexpected Facebook response.");
  const summary = { response: graphSummary(outcome) };

  if (upload !== null) {
    const id = idOf(outcome.body);
    if (!id) return { kind: "retryable_error", error: "Facebook did not return a photo id; trying again.", summary };
    return { kind: "continue", state: { v: 1, photoIds: [...photoIds, id] } satisfies PhotoState, summary };
  }
  const id = name === "publish_photo" ? (idOf(outcome.body, "post_id") ?? idOf(outcome.body)) : idOf(outcome.body);
  if (!id) {
    return { kind: "ambiguous", error: "Facebook accepted the request but its reply could not be read.", summary };
  }
  return { kind: "done", externalId: id, summary };
}

const ageMs = (now: Date, since: string | null): number => (since === null ? 0 : now.getTime() - Date.parse(since));

/** The request-side summary of a Reel step (never the token, the upload address or the Authorization header). */
function reelRequest(name: string, videoId: string | undefined, extra: Record<string, string> = {}): Record<string, unknown> {
  return { step: name, kind: "reel", ...(videoId ? { videoId } : {}), ...extra };
}

function withRequest(result: StepResult, request: Record<string, unknown>, response: Record<string, unknown> = {}): StepResult {
  return { ...result, summary: { request, response: { ...(result.summary?.response ?? {}), ...response } } };
}

/** Status fields of a read, plus the check count; null values omitted, the detail scrubbed. */
function statusSummary(outcome: GraphOutcome, token: string, checks: number): Record<string, unknown> {
  const out: Record<string, unknown> = { ...graphSummary(outcome), checks };
  if (outcome.kind !== "ok") return out;
  const r = readReelStatus(outcome.body);
  const fields = {
    videoStatus: r.videoStatus,
    uploadingStatus: r.uploading,
    processingStatus: r.processing,
    publishingStatus: r.publishing,
    publishStatus: r.publishStatus,
  };
  for (const [k, v] of Object.entries(fields)) if (v !== null) out[k] = v;
  if (r.detail !== null) out.statusDetail = scrub(r.detail, [token]).slice(0, 300);
  return out;
}

async function advanceReel(ctx: PublishContext, graph: MetaApp, token: string, name: string, state: ReelState | null): Promise<StepResult> {
  const page = ctx.account.externalId;
  const now = ctx.now;
  const opts = { mayPublish: ctx.step.mayPublish, platform: "Facebook", secrets: [token] } as const;

  if (name === "start_reel") {
    const request = reelRequest(name, undefined);
    const outcome = await graphRequest(graph, { method: "POST", path: `/${page}/video_reels`, params: reelStartParams(), token, signal: ctx.signal });
    const failure = graphStepError(outcome, { ...opts, mayPublish: false });
    if (failure) return withRequest(failure, request);
    const body = outcome.kind === "ok" ? (outcome.body as Record<string, unknown> | null) : null;
    const videoId = body?.video_id;
    const uploadUrl = body?.upload_url;
    const summary = { response: graphSummary(outcome) };
    if (typeof videoId !== "string" || !/^\d{1,40}$/.test(videoId) || typeof uploadUrl !== "string" || uploadUrl.length > 500) {
      return withRequest({ kind: "retryable_error", error: "Facebook did not return a Reel upload address; trying again.", summary }, request);
    }
    const next: ReelState = {
      v: 1, kind: "reel", videoId, uploadUrl, startedAt: now.toISOString(),
      uploadedAt: null, uploadComplete: false, uploadChecks: 0, finishedAt: null, publishChecks: 0,
    };
    return withRequest({ kind: "continue", state: next, summary }, reelRequest(name, videoId));
  }

  if (!state) return fatal("The post changed while publishing.");
  const request = reelRequest(name, state.videoId);

  if (name === "upload_reel") {
    const url = checkUploadUrl(state.uploadUrl, state.videoId, graph.uploadHost);
    if (!url) return withRequest(fatal("Facebook returned an unexpected upload address; nothing was sent or published."), request);
    const outcome = await ruploadRequest({ url, token, headers: ruploadHeaders(ctx.content.media[0]!.url), signal: ctx.signal });
    const req = reelRequest(name, state.videoId, { uploadHost: url.hostname });
    const response = graphSummary(outcome);
    const retry = (): StepResult =>
      withRequest({ kind: "retryable_error", error: "Facebook: the video upload did not go through; trying again." }, req, response);
    if (outcome.kind === "ok" || outcome.kind === "unparseable") {
      if (outcome.status >= 200 && outcome.status < 300) {
        const next: ReelState = { ...state, uploadedAt: now.toISOString() };
        return withRequest({ kind: "continue", state: next, notBefore: new Date(now.getTime() + CHECK_FIRST_MS) }, req, response);
      }
    }
    if (outcome.kind === "network") return retry();
    if (outcome.kind !== "ok" && outcome.kind !== "unparseable" && (outcome.status >= 500 || outcome.status === 429)) return retry();
    if (outcome.kind === "graph_error" && outcome.error.code === 190) {
      return withRequest(
        { kind: "fatal_error", error: "Facebook says the access token is no longer valid (code 190).", credentialsInvalid: true },
        req,
        response,
      );
    }
    const detail = outcome.kind === "graph_error" ? `: ${scrub(outcome.error.message, [token])}` : "";
    return withRequest(fatal(`Facebook could not receive the video${detail}.${RECEIVE_SUFFIX}`), req, response);
  }

  if (name === "finish_reel") {
    const outcome = await graphRequest(graph, {
      method: "POST",
      path: `/${page}/video_reels`,
      params: reelFinishParams(state.videoId, ctx.content.text),
      token,
      signal: ctx.signal,
    });
    const failure = graphStepError(outcome, opts);
    if (failure) return withRequest(failure, request);
    const summary = { response: graphSummary(outcome) };
    const success = outcome.kind === "ok" && (outcome.body as { success?: unknown } | null)?.success === true;
    if (!success) {
      return withRequest(
        { kind: "ambiguous", error: "Facebook accepted the Reel but its reply could not be read; check the Page before retrying.", summary },
        request,
      );
    }
    const next: ReelState = { ...state, finishedAt: now.toISOString(), publishChecks: 0 };
    return withRequest({ kind: "continue", state: next, notBefore: new Date(now.getTime() + CHECK_FIRST_MS), summary }, request);
  }

  // check_upload and check_publish: read the status.
  const publishing = name === "check_publish";
  const since = publishing ? state.finishedAt : state.uploadedAt;
  const age = ageMs(now, since);
  const checks = (publishing ? state.publishChecks : state.uploadChecks) + 1;
  const outcome = await graphRequest(graph, { method: "GET", path: `/${state.videoId}`, params: reelStatusParams(), token, signal: ctx.signal });
  const response = statusSummary(outcome, token, checks);
  const pending = (): StepResult => {
    if (publishing && age >= PUBLISH_CEILING_MS) {
      return withRequest(
        { kind: "ambiguous", error: "Facebook accepted the Reel but did not confirm it was published within 60 minutes; check the Page before retrying." },
        request,
        response,
      );
    }
    if (!publishing && age >= UPLOAD_CEILING_MS) {
      return withRequest(fatal("Facebook did not receive the video within 30 minutes; nothing was published."), request, response);
    }
    const next: ReelState = publishing ? { ...state, publishChecks: checks } : { ...state, uploadChecks: checks };
    return withRequest({ kind: "continue", state: next, notBefore: new Date(now.getTime() + checkDelayMs(age)) }, request, response);
  };

  if (outcome.kind === "graph_error" && outcome.error.code === 190) {
    if (publishing) {
      return withRequest(
        {
          kind: "ambiguous",
          error: "Facebook rejected the Page token after the Reel was sent; check the Page before retrying.",
          credentialsInvalid: true,
        },
        request,
        response,
      );
    }
    return withRequest(graphStepError(outcome, { ...opts, mayPublish: false })!, request, response);
  }
  if (outcome.kind === "ok") {
    const r = readReelStatus(outcome.body);
    const detail = r.detail !== null ? `: ${scrub(r.detail, [token]).slice(0, 300)}` : "";
    if (publishing) {
      const c = publishState(r);
      if (c === "published") return withRequest({ kind: "done", externalId: state.videoId }, request, response);
      if (c === "failed") {
        return withRequest(fatal(`Facebook could not process the Reel and it was not published${detail}.${PROCESS_HINT}`), request, response);
      }
      return pending();
    }
    const c = uploadState(r);
    if (c === "complete") {
      return withRequest({ kind: "continue", state: { ...state, uploadComplete: true, uploadChecks: checks } satisfies ReelState }, request, response);
    }
    if (c === "failed") return withRequest(fatal(`Facebook could not receive the video${detail}.${RECEIVE_SUFFIX}`), request, response);
    return pending();
  }
  if (publishing) return pending();
  const failure = graphStepError(outcome, { ...opts, mayPublish: false });
  return failure && failure.kind !== "retryable_error" ? withRequest(failure, request, response) : pending();
}
