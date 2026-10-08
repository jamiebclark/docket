import { XRPCError } from "@atproto/api";
import type { AttemptSummary, MediaItem, PublishContext, StepResult } from "../types";
import { isCredentialRejection, rateLimitNotBefore, statusOf } from "./errors";
import { MediaRangeError, readRange, storedSize } from "./media-range";
import { pdsHostOf } from "./pds-host";
import type { BlueskyCredentials, BlueskyState } from "./settings";
import { EXPIRED_TEXT, PROCESSING_CEILING_TEXT, isStartRefusal, jobFailureText, limitFailureText, limitWaitText, lostUploadText, partTimeoutText, sanitiseCode, sanitiseMessage, startRefusalText } from "./video-errors";
import {
  VIDEO_SERVICE_DID,
  VideoServiceError,
  finishUpload,
  getJobStatus,
  getUploadLimits,
  serviceToken,
  startUpload,
  uploadPart,
} from "./video-service";
import {
  EXPIRY_MARGIN_MS,
  FIRST_READ_DELAY_MS,
  LIMIT_GIVE_UP_MS,
  LIMIT_RETRY_MS,
  MAX_JOB_READS,
  MAX_RESTARTS,
  PROCESSING_CEILING_MS,
  nextReadAt,
  partRange,
  videoBlobSchema,
  type VideoBlob,
  type VideoUpload,
} from "./video-state";

export interface VideoEnv {
  ctx: PublishContext;
  pdsUrl: string;
  creds: BlueskyCredentials;
  state: BlueskyState;
}

const UPLOAD_LXM = "com.atproto.repo.uploadBlob";
const retryable = (error: string, extra: { notBefore?: Date; credentialsExpired?: boolean } = {}, summary?: AttemptSummary): StepResult => ({
  kind: "retryable_error",
  error,
  ...extra,
  ...(summary ? { summary } : {}),
});
const fatal = (error: string, summary?: AttemptSummary): StepResult => ({ kind: "fatal_error", error, ...(summary ? { summary } : {}) });

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const codeOf = (err: unknown, secrets: readonly string[] = []) =>
  err instanceof XRPCError ? sanitiseCode(err.error ?? `HTTP ${err.status}`, secrets) : "no response";
const progressOf = (job: Record<string, unknown>) => (typeof job.progress === "number" ? { progress: job.progress } : {});
const messageOf = (err: unknown) => (err instanceof XRPCError ? err.message : undefined);

/** A blob carried at `jobStatus.blob` or `blob` (P15). */
function blobIn(body: unknown): VideoBlob | null {
  const b = asRecord(body);
  const parsed = videoBlobSchema.safeParse(asRecord(b.jobStatus).blob ?? b.blob);
  return parsed.success ? parsed.data : null;
}

/** The saved upload with `patch` applied; `undefined` values drop the key. */
function withVideo(env: VideoEnv, patch: Partial<VideoUpload> & { phase: VideoUpload["phase"] }): BlueskyState {
  const next: Record<string, unknown> = { ...(env.state.video ?? { restarts: 0, statusAuth: "service" }), ...patch };
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  return { ...env.state, video: next as VideoUpload };
}

function cont(env: VideoEnv, patch: Partial<VideoUpload> & { phase: VideoUpload["phase"] }, summary: AttemptSummary, extra: { notBefore?: Date; wait?: string } = {}): StepResult {
  return { kind: "continue", state: withVideo(env, patch), ...extra, summary };
}

/** A restart (P14, §6): a fresh upload, or the end of the road on the third loss. */
function restart(env: VideoEnv, code: string, expired: boolean, summary: AttemptSummary): StepResult {
  const restarts = env.state.video?.restarts ?? 0;
  const note = { ...summary, response: { ...summary.response, restarts, restartReason: code } };
  if (restarts >= MAX_RESTARTS) return fatal(expired ? EXPIRED_TEXT : lostUploadText(code), note);
  return {
    kind: "continue",
    state: { v: 1, blobs: [], ...(env.state.mentions ? { mentions: env.state.mentions } : {}), video: { phase: "limits", restarts: restarts + 1, statusAuth: "service" } },
    notBefore: env.ctx.now,
    summary: note,
  };
}

/** Failures that are always worth another try: rate limit, server trouble, no answer. Null for anything else. */
function transient(err: unknown, env: VideoEnv, summary: AttemptSummary, timeoutText?: string): StepResult | null {
  const status = statusOf(err);
  if (status === 429) {
    const notBefore = rateLimitNotBefore(err instanceof XRPCError ? err.headers : undefined, env.ctx.now);
    return retryable("Bluesky is rate limiting requests; will retry.", notBefore ? { notBefore } : {}, summary);
  }
  if (status === null || status <= 2 || status >= 500) {
    if (timeoutText && env.ctx.signal.aborted) return retryable(timeoutText, {}, summary);
    return retryable(status === null ? "Could not reach Bluesky; will retry." : "Bluesky did not give a usable answer; will retry.", {}, summary);
  }
  return null;
}

