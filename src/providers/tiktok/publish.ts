import type { AttemptSummary, MediaItem, PublishContext, StepResult } from "../types";
import { MediaRangeError, readRange, storedSize } from "../media-range";
import { requireTikTokConfig, tiktokAudited } from "./config";
import { readCreatorInfo, type CreatorDetails } from "./creator";
import { readTikTokCredentials } from "./credentials";
import { explainTikTok } from "./errors";
import { readEnvelope, readRetryAfter, tiktokRequest, type TikTokOutcome } from "./http";
import { privacyLabel, PRIVATE_PRIVACY, tiktokPostingSchema, type TikTokPostingValues } from "./posting";
import { openUploadUrl, sealUploadUrl } from "./sealed";
import {
  CAP_GIVE_UP_MS,
  CAP_RETRY_MS,
  chunkPlan,
  chunkRange,
  creatorState,
  MAX_RESTARTS,
  nextReadAt,
  parseTikTokState,
  RATE_RETRY_MS,
  STATUS_CEILING_MS,
  UPLOAD_SAFE_AGE_MS,
  type TikTokState,
} from "./state";

const fatal = (error: string, summary?: AttemptSummary): StepResult => ({ kind: "fatal_error", error, ...(summary ? { summary } : {}) });
const retry = (error: string, extra: { notBefore?: Date; credentialsExpired?: boolean } = {}): StepResult => ({ kind: "retryable_error", error, ...extra });

const CAP_CODES = new Set(["spam_risk_too_many_posts", "reached_active_user_cap"]);
const PROCESSING = "TikTok is processing the post; it may take a few minutes to be visible.";
const PHOTO_UNCONFIRMED = "TikTok did not confirm the photo post; it may be live. Check TikTok before retrying.";
const LOST_TRACK = "Docket lost track of this TikTok post's progress; check TikTok before retrying.";
const NO_REPORT = "TikTok would not report on this post; check TikTok before retrying.";

interface Env {
  ctx: PublishContext;
  token: string;
  secret: string;
  audited: boolean;
  values: TikTokPostingValues;
  kind: "video" | "photo";
  /** Everything that must never reach a message. */
  secrets: string[];
}

type Inspected =
  | { tag: "ok"; data: Record<string, unknown> | null }
  | { tag: "cap" }
  | { tag: "expired" }
  | { tag: "rate"; ms: number }
  | { tag: "transient" }
  | { tag: "lost" }
  | { tag: "refused"; code: string | null; message: string | null; status: number };

/** One reading of a reply (research P12): an error code in a 200 body is that error. */
function inspect(out: TikTokOutcome): Inspected {
  if (out.kind === "network") return { tag: out.phase === "lost" ? "lost" : "transient" };
  if (out.kind === "unparseable") return { tag: "transient" };
  const env = readEnvelope(out.body);
  const status = out.status;
  if (env.code && CAP_CODES.has(env.code)) return { tag: "cap" };
  if (status === 401 || env.code === "access_token_invalid") return { tag: "expired" };
  if (status === 429 || env.code === "rate_limit_exceeded") return { tag: "rate", ms: out.retryAfterMs ?? RATE_RETRY_MS };
  if (out.kind === "http_error" && status >= 500) return { tag: "transient" };
  if (env.code || out.kind === "http_error") return { tag: "refused", code: env.code, message: env.message, status };
  return { tag: "ok", data: env.data };
}

const nicknameOf = (e: Env, s: TikTokState | null): string => s?.nickname || e.ctx.account.displayName || "this TikTok account";
const isoOf = (d: Date): string => d.toISOString();

function capMessage(nick: string): string {
  return `TikTok's daily posting limit has been reached for ${nick}; Docket will try again.`;
}

