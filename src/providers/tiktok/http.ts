import { TIKTOK_API_BASE, TIKTOK_ERROR_DETAIL_MAX } from "./config";

export type TikTokOutcome =
  /** A 2xx. `body` is the parsed JSON, or null for an empty body. */
  | { kind: "ok"; status: number; body: unknown; retryAfterMs: number | null }
  /** A 2xx whose body is not JSON. */
  | { kind: "unparseable"; status: number }
  /** Any non-2xx. `body` is the parsed JSON, or null when empty or not JSON. */
  | { kind: "http_error"; status: number; body: unknown; retryAfterMs: number | null }
  /** `not_sent`: refused before any byte left. `lost`: the request may have reached TikTok (timeout, reset, abort). */
  | { kind: "network"; phase: "not_sent" | "lost" };

export interface TikTokRequestInput {
  method: "GET" | "POST";
  /** "/v2/oauth/token/": a path on open.tiktokapis.com, never a full URL. */
  path: string;
  /** Sent as `Authorization: Bearer`. */
  token?: string;
  /** Exactly one of `json` and `form`, or none. */
  json?: unknown;
  form?: Record<string, string>;
  signal: AbortSignal;
}

const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

function causeCode(err: unknown): string | null {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/** `Retry-After` in seconds, as milliseconds; null when absent or unreadable. */
export function readRetryAfter(headers: Headers): number | null {
  const v = headers.get("retry-after");
  return v !== null && /^\d{1,7}$/.test(v) ? Number(v) * 1000 : null;
}

/** Replaces each known credential string and truncates to the display limit. */
export function scrubTikTok(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join("[redacted]");
  }
  return out.length > TIKTOK_ERROR_DETAIL_MAX ? `${out.slice(0, TIKTOK_ERROR_DETAIL_MAX - 3)}...` : out;
}

/** One call to open.tiktokapis.com. Never throws: every failure is an outcome. */
export async function tiktokRequest(input: TikTokRequestInput): Promise<TikTokOutcome> {
  const url = new URL(TIKTOK_API_BASE + input.path);
  const headers: Record<string, string> = { accept: "application/json" };
  if (input.token) headers.authorization = `Bearer ${input.token}`;
  let body: BodyInit | undefined;
  if (input.json !== undefined) {
    headers["content-type"] = "application/json; charset=UTF-8";
    body = JSON.stringify(input.json);
  } else if (input.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(input.form).toString();
  }

  let res: Response;
  try {
    res = await fetch(url, { method: input.method, headers, body, signal: input.signal });
  } catch (err) {
    const code = causeCode(err);
    return { kind: "network", phase: code && NOT_SENT_CODES.has(code) ? "not_sent" : "lost" };
  }
  let text: string;
  try {
    text = await res.text();
  } catch {
    return { kind: "network", phase: "lost" };
  }
  let parsed: unknown = null;
  let isJson = text.trim() === "";
  if (!isJson) {
    try {
      parsed = JSON.parse(text);
      isJson = true;
    } catch {
      isJson = false;
    }
  }
  const retryAfterMs = readRetryAfter(res.headers);
  if (res.ok) return isJson ? { kind: "ok", status: res.status, body: parsed, retryAfterMs } : { kind: "unparseable", status: res.status };
  return { kind: "http_error", status: res.status, body: isJson ? parsed : null, retryAfterMs };
}

export interface TikTokEnvelope {
  /** The error code, or null for none (`"ok"` counts as none). */
  code: string | null;
  /** A short message TikTok sent with the code, unscrubbed. */
  message: string | null;
  /** `body.data` when an object, else `body` when an object, else null. */
  data: Record<string, unknown> | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The one place the reply envelope is read (research P12, UNVERIFIED). The error code is `body.error.code`
 * when a string other than "ok", or `body.error` when a string. This catches error codes in HTTP 200 bodies.
 */
export function readEnvelope(body: unknown): TikTokEnvelope {
  if (!isObject(body)) return { code: null, message: null, data: null };
  let code: string | null = null;
  let message: string | null = null;
  const err = body.error;
  if (isObject(err)) {
    if (typeof err.code === "string" && err.code && err.code !== "ok") code = err.code;
    if (typeof err.message === "string" && err.message) message = err.message;
  } else if (typeof err === "string" && err && err !== "ok") {
    code = err;
    if (typeof body.error_description === "string" && body.error_description) message = body.error_description;
  }
  const data = isObject(body.data) ? body.data : body;
  return { code, message, data };
}