type Token = { token: string } | { done: StepResult } | { refused: string };

/** §2: the service token for one call, or the outcome to return instead. */
async function token(env: VideoEnv, aud: string, lxm: string, summary: AttemptSummary): Promise<Token> {
  const { ctx } = env;
  summary.request = { ...summary.request, serviceAuth: { aud, lxm, expiresInSeconds: 300 } };
  try {
    return { token: await serviceToken({ pdsUrl: env.pdsUrl, accessJwt: env.creds.accessJwt, now: ctx.now, signal: ctx.signal }, aud, lxm) };
  } catch (err) {
    if (isCredentialRejection(err)) return { done: retryable("Bluesky rejected the session; renewing it.", { credentialsExpired: true }, summary) };
    const t = transient(err, env, summary);
    if (t) return { done: t };
    return { refused: codeOf(err, [env.creds.accessJwt]) };
  }
}

const refusedToken = (code: string, summary: AttemptSummary) =>
  fatal(`Bluesky refused to issue a video upload credential (${code}); nothing was published.`, summary);

/** The limit wait (P9): once an hour for under 23 hours, then the failure. */
function limitRefusal(env: VideoEnv, message: string | undefined, secrets: string[], summary: AttemptSummary): StepResult {
  const { now } = env.ctx;
  const since = env.state.video?.limitWaitSince;
  if (since && now.getTime() - Date.parse(since) >= LIMIT_GIVE_UP_MS) return fatal(limitFailureText(message, secrets), summary);
  return cont(env, { phase: "limits", limitWaitSince: since ?? now.toISOString(), limitsCheck: undefined }, summary, {
    notBefore: new Date(now.getTime() + LIMIT_RETRY_MS),
    wait: limitWaitText(message, secrets),
  });
}

function expired(env: VideoEnv): boolean {
  const at = env.state.video?.expiresAt;
  return !!at && env.ctx.now.getTime() >= Date.parse(at) - EXPIRY_MARGIN_MS;
}

export async function advanceVideo(env: VideoEnv): Promise<StepResult> {
  const item = env.ctx.content.media[0];
  const v = env.state.video;
  if (!item) return retryable("The post changed while publishing; will retry.");
  // A saved upload of other media means the post changed: start again from the first step (P18).
  if (v?.url !== undefined && (v.url !== item.url || v.sizeBytes !== item.bytes)) {
    return { kind: "continue", state: { v: 1 }, notBefore: env.ctx.now, summary: { request: { step: env.ctx.step.name, postChanged: true } } };
  }
  const name = env.ctx.step.name;
  if (name === "check_upload_limits") return checkUploadLimits(env);
  if (name === "start_upload") return startUploadStep(env, item);
  if (name.startsWith("upload_part_")) return uploadPartStep(env, item);
  if (name === "finish_upload") return finishUploadStep(env);
  if (name === "check_job") return checkJob(env);
  return retryable("The post changed while publishing; will retry.");
}