/** P29: wait an hour and look again; give up at 23 hours. */
function capWait(e: Env, state: TikTokState | null): StepResult {
  const now = e.ctx.now;
  const since = state?.capWaitSince ?? isoOf(now);
  const nick = nicknameOf(e, state);
  if (now.getTime() - Date.parse(since) >= CAP_GIVE_UP_MS) return fatal(capMessage(nick).replace("; Docket will try again.", "."));
  const next = creatorState(e.kind, state?.restarts ?? 0, { capWaitSince: since });
  return { kind: "continue", state: next, notBefore: new Date(now.getTime() + CAP_RETRY_MS), wait: capMessage(nick) };
}

/** The outcomes every pre-publishing request shares. Null when the reply was fine. */
function commonFailure(e: Env, r: Inspected, state: TikTokState | null, summary?: AttemptSummary): StepResult | null {
  switch (r.tag) {
    case "ok":
      return null;
    case "cap":
      return capWait(e, state);
    case "expired":
      return retry("TikTok rejected the access token; refreshing it.", { credentialsExpired: true });
    case "rate":
      return retry("TikTok asked Docket to slow down; will retry.", { notBefore: new Date(e.ctx.now.getTime() + r.ms) });
    case "transient":
    case "lost":
      return retry("TikTok did not answer cleanly; will retry.");
    case "refused":
      return fatal(`${explainTikTok(r.code, r.message, e.secrets)} Nothing was posted.`, summary);
  }
}

const videoOf = (ctx: PublishContext): MediaItem | undefined => ctx.content.media.find((m) => m.kind === "video");

function postInfo(e: Env, text: string): Record<string, unknown> {
  const v = e.values;
  const info: Record<string, unknown> = {
    privacy_level: e.audited ? v.privacy : PRIVATE_PRIVACY,
    disable_comment: !v.allowComments,
  };
  if (e.kind === "video") {
    info.title = text;
    info.disable_duet = !v.allowDuets;
    info.disable_stitch = !v.allowStitches;
  }
  info.brand_content_toggle = v.disclosure && v.brandedContent;
  info.brand_organic_toggle = v.disclosure && v.yourBrand;
  return info;
}

export async function advanceTikTok(ctx: PublishContext): Promise<StepResult> {
  // A step that may already have published must never claim "nothing was posted": its failures are ambiguous.
  const afterPublish = ctx.step.name === "check_status" || ctx.step.mayPublish;
  const creds = readTikTokCredentials(ctx.account.credentials);
  if (!creds) {
    const error = "TikTok's saved credentials are unreadable. Reconnect the account.";
    return afterPublish
      ? { kind: "ambiguous", error: `${error} The post may be live; check TikTok before retrying.`, credentialsInvalid: true }
      : { kind: "fatal_error", error, credentialsInvalid: true };
  }
  const stateRaw = ctx.state === null || ctx.state === undefined ? null : parseTikTokState(ctx.state);

  const isVideo = ctx.postType === "video" || !!videoOf(ctx);
  const kind = isVideo ? "video" : "photo";
  const parsedValues = tiktokPostingSchema.safeParse(ctx.content.posting?.values ?? undefined);
  let secret = "";
  try {
    secret = requireTikTokConfig().clientSecret;
  } catch {
    // Reading a post's status needs only the access token, so it proceeds without the client secret.
    if (ctx.step.name !== "check_status") {
      return afterPublish
        ? { kind: "ambiguous", error: "TikTok is not configured on this server; the post may be live. Check TikTok before retrying." }
        : fatal("TikTok is not configured on this server; nothing was posted.");
    }
  }
  const e: Env = {
    ctx,
    token: creds.accessToken,
    secret,
    audited: tiktokAudited(),
    values: parsedValues.success ? parsedValues.data : tiktokPostingSchema.parse({}),
    kind,
    secrets: [creds.accessToken, creds.refreshToken],
  };

  const name = ctx.step.name;
  if (name === "check_status") return checkStatus(e, ctx.state);
  if (!stateRaw && ctx.state !== null && ctx.state !== undefined) return checkCreator(e, null);
  if (name === "check_creator") return checkCreator(e, stateRaw);
  if (!stateRaw) return checkCreator(e, null);
  if (name === "start_upload") return startUpload(e, stateRaw);
  if (name === "publish_photos") return publishPhotos(e, stateRaw);
  if (name.startsWith("upload_chunk_")) return uploadChunk(e, stateRaw);
  return fatal(`Unknown TikTok step ${name.slice(0, 40)}; nothing was posted.`);
}

