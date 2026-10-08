import { XRPCError } from "@atproto/api";
import { SERVICE_TOKEN_TTL_SECONDS } from "./video-state";

/** Bluesky's video service (fixed; not a setting, P22). */
export const VIDEO_SERVICE_URL = "https://video.bsky.app";
export const VIDEO_SERVICE_DID = "did:web:video.bsky.app";

/** A refusal or unreadable answer from the video service. Keeps the parsed body (P15) as `XRPCError` drops it. */
export class VideoServiceError extends XRPCError {
  constructor(
    status: number,
    error: string | undefined,
    message: string | undefined,
    headers: Record<string, string> | undefined,
    readonly body: unknown,
  ) {
    super(status, error, message, headers);
  }
}

const headersOf = (res: Response): Record<string, string> => Object.fromEntries(res.headers.entries());

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** One XRPC exchange: the parsed 2xx JSON body, or a thrown `VideoServiceError` (status 2 for an unreadable 2xx). */
async function exchange(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const res = await globalThis.fetch(url, init);
  const body = await readBody(res);
  if (!res.ok) {
    const b = asRecord(body);
    throw new VideoServiceError(res.status, str(b.error), str(b.message), headersOf(res), body);
  }
  if (body === undefined || typeof body !== "object" || Array.isArray(body)) {
    throw new VideoServiceError(2, "InvalidResponse", "The video service sent an unreadable reply.", headersOf(res), body);
  }
  return body as Record<string, unknown>;
}

export interface ServiceTokenEnv {
  pdsUrl: string;
  accessJwt: string;
  now: Date;
  signal: AbortSignal;
}

/**
 * Method-scoped service token from the account's own PDS (P3). Held in one local by the caller and sent only to
 * `VIDEO_SERVICE_URL`. Throws `XRPCError` (a refusal) or the fetch error.
 */
export async function serviceToken(env: ServiceTokenEnv, aud: string, lxm: string): Promise<string> {
  const exp = Math.floor(env.now.getTime() / 1000) + SERVICE_TOKEN_TTL_SECONDS;
  const query = new URLSearchParams({ aud, lxm, exp: String(exp) });
  const res = await globalThis.fetch(`${env.pdsUrl}/xrpc/com.atproto.server.getServiceAuth?${query}`, {
    headers: { authorization: `Bearer ${env.accessJwt}` },
    signal: env.signal,
  });
  const body = asRecord(await readBody(res));
  if (!res.ok) throw new XRPCError(res.status, str(body.error), str(body.message), headersOf(res));
  const token = str(body.token);
  if (!token) throw new XRPCError(2, "InvalidResponse", "The server sent no service token.", headersOf(res));
  return token;
}

interface Call {
  token: string;
  signal: AbortSignal;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const xrpc = (method: string, query?: Record<string, string>) =>
  `${VIDEO_SERVICE_URL}/xrpc/${method}${query ? `?${new URLSearchParams(query)}` : ""}`;

export interface UploadLimits {
  canUpload?: boolean;
  remainingDailyVideos?: number;
  remainingDailyBytes?: number;
  message?: string;
  error?: string;
}

export async function getUploadLimits(call: Call): Promise<UploadLimits> {
  const b = await exchange(xrpc("app.bsky.video.getUploadLimits"), { headers: auth(call.token), signal: call.signal });
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  return {
    ...(typeof b.canUpload === "boolean" ? { canUpload: b.canUpload } : {}),
    ...(num(b.remainingDailyVideos) !== undefined ? { remainingDailyVideos: num(b.remainingDailyVideos) } : {}),
    ...(num(b.remainingDailyBytes) !== undefined ? { remainingDailyBytes: num(b.remainingDailyBytes) } : {}),
    ...(str(b.message) ? { message: str(b.message) } : {}),
    ...(str(b.error) ? { error: str(b.error) } : {}),
  };
}

export interface StartUploadInput {
  sizeBytes: number;
  mimeType: string;
  name: string;
  durationMs?: number;
  width?: number;
  height?: number;
}

/** The raw reply; the step checks it against P7. */
export function startUpload(call: Call, input: StartUploadInput): Promise<Record<string, unknown>> {
  return exchange(xrpc("app.bsky.video.startUpload"), {
    method: "POST",
    headers: { ...auth(call.token), "content-type": "application/json" },
    body: JSON.stringify(input),
    signal: call.signal,
  });
}

export function uploadPart(call: Call, jobId: string, partNumber: number, bytes: Uint8Array): Promise<Record<string, unknown>> {
  return exchange(xrpc("app.bsky.video.uploadPart", { jobId, partNumber: String(partNumber) }), {
    method: "POST",
    headers: { ...auth(call.token), "content-type": "application/octet-stream", "content-length": String(bytes.length) },
    body: bytes as unknown as BodyInit,
    signal: call.signal,
  });
}

export function finishUpload(call: Call, jobId: string): Promise<Record<string, unknown>> {
  return exchange(xrpc("app.bsky.video.finishUpload"), {
    method: "POST",
    headers: { ...auth(call.token), "content-type": "application/json" },
    body: JSON.stringify({ jobId }),
    signal: call.signal,
  });
}

/** `token` is null for the unauthenticated fallback (P13). */
export function getJobStatus(call: { token: string | null; signal: AbortSignal }, jobId: string): Promise<Record<string, unknown>> {
  return exchange(xrpc("app.bsky.video.getJobStatus", { jobId }), { headers: call.token ? auth(call.token) : {}, signal: call.signal });
}