async function checkUploadLimits(env: VideoEnv): Promise<StepResult> {
  const { ctx } = env;
  const v = env.state.video;
  const summary: AttemptSummary = { request: { step: "check_upload_limits" } };
  const secrets = [env.creds.accessJwt];

  let pdsHost = v?.pdsHost;
  let pdsHostSource = v?.pdsHostSource;
  if (!pdsHost) {
    let res: Response;
    try {
      res = await globalThis.fetch(`${env.pdsUrl}/xrpc/com.atproto.server.getSession`, {
        headers: { authorization: `Bearer ${env.creds.accessJwt}` },
        signal: ctx.signal,
      });
    } catch (err) {
      return transient(err, env, summary) ?? retryable("Could not reach Bluesky; will retry.", {}, summary);
    }
    const body = asRecord(await res.json().catch(() => undefined));
    if (res.status === 401 || (res.status === 400 && body.error === "ExpiredToken")) {
      return retryable("Bluesky rejected the session; renewing it.", { credentialsExpired: true }, summary);
    }
    if (res.status === 429 || res.status >= 500) {
      const err = new XRPCError(res.status, str(body.error), str(body.message), Object.fromEntries(res.headers.entries()));
      return transient(err, env, summary)!;
    }
    const fromSession = res.ok ? pdsHostOf(body.didDoc) : null;
    pdsHost = fromSession ?? new URL(env.pdsUrl).hostname;
    pdsHostSource = fromSession ? "session" : "configured";
  }
  summary.request = { ...summary.request, pdsHost, pdsHostSource };
  const keep = { pdsHost, pdsHostSource } as const;

  const tok = await token(env, VIDEO_SERVICE_DID, "app.bsky.video.getUploadLimits", summary);
  if ("done" in tok) return tok.done;
  if ("refused" in tok) return cont(env, { phase: "start", limitsCheck: "skipped", ...keep }, { ...summary, response: { limitsCheck: "skipped", error: tok.refused } });

  secrets.push(tok.token);
  try {
    const limits = await getUploadLimits({ token: tok.token, signal: ctx.signal });
    const response = {
      status: 200,
      limitsCheck: limits.canUpload === false ? "refused" : limits.canUpload === true ? "ok" : "skipped",
      ...(limits.remainingDailyVideos !== undefined ? { remainingDailyVideos: limits.remainingDailyVideos } : {}),
      ...(limits.remainingDailyBytes !== undefined ? { remainingDailyBytes: limits.remainingDailyBytes } : {}),
    };
    if (limits.canUpload === false) return limitRefusal(env, limits.message, [...secrets, tok.token], { ...summary, response });
    if (limits.canUpload === true) return cont(env, { phase: "start", limitsCheck: "ok", ...keep }, { ...summary, response });
    return cont(env, { phase: "start", limitsCheck: "skipped", ...keep }, { ...summary, response: { status: 200, limitsCheck: "skipped", error: "UnreadableReply" } });
  } catch (err) {
    const t = statusOf(err) === 2 ? null : transient(err, env, summary);
    if (t) return t;
    return cont(env, { phase: "start", limitsCheck: "skipped", ...keep }, { ...summary, response: { status: statusOf(err) ?? 0, limitsCheck: "skipped", error: codeOf(err, secrets) } });
  }
}

/** P7: the start reply is usable only if its numbers add up. */
function parseStart(body: Record<string, unknown>, sizeBytes: number) {
  const { jobId, partSizeBytes, partCount, expiresAt } = body;
  if (typeof jobId !== "string" || !jobId || jobId.length > 200) return null;
  if (!Number.isInteger(partSizeBytes) || !Number.isInteger(partCount) || typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt))) return null;
  const size = partSizeBytes as number;
  const count = partCount as number;
  if (size < 1 || count < 1 || count > 10_000 || !((count - 1) * size < sizeBytes && sizeBytes <= count * size)) return null;
  return { jobId, partSizeBytes: size, partCount: count, expiresAt: new Date(expiresAt).toISOString() };
}

async function startUploadStep(env: VideoEnv, item: MediaItem): Promise<StepResult> {
  const { ctx } = env;
  const v = env.state.video;
  const summary: AttemptSummary = { request: { step: "start_upload", bytes: item.bytes } };
  const secrets = [env.creds.accessJwt];
  if (!v?.pdsHost) return fatal("Publishing state is unreadable. Use Retry to start again.", summary);

  try {
    if ((await storedSize(item.url, ctx.signal)) !== item.bytes) return retryable("The stored video's size does not match its record; will retry.", {}, summary);
  } catch (err) {
    return retryable(err instanceof MediaRangeError ? err.message : "Could not read the stored video; will retry.", {}, summary);
  }
  if (item.mimeType !== "video/mp4") return fatal("The video is not an MP4 file Bluesky accepts; nothing was published.", summary);

  const tok = await token(env, `did:web:${v.pdsHost}`, UPLOAD_LXM, summary);
  if ("done" in tok) return tok.done;
  if ("refused" in tok) return refusedToken(tok.refused, summary);
  secrets.push(tok.token);

  const duration = item.video?.durationSeconds;
  try {
    const body = await startUpload(
      { token: tok.token, signal: ctx.signal },
      {
        sizeBytes: item.bytes,
        mimeType: "video/mp4",
        name: `${ctx.target.id}.mp4`,
        ...(duration ? { durationMs: Math.round(duration * 1000) } : {}),
        ...(item.width ? { width: item.width } : {}),
        ...(item.height ? { height: item.height } : {}),
      },
    );
    const started = parseStart(body, item.bytes);
    if (!started) return retryable("Bluesky gave an unusable answer when starting the upload; will retry.", {}, { ...summary, response: { status: 200 } });
    return cont(
      env,
      { phase: "parts", limitWaitSince: undefined, url: item.url, sizeBytes: item.bytes, ...started, partsSent: 0 },
      { ...summary, response: { status: 200, partCount: started.partCount, partSizeBytes: started.partSizeBytes } },
    );
  } catch (err) {
    const code = codeOf(err, secrets);
    const response = { status: statusOf(err) ?? 0, error: code };
    const note = { ...summary, response };
    const early = err instanceof VideoServiceError ? blobIn(err.body) : null;
    if (early) return cont(env, { phase: "ready", blob: early }, note);
    if (code === "DailyLimitExceeded") return limitRefusal(env, messageOf(err), secrets, note);
    if (code === "TooManyOpenUploads" || code === "ServiceOverloaded") return transient(new XRPCError(503, code, undefined, err instanceof XRPCError ? err.headers : undefined), env, note)!;
    const t = transient(err, env, note);
    if (t) return t;
    if (isStartRefusal(code)) return fatal(startRefusalText(code, messageOf(err), secrets), note);
    const status = statusOf(err);
    if (status === 401 || status === 403) return fatal(`Bluesky's video service did not accept Docket's upload credential (${code}); nothing was published.`, note);
    return fatal(`Bluesky refused the video upload (${code}${messageOf(err) ? `: ${sanitiseMessage(messageOf(err), secrets)}` : ""}); nothing was published.`, note);
  }
}