// ---- check_creator ----------------------------------------------------------------------------------------------

function mismatch(e: Env, d: CreatorDetails): string | null {
  const v = e.values;
  const nick = d.nickname || "this TikTok account";
  if (e.audited) {
    if (!v.privacy || !d.privacyOptions.includes(v.privacy)) {
      return `TikTok no longer allows '${privacyLabel(v.privacy ?? "")}' for ${nick}; nothing was posted. Choose again and reschedule.`;
    }
  } else {
    if (v.privacy !== PRIVATE_PRIVACY) return "This TikTok app is set as not audited, so it can only post privately; nothing was posted.";
    if (!d.privacyOptions.includes(PRIVATE_PRIVACY)) {
      return `TikTok doesn't offer 'Only me' for ${nick}, and this app can only post privately; nothing was posted.`;
    }
  }
  const off = (what: string) => `${nick} has turned off ${what} on TikTok; nothing was posted.`;
  if (v.allowComments && d.commentDisabled) return off("comments");
  if (e.kind === "video") {
    if (v.allowDuets && d.duetDisabled) return off("duets");
    if (v.allowStitches && d.stitchDisabled) return off("stitches");
    const seconds = videoOf(e.ctx)?.video?.durationSeconds;
    if (d.maxVideoSeconds && seconds !== undefined && Math.min(seconds, 300) > d.maxVideoSeconds) {
      return `${nick} can now post videos up to ${d.maxVideoSeconds} seconds on TikTok; nothing was posted.`;
    }
  }
  return null;
}

async function checkCreator(e: Env, state: TikTokState | null): Promise<StepResult> {
  const r = await readCreatorInfo(e.token, e.ctx.signal);
  const base = state && state.kind === e.kind ? state : null;
  const request = { step: "check_creator" };
  switch (r.kind) {
    case "ok": {
      const bad = mismatch(e, r.details);
      const response = { nickname: r.details.nickname, privacyOptions: r.details.privacyOptions, maxVideoSeconds: r.details.maxVideoSeconds };
      if (bad) return fatal(bad, { request, response });
      const next: TikTokState = { v: 1, kind: e.kind, phase: "start", restarts: base?.restarts ?? 0, nickname: r.details.nickname || "this TikTok account" };
      return { kind: "continue", state: next, summary: { request, response } };
    }
    case "cap":
      return capWait(e, base);
    case "banned":
      return fatal(`TikTok has blocked ${nicknameOf(e, base)} from posting right now; nothing was posted. (TikTok: spam_risk_user_banned_from_posting)`, { request });
    case "expired":
      return retry("TikTok rejected the access token; refreshing it.", { credentialsExpired: true });
    case "refused":
      return fatal(
        r.code === "scope_not_authorized"
          ? "TikTok did not grant permission to post. Connect again and allow posting."
          : `${explainTikTok(r.code, null, e.secrets)} Nothing was posted.`,
        { request },
      );
    case "rate":
      return retry("TikTok asked Docket to slow down; will retry.", { notBefore: new Date(e.ctx.now.getTime() + r.retryAfterMs) });
    default:
      return retry("TikTok did not answer the account check; will retry.");
  }
}

// ---- start_upload -----------------------------------------------------------------------------------------------

function restart(e: Env, s: TikTokState, why: string): StepResult {
  if (s.restarts >= MAX_RESTARTS) return fatal(why);
  return { kind: "continue", state: creatorState("video", s.restarts + 1) };
}

