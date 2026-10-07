import type { AttemptSummary, PublishContext, StepResult } from "../types";
import {
  X_DEFAULT_CHECK_AFTER_SECONDS,
  X_DEFAULT_MEDIA_EXPIRY_SECONDS,
  X_MAX_CHECK_AFTER_SECONDS,
  X_MAX_STATUS_CHECKS,
  X_MEDIA_EXPIRY_MARGIN_MS,
  X_USAGE_CAP_WAIT_MS,
} from "./config";
import { X_MAX_BYTES_PER_FILE, xCapabilities } from "./capabilities";
import { readXCredentials, type XCredentials } from "./credentials";
import { problemText, scrubX, xRequest, type XOutcome } from "./http";
import { postUrl, xSettingsSchema } from "./settings";
import { parseXState, type XState, type XStateImage } from "./state";
import { xStepFor } from "./steps";
import { countXText } from "./text";

const retryable = (error: string): StepResult => ({ kind: "retryable_error", error });
const fatal = (error: string): StepResult => ({ kind: "fatal_error", error });

/** Allow-listed, non-secret keys only (data-model §6). */
function summarise(request: Record<string, unknown>, out?: XOutcome, secrets: readonly string[] = [], now?: Date): AttemptSummary {
  const response: Record<string, unknown> = {};
  if (out && out.kind !== "network") {
    response.status = out.status;
    if (out.rate.remaining !== null) response.rateLimitRemaining = out.rate.remaining;
    if (out.kind === "http_error" && out.status === 429 && out.rate.resetAtMs !== null && now) {
      response.retryAfterSeconds = Math.max(0, Math.round((out.rate.resetAtMs - now.getTime()) / 1000));
    }
    if (out.kind === "http_error" && out.body && typeof out.body === "object") {
      const title = (out.body as { title?: unknown }).title;
      if (typeof title === "string" && title) response.problemTitle = scrubX(title, secrets);
    }
  }
  return { request, ...(Object.keys(response).length ? { response } : {}) };
}

function dataId(body: unknown): string | null {
  const data = body && typeof body === "object" ? (body as { data?: unknown }).data : null;
  const id = data && typeof data === "object" ? (data as { id?: unknown }).id : null;
  return typeof id === "string" && id ? id : null;
}

/** The 429 rule (research D4): an exhausted window waits for its reset; anything else is treated as a usage cap. */
function rateLimitedResult(out: Extract<XOutcome, { kind: "http_error" }>, now: Date): StepResult {
  const { remaining, resetAtMs } = out.rate;
  if (remaining === 0 && resetAtMs !== null) {
    return { kind: "retryable_error", error: "X's rate limit was reached; will retry after it resets.", notBefore: new Date(Math.max(resetAtMs, now.getTime())) };
  }
  const floor = now.getTime() + X_USAGE_CAP_WAIT_MS;
  return {
    kind: "retryable_error",
    error: "X's rate limit or usage cap was reached (credits or the spending limit may be exhausted); will retry later.",
    notBefore: new Date(Math.max(resetAtMs ?? 0, floor)),
  };
}