async function uploadPartStep(env: VideoEnv, item: MediaItem): Promise<StepResult> {
  void item;
  const { ctx } = env;
  const v = env.state.video!;
  const k = (v.partsSent ?? 0) + 1;
  const n = v.partCount!;
  const summary: AttemptSummary = { request: { step: ctx.step.name, part: k, partCount: n, jobId: v.jobId } };
  const secrets = [env.creds.accessJwt];
  if (expired(env)) return restart(env, "UploadExpired", true, summary);

  const { first, last } = partRange(k, v.partSizeBytes!, v.sizeBytes!);
  let bytes: Uint8Array;
  try {
    const read = await readRange(v.url!, first, last, ctx.signal);
    if (read.total !== v.sizeBytes) return restart(env, "StoredSizeChanged", false, summary);
    bytes = read.bytes;
  } catch (err) {
    return retryable(err instanceof MediaRangeError ? err.message : `Could not read part ${k} of the video; will retry.`, {}, summary);
  }
  summary.request = { ...summary.request, bytes: bytes.length };

  const tok = await token(env, `did:web:${v.pdsHost}`, UPLOAD_LXM, summary);
  if ("done" in tok) return tok.done;
  if ("refused" in tok) return refusedToken(tok.refused, summary);
  secrets.push(tok.token);

  try {
    const body = await uploadPart({ token: tok.token, signal: ctx.signal }, v.jobId!, k, bytes);
    const note = { ...summary, response: { status: 200 } };
    if (body.partNumber !== k) return retryable(`Bluesky did not confirm part ${k} of the video; will retry.`, {}, note);
    return cont(env, { phase: k === n ? "finish" : "parts", partsSent: k }, note);
  } catch (err) {
    const code = codeOf(err, secrets);
    const note = { ...summary, response: { status: statusOf(err) ?? 0, error: code } };
    if (code === "UploadAlreadyCompleted") return cont(env, { phase: "finish", partsSent: n }, note);
    if (["UploadExpired", "UploadNotFound", "UploadAborted", "PartSizeMismatch"].includes(code)) return restart(env, code, code === "UploadExpired", note);
    if (code === "UploadNotReady" || code === "ServiceOverloaded") return retryable("Bluesky's video service is busy; will retry.", {}, note);
    const t = transient(err, env, note, partTimeoutText(k, n));
    if (t) return t;
    return fatal(`Bluesky refused part ${k} of the video (${code}${messageOf(err) ? `: ${sanitiseMessage(messageOf(err), secrets)}` : ""}); nothing was published.`, note);
  }
}