const EXPIRED_FINAL =
  "TikTok's upload expired before it finished; nothing was published. A smaller file, a faster connection or a longer provider time limit helps.";

async function startUpload(e: Env, s: TikTokState): Promise<StepResult> {
  const { ctx } = e;
  const media = videoOf(ctx);
  if (s.kind !== "video" || s.phase !== "start" || !media) return restart(e, s, EXPIRED_FINAL);
  const plan = chunkPlan(media.bytes);
  if (!plan) return fatal("TikTok can't take a video of this size; nothing was published.");

  let size: number;
  try {
    size = await storedSize(media.url, ctx.signal);
  } catch (err) {
    return retry(err instanceof MediaRangeError ? err.message : "The video's storage could not be read; will retry.");
  }
  if (size !== media.bytes) {
    if (s.restarts >= 1) return fatal("The video file changed while it was being sent; nothing was published.");
    return { kind: "continue", state: creatorState("video", s.restarts + 1) };
  }

  const request = {
    step: "start_upload",
    privacy: e.audited ? e.values.privacy : PRIVATE_PRIVACY,
    videoSize: media.bytes,
    chunkSize: plan.chunkSize,
    totalChunkCount: plan.chunkCount,
  };
  const out = await tiktokRequest({
    method: "POST",
    path: "/v2/post/publish/video/init/",
    token: e.token,
    json: {
      post_info: postInfo(e, ctx.content.text),
      source_info: { source: "FILE_UPLOAD", video_size: media.bytes, chunk_size: plan.chunkSize, total_chunk_count: plan.chunkCount },
    },
    signal: ctx.signal,
  });
  const r = inspect(out);
  const failed = commonFailure(e, r, s, { request });
  if (failed) return failed;
  const data = (r as Extract<Inspected, { tag: "ok" }>).data;
  const publishId = typeof data?.publish_id === "string" ? data.publish_id : "";
  const address = typeof data?.upload_url === "string" ? data.upload_url : "";
  if (!publishId || publishId.length > 64 || !address || address.length > 256) return retry("TikTok's reply to the upload request was unreadable; will retry.");
  if (!address.startsWith("https:")) return fatal("TikTok returned an upload address Docket can't use; nothing was published.", { request });

  const next: TikTokState = {
    v: 1,
    kind: "video",
    phase: "chunks",
    restarts: s.restarts,
    nickname: s.nickname,
    fileUrl: media.url,
    fileBytes: media.bytes,
    chunkSize: plan.chunkSize,
    chunkCount: plan.chunkCount,
    chunksSent: 0,
    publishId,
    sealedUploadUrl: sealUploadUrl(address, e.secret, `${ctx.target.id}:${publishId}`),
    uploadIssuedAt: isoOf(ctx.now),
  };
  return { kind: "continue", state: next, summary: { request, response: { publishId } } };
}

// ---- upload_chunk_k ---------------------------------------------------------------------------------------------

function toStatus(e: Env, s: TikTokState, summary: AttemptSummary): StepResult {
  const next: TikTokState = {
    v: 1,
    kind: "video",
    phase: "status",
    restarts: s.restarts,
    nickname: s.nickname,
    publishId: s.publishId,
    sentAt: isoOf(e.ctx.now),
    reads: 0,
  };
  return { kind: "continue", state: next, notBefore: nextReadAt(next), wait: PROCESSING, summary };
}