async function createPost(ctx: PublishContext, creds: XCredentials, state: XState | null, settings: ReturnType<typeof xSettingsSchema.parse>): Promise<StepResult> {
  const secrets = [creds.accessToken, creds.refreshToken];
  const mediaCount = ctx.content.media.length;
  const images = mediaCount > 0 && state ? state.images : [];

  // A media id that would expire before X reads it is uploaded again; no request is sent for this decision (research D3).
  const stale = images.findIndex((img) => img.expiresAt - ctx.now.getTime() < X_MEDIA_EXPIRY_MARGIN_MS);
  if (state && stale >= 0) {
    return { kind: "continue", state: { ...state, images: images.slice(0, stale) } satisfies XState };
  }

  const text = ctx.content.text;
  const hasText = text.trim().length > 0;
  const json: Record<string, unknown> = {};
  if (hasText || images.length === 0) json.text = text;
  if (images.length > 0) json.media = { media_ids: images.map((i) => i.mediaId) };
  const request = { step: "create_post", images: images.length, textUnits: countXText(text), hasText };

  const out = await xRequest({ method: "POST", path: "/2/tweets", auth: { kind: "bearer", token: creds.accessToken }, json, signal: ctx.signal });
  const summary = summarise(request, out, secrets, ctx.now);

  switch (out.kind) {
    case "network":
      return out.phase === "not_sent"
        ? { ...retryable("Could not reach X; nothing was sent. Will retry."), summary }
        : { kind: "ambiguous", error: "The connection to X was lost after the post was sent. Check the X profile.", summary };
    case "unparseable":
      return { kind: "ambiguous", error: "X answered without a usable post id. Check the X profile before retrying.", summary };
    case "ok": {
      const id = dataId(out.body);
      if (!id) return { kind: "ambiguous", error: "X answered without a usable post id. Check the X profile before retrying.", summary };
      return { kind: "done", externalId: id, url: postUrl(settings, id), summary };
    }
    case "http_error": {
      const { status } = out;
      if (status >= 500) {
        return { kind: "ambiguous", error: `X answered with a server error (HTTP ${status}) after the post was sent. Check the X profile.`, summary };
      }
      if (status === 401) return { kind: "retryable_error", error: "X rejected the sign-in; will renew it and retry.", credentialsExpired: true, summary };
      if (status === 429) return { ...rateLimitedResult(out, ctx.now), summary };
      const detail = problemText(out.body, secrets) ?? `HTTP ${status}`;
      if (status === 403) {
        return { ...fatal(/duplicate/i.test(detail) ? "X refused this as a duplicate of a recent post." : `X refused the post: ${detail}`), summary };
      }
      if (status >= 400) return { ...fatal(`X refused the post: ${detail}`), summary };
      // A non-error status that is not a 2xx: the post may have gone out.
      return { kind: "ambiguous", error: `X answered unexpectedly (HTTP ${status}). Check the X profile before retrying.`, summary };
    }
  }
}

const ALT_MAX = 1000;
const imageIndex = (step: string): number => Number(step.slice(step.lastIndexOf("_") + 1));

/** A failed request on a step that does not publish: nothing public happened, so only a 4xx is fatal. */
function stepFailure(out: Exclude<XOutcome, { kind: "ok" }>, ctx: PublishContext, secrets: readonly string[], request: Record<string, unknown>, what: string): StepResult {
  const summary = summarise(request, out, secrets, ctx.now);
  if (out.kind === "network") return { ...retryable(`Could not reach X while ${what}; will retry.`), summary };
  if (out.kind === "unparseable") return { ...retryable(`X answered ${what} without a usable reply; will retry.`), summary };
  const { status } = out;
  if (status === 401) return { kind: "retryable_error", error: "X rejected the sign-in; will renew it and retry.", credentialsExpired: true, summary };
  if (status === 429) return { ...rateLimitedResult(out, ctx.now), summary };
  if (status >= 500 || status < 400) return { ...retryable(`X answered with a server error (HTTP ${status}) while ${what}; will retry.`), summary };
  return { ...fatal(`X refused ${what}: ${problemText(out.body, secrets) ?? `HTTP ${status}`}`), summary };
}

function secondsOf(v: unknown, fallback: number, max: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), max) : fallback;
}

interface ProcessingInfo {
  state: string | null;
  checkAfter: number;
}
function processingInfo(body: unknown): ProcessingInfo | null {
  const data = body && typeof body === "object" ? (body as { data?: unknown }).data : null;
  const info = data && typeof data === "object" ? (data as { processing_info?: unknown }).processing_info : null;
  if (!info || typeof info !== "object") return null;
  const { state, check_after_secs } = info as { state?: unknown; check_after_secs?: unknown };
  return { state: typeof state === "string" ? state : null, checkAfter: secondsOf(check_after_secs, X_DEFAULT_CHECK_AFTER_SECONDS, X_MAX_CHECK_AFTER_SECONDS) };
}