async function finishUploadStep(env: VideoEnv): Promise<StepResult> {
  const { ctx } = env;
  const v = env.state.video!;
  const summary: AttemptSummary = { request: { step: "finish_upload", jobId: v.jobId } };
  const secrets = [env.creds.accessJwt];
  if (expired(env)) return restart(env, "UploadExpired", true, summary);

  const tok = await token(env, `did:web:${v.pdsHost}`, UPLOAD_LXM, summary);
  if ("done" in tok) return tok.done;
  if ("refused" in tok) return refusedToken(tok.refused, summary);
  secrets.push(tok.token);

  try {
    const body = await finishUpload({ token: tok.token, signal: ctx.signal }, v.jobId!);
    const job = asRecord(body.jobStatus);
    const note = { ...summary, response: { status: 200, state: str(job.state), ...progressOf(job) } };
    if (job.state === "JOB_STATE_FAILED") return fatal(jobFailureText(str(job.failureCode) ?? str(job.error), str(job.message), secrets), note);
    const blob = blobIn(body);
    if (blob) return cont(env, { phase: "ready", blob }, note);
    const finishedAt = ctx.now;
    return cont(
      env,
      { phase: "job", pollJobId: str(body.completedJobId) ?? v.jobId, finishedAt: finishedAt.toISOString(), reads: 0, lastReadAt: undefined },
      note,
      { notBefore: new Date(finishedAt.getTime() + FIRST_READ_DELAY_MS) },
    );
  } catch (err) {
    const code = codeOf(err, secrets);
    const note = { ...summary, response: { status: statusOf(err) ?? 0, error: code } };
    const early = err instanceof VideoServiceError ? blobIn(err.body) : null;
    if (early) return cont(env, { phase: "ready", blob: early }, note);
    if (["UploadExpired", "UploadNotFound", "UploadAborted", "MissingParts"].includes(code)) return restart(env, code, code === "UploadExpired", note);
    if (code === "UploadNotReady" || code === "ServiceOverloaded") return retryable("Bluesky's video service is busy; will retry.", {}, note);
    const t = transient(err, env, note);
    if (t) return t;
    if (code === "UnsupportedContentType") return fatal(startRefusalText(code, messageOf(err), secrets), note);
    return fatal(`Bluesky could not finish the video upload (${code}${messageOf(err) ? `: ${sanitiseMessage(messageOf(err), secrets)}` : ""}); nothing was published.`, note);
  }
}

async function checkJob(env: VideoEnv): Promise<StepResult> {
  const { ctx } = env;
  const v = env.state.video!;
  const reads = v.reads ?? 0;
  const finishedAt = new Date(v.finishedAt!);
  const summary: AttemptSummary = { request: { step: "check_job", jobId: v.pollJobId, read: reads + 1, statusAuth: v.statusAuth } };
  const secrets = [env.creds.accessJwt];

  let bearer: string | null = null;
  if (v.statusAuth === "service") {
    const tok = await token(env, VIDEO_SERVICE_DID, "app.bsky.video.getJobStatus", summary);
    if ("done" in tok) return tok.done;
    if ("refused" in tok) return fatal(`Bluesky refused to report the video's processing status (${tok.refused}); nothing was published.`, summary);
    bearer = tok.token;
    secrets.push(bearer);
  }

  const still = (patch: Partial<VideoUpload>, note: AttemptSummary): StepResult => {
    const readAt = ctx.now;
    const count = reads + 1;
    if (readAt.getTime() >= finishedAt.getTime() + PROCESSING_CEILING_MS || count >= MAX_JOB_READS) return fatal(PROCESSING_CEILING_TEXT, note);
    return cont(env, { phase: "job", reads: count, lastReadAt: readAt.toISOString(), ...patch }, note, { notBefore: nextReadAt(readAt, finishedAt) });
  };

  try {
    const body = await getJobStatus({ token: bearer, signal: ctx.signal }, v.pollJobId!);
    const job = asRecord(body.jobStatus);
    const state = str(job.state);
    const blob = blobIn(body);
    const note = { ...summary, response: { status: 200, state, ...progressOf(job), blob: !!blob, failureCode: str(job.failureCode) === undefined ? undefined : sanitiseCode(str(job.failureCode), secrets) } };
    if (state === "JOB_STATE_FAILED") return fatal(jobFailureText(str(job.failureCode) ?? str(job.error), str(job.message), secrets), note);
    if (blob) return cont(env, { phase: "ready", blob, reads: reads + 1, lastReadAt: ctx.now.toISOString() }, note, { notBefore: ctx.now });
    return still({}, note);
  } catch (err) {
    const code = codeOf(err, secrets);
    const status = statusOf(err);
    const note = { ...summary, response: { status: status ?? 0, error: code } };
    if (status === 2 && err instanceof VideoServiceError) return still({}, note);
    const t = transient(err, env, note);
    if (t) return t;
    if (status === 401 || status === 403) {
      if (v.statusAuth === "service") return cont(env, { phase: "job", statusAuth: "none" }, note, { notBefore: nextReadAt(ctx.now, finishedAt) });
      return fatal(`Bluesky refused to report the video's processing status (${code}); nothing was published.`, note);
    }
    return fatal(`Bluesky refused to report the video's processing status (${code}${messageOf(err) ? `: ${sanitiseMessage(messageOf(err), secrets)}` : ""}); nothing was published.`, note);
  }
}