async function uploadChunk(e: Env, s: TikTokState): Promise<StepResult> {
  const { ctx } = e;
  const media = videoOf(ctx);
  if (s.phase !== "chunks" || !media || s.fileUrl !== media.url || s.fileBytes !== media.bytes) return restart(e, s, EXPIRED_FINAL);
  const plan = chunkPlan(s.fileBytes!)!;
  const k = (s.chunksSent ?? 0) + 1;
  const isFinal = k === plan.chunkCount;
  const address = openUploadUrl(s.sealedUploadUrl!, e.secret, `${ctx.target.id}:${s.publishId}`);
  if (!address) return restart(e, s, EXPIRED_FINAL);
  if (ctx.now.getTime() - Date.parse(s.uploadIssuedAt!) >= UPLOAD_SAFE_AGE_MS) return restart(e, s, EXPIRED_FINAL);
  e.secrets.push(address, ...(address.includes("?") ? [address.slice(address.indexOf("?") + 1)] : []));

  const { first, last } = chunkRange(plan, s.fileBytes!, k);
  const request = { step: ctx.step.name, chunk: k, of: plan.chunkCount, range: `${first}-${last}`, bytes: last - first + 1 };
  let bytes: Uint8Array;
  try {
    bytes = (await readRange(media.url, first, last, ctx.signal)).bytes;
  } catch (err) {
    return { ...retry(err instanceof MediaRangeError ? err.message : "The video's storage could not be read; will retry."), summary: { request } };
  }

  let status: number;
  let retryAfter: number | null = null;
  try {
    const res = await fetch(address, {
      method: "PUT",
      headers: {
        "content-type": media.mimeType,
        "content-length": String(bytes.byteLength),
        "content-range": `bytes ${first}-${last}/${s.fileBytes}`,
      },
      body: bytes as unknown as BodyInit,
      signal: ctx.signal,
    });
    status = res.status;
    retryAfter = readRetryAfter(res.headers);
    await res.body?.cancel().catch(() => undefined);
  } catch {
    return isFinal ? toStatus(e, s, { request, response: { outcome: "unconfirmed" } }) : { ...retry(`Part ${k} of the video did not reach TikTok; will retry.`), summary: { request } };
  }

  const summary: AttemptSummary = { request, response: { status } };
  if (status === 201) return toStatus(e, s, summary);
  if (status === 206) {
    if (isFinal) return fatal("TikTok did not receive the whole video; nothing was published.", summary);
    return { kind: "continue", state: { ...s, chunksSent: k }, summary };
  }
  if (status === 403) return restart(e, s, EXPIRED_FINAL);
  if (status === 429) {
    return isFinal ? toStatus(e, s, summary) : { ...retry("TikTok asked Docket to slow down; will retry.", { notBefore: new Date(ctx.now.getTime() + Math.max(retryAfter ?? 0, RATE_RETRY_MS)) }), summary };
  }
  if (status >= 500) return isFinal ? toStatus(e, s, summary) : { ...retry(`TikTok had a problem receiving part ${k}; will retry.`), summary };
  if (!isFinal && ctx.target.attempt > 1) return restart(e, s, EXPIRED_FINAL);
  return fatal(`${explainTikTok(null, `HTTP ${status}`, e.secrets)} Nothing was published.`, summary);
}

// ---- publish_photos ---------------------------------------------------------------------------------------------

async function publishPhotos(e: Env, s: TikTokState): Promise<StepResult> {
  const { ctx } = e;
  const urls = ctx.content.media.filter((m) => m.kind !== "video").map((m) => m.url);
  if (s.kind !== "photo" || s.phase !== "start" || urls.length === 0) return checkCreator(e, null);
  const postInfoBody = postInfo(e, ctx.content.text);
  postInfoBody.description = ctx.content.text;
  if (e.values.photoTitle) postInfoBody.title = e.values.photoTitle;
  const request = { step: "publish_photos", images: urls.length, privacy: postInfoBody.privacy_level };
  const out = await tiktokRequest({
    method: "POST",
    path: "/v2/post/publish/content/init/",
    token: e.token,
    json: {
      media_type: "PHOTO",
      post_mode: "DIRECT_POST",
      post_info: postInfoBody,
      source_info: { source: "PULL_FROM_URL", photo_images: urls, photo_cover_index: 0 },
    },
    signal: ctx.signal,
  });
  const r = inspect(out);
  // Nothing was sent when the connection was refused outright; anything else that is not an answer may be live.
  if (r.tag === "transient" && out.kind === "network") return { ...retry("TikTok could not be reached; will retry."), summary: { request } };
  if (r.tag === "lost" || r.tag === "transient") return { kind: "ambiguous", error: PHOTO_UNCONFIRMED, summary: { request } };
  const failed = commonFailure(e, r, s, { request });
  if (failed) return { ...failed, summary: failed.summary ?? { request } };
  const data = (r as Extract<Inspected, { tag: "ok" }>).data;
  const publishId = typeof data?.publish_id === "string" ? data.publish_id : "";
  if (!publishId || publishId.length > 64) return { kind: "ambiguous", error: PHOTO_UNCONFIRMED, summary: { request } };
  const next: TikTokState = { v: 1, kind: "photo", phase: "status", restarts: s.restarts, nickname: s.nickname, publishId, sentAt: isoOf(ctx.now), reads: 0 };
  return { kind: "continue", state: next, notBefore: nextReadAt(next), wait: PROCESSING, summary: { request, response: { publishId } } };
}