async function uploadImage(ctx: PublishContext, creds: XCredentials, state: XState | null): Promise<StepResult> {
  const secrets = [creds.accessToken, creds.refreshToken];
  const k = imageIndex(ctx.step.name);
  const item = ctx.content.media[k - 1];
  const n = ctx.content.media.length;
  const request: Record<string, unknown> = { step: ctx.step.name, image: k, bytes: item?.bytes ?? 0, mimeType: item?.mimeType ?? "" };
  if (!item) return retryable("The post changed while publishing; will retry.");
  if (!xCapabilities.media.allowedMimeTypes.includes(item.mimeType)) {
    return { ...fatal(`Image ${k} is not a type X accepts (${item.mimeType}).`), summary: { request } };
  }
  if (item.bytes > X_MAX_BYTES_PER_FILE) return { ...fatal(`Image ${k} is larger than X allows (5 MB).`), summary: { request } };

  let bytes: Uint8Array;
  try {
    const res = await globalThis.fetch(item.url, { signal: ctx.signal });
    if (!res.ok) return { ...retryable(`Could not read image ${k} (HTTP ${res.status}); will retry.`), summary: { request } };
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch {
    return { ...retryable(`Could not read image ${k}; will retry.`), summary: { request } };
  }
  if (bytes.byteLength > X_MAX_BYTES_PER_FILE) return { ...fatal(`Image ${k} is larger than X allows (5 MB).`), summary: { request } };
  request.bytes = bytes.byteLength;
  const auth = { kind: "bearer", token: creds.accessToken } as const;

  const init = await xRequest({
    method: "POST",
    path: "/2/media/upload/initialize",
    auth,
    json: { media_type: item.mimeType, total_bytes: bytes.byteLength, media_category: "tweet_image" },
    signal: ctx.signal,
  });
  if (init.kind !== "ok") return stepFailure(init, ctx, secrets, request, `starting the upload of image ${k}`);
  const mediaId = dataId(init.body);
  if (!mediaId || !/^\d+$/.test(mediaId)) return { ...retryable(`X gave an unusable answer for image ${k}; will retry.`), summary: summarise(request, init, secrets) };
  const id = encodeURIComponent(mediaId);

  const form = new FormData();
  form.set("media", new Blob([bytes as BlobPart], { type: item.mimeType }), "image");
  form.set("segment_index", "0");
  const append = await xRequest({ method: "POST", path: `/2/media/upload/${id}/append`, auth, multipart: form, signal: ctx.signal });
  if (append.kind !== "ok") return stepFailure(append, ctx, secrets, request, `uploading image ${k}`);

  const fin = await xRequest({ method: "POST", path: `/2/media/upload/${id}/finalize`, auth, signal: ctx.signal });
  if (fin.kind !== "ok") return stepFailure(fin, ctx, secrets, request, `finishing the upload of image ${k}`);

  const finData = fin.body && typeof fin.body === "object" ? (fin.body as { data?: { expires_after_secs?: unknown } }).data : null;
  const initData = init.body && typeof init.body === "object" ? (init.body as { data?: { expires_after_secs?: unknown } }).data : null;
  const expiresIn = secondsOf(finData?.expires_after_secs ?? initData?.expires_after_secs, X_DEFAULT_MEDIA_EXPIRY_SECONDS, Number.MAX_SAFE_INTEGER / 2000);
  const info = processingInfo(fin.body);
  const pending = info !== null && (info.state === "pending" || info.state === "in_progress");
  if (info?.state === "failed") return { ...fatal(`X could not process image ${k}.`), summary: summarise({ ...request }, fin, secrets) };

  const alt = item.altText.trim().length > 0;
  const image: XStateImage = {
    mediaId,
    expiresAt: ctx.now.getTime() + expiresIn * 1000,
    processing: pending ? "pending" : "done",
    checks: 0,
    alt,
    described: false,
  };
  const base: XState = state && state.mediaCount === n && state.images.length === k - 1 ? state : { v: 1, mediaCount: n, images: [] };
  const summary = summarise(request, fin, secrets);
  if (info?.state) summary.response = { ...summary.response, processingState: info.state };
  return {
    kind: "continue",
    state: { ...base, images: [...base.images, image] } satisfies XState,
    ...(pending ? { notBefore: new Date(ctx.now.getTime() + info.checkAfter * 1000) } : {}),
    summary,
  };
}

async function checkImage(ctx: PublishContext, creds: XCredentials, state: XState | null): Promise<StepResult> {
  const secrets = [creds.accessToken, creds.refreshToken];
  const k = imageIndex(ctx.step.name);
  const image = state?.images[k - 1];
  if (!state || !image) return retryable("The post changed while publishing; will retry.");
  const request = { step: ctx.step.name, image: k };
  const out = await xRequest({
    method: "GET",
    path: "/2/media/upload",
    query: { command: "STATUS", media_id: image.mediaId },
    auth: { kind: "bearer", token: creds.accessToken },
    signal: ctx.signal,
  });
  if (out.kind !== "ok") return stepFailure(out, ctx, secrets, request, `checking image ${k}`);
  const info = processingInfo(out.body);
  const summary = summarise(request, out, secrets);
  if (info?.state) summary.response = { ...summary.response, processingState: info.state };
  const swap = (next: XStateImage): XState => ({ ...state, images: state.images.map((img, i) => (i === k - 1 ? next : img)) });

  if (info?.state === "failed") return { ...fatal(`X could not process image ${k}.`), summary };
  if (info && (info.state === "pending" || info.state === "in_progress")) {
    const checks = image.checks + 1;
    if (checks >= X_MAX_STATUS_CHECKS) return { ...fatal(`X was still processing image ${k} after ${checks} checks.`), summary };
    return { kind: "continue", state: swap({ ...image, checks }), notBefore: new Date(ctx.now.getTime() + info.checkAfter * 1000), summary };
  }
  return { kind: "continue", state: swap({ ...image, processing: "done" }), summary };
}

async function describeImage(ctx: PublishContext, creds: XCredentials, state: XState | null): Promise<StepResult> {
  const secrets = [creds.accessToken, creds.refreshToken];
  const k = imageIndex(ctx.step.name);
  const image = state?.images[k - 1];
  if (!state || !image) return retryable("The post changed while publishing; will retry.");
  const request = { step: ctx.step.name, image: k };
  const done = (): StepResult => ({
    kind: "continue",
    state: { ...state, images: state.images.map((img, i) => (i === k - 1 ? { ...img, described: true } : img)) } satisfies XState,
  });
  const alt = (ctx.content.media[k - 1]?.altText ?? "").trim().slice(0, ALT_MAX);
  if (!alt) return { ...done(), summary: { request } };

  const out = await xRequest({
    method: "POST",
    path: "/2/media/metadata",
    auth: { kind: "bearer", token: creds.accessToken },
    json: { id: image.mediaId, metadata: { alt_text: { text: alt } } },
    signal: ctx.signal,
  });
  if (out.kind !== "ok") return stepFailure(out, ctx, secrets, request, `adding the alt text of image ${k}`);
  return { ...done(), summary: summarise(request, out, secrets) };
}

/** One step. Never throws (contracts/providers.md). */
export async function advanceX(ctx: PublishContext): Promise<StepResult> {
  try {
    const state = ctx.state === null || ctx.state === undefined ? null : parseXState(ctx.state);
    const expected = xStepFor(state, ctx.account.settings, { text: ctx.content.text, mediaCount: ctx.content.media.length });
    if (expected.name !== ctx.step.name) return retryable("The post changed while publishing; will retry.");
    const creds = readXCredentials(ctx.account.credentials);
    if (!creds) return fatal("Stored X credentials are unreadable; reconnect the account.");
    const settings = xSettingsSchema.parse(ctx.account.settings ?? {});

    if (ctx.step.name === "create_post") return await createPost(ctx, creds, state, settings);
    if (ctx.step.name.startsWith("upload_image_")) return await uploadImage(ctx, creds, state);
    if (ctx.step.name.startsWith("check_image_")) return await checkImage(ctx, creds, state);
    if (ctx.step.name.startsWith("describe_image_")) return await describeImage(ctx, creds, state);
    return fatal("Unknown X publishing step.");
  } catch {
    // Never throw: an unexpected failure is only safe to retry before the write step.
    return ctx.step.mayPublish ? { kind: "ambiguous", error: "The X call failed unexpectedly. Check the X profile." } : retryable("The X call failed unexpectedly.");
  }
}