// ---- check_status -----------------------------------------------------------------------------------------------

async function checkStatus(e: Env, raw: unknown): Promise<StepResult> {
  const { ctx } = e;
  const s = parseTikTokState(raw);
  if (!s || s.phase !== "status" || !s.publishId || !s.sentAt) return { kind: "ambiguous", error: LOST_TRACK };
  const due = nextReadAt(s);
  if (ctx.now < due) return { kind: "continue", state: s, notBefore: due, wait: PROCESSING };

  const request = { step: "check_status", publishId: s.publishId };
  const out = await tiktokRequest({ method: "POST", path: "/v2/post/publish/status/fetch/", token: e.token, json: { publish_id: s.publishId }, signal: ctx.signal });
  const r = inspect(out);
  switch (r.tag) {
    case "expired":
      return retry("TikTok rejected the access token; refreshing it.", { credentialsExpired: true });
    case "rate":
      return retry("TikTok asked Docket to slow down; will retry.", { notBefore: new Date(ctx.now.getTime() + r.ms) });
    case "cap":
    case "transient":
    case "lost":
      return retry("TikTok did not report the post's status; will retry.");
    case "refused":
      return { kind: "ambiguous", error: NO_REPORT, summary: { request } };
    case "ok":
      break;
  }
  const data = r.data ?? {};
  const status = typeof data.status === "string" ? data.status : "";
  const summary: AttemptSummary = { request, response: { status: status.slice(0, 40) } };
  if (status === "PUBLISH_COMPLETE") {
    const ids = Array.isArray(data.publicaly_available_post_id) ? data.publicaly_available_post_id.map((id) => String(id).slice(0, 40)).slice(0, 10) : [];
    return { kind: "done", externalId: s.publishId, summary: { request, response: { status, ...(ids.length ? { publicPostIds: ids } : {}) } } };
  }
  if (status === "FAILED") {
    const reason = typeof data.fail_reason === "string" ? data.fail_reason : null;
    return {
      kind: "fatal_error",
      error: explainTikTok(reason, null, e.secrets),
      ...(reason === "auth_removed" ? { credentialsInvalid: true as const } : {}),
      summary,
    };
  }
  const sent = Date.parse(s.sentAt);
  if (status !== "PROCESSING_UPLOAD" && status !== "PROCESSING_DOWNLOAD") {
    return { kind: "ambiguous", error: "TikTok did not report this as posted; check TikTok before retrying.", summary };
  }
  if (ctx.now.getTime() >= sent + STATUS_CEILING_MS) {
    return { kind: "ambiguous", error: "TikTok did not confirm the post within 60 minutes; it may be live. Check TikTok before retrying.", summary };
  }
  const next: TikTokState = { ...s, reads: Math.min((s.reads ?? 0) + 1, 200), lastReadAt: isoOf(ctx.now), lastStatus: status.slice(0, 40) };
  return { kind: "continue", state: next, notBefore: nextReadAt(next), wait: PROCESSING, summary };
}
