import { X_API_BASE, X_ERROR_DETAIL_MAX } from "./config";

/** `x-rate-limit-*` as read from a reply. Each field is null when absent or unreadable. */
export interface XRate {
  limit: number | null;
  remaining: number | null;
  /** Epoch ms (the header is Unix seconds). */
  resetAtMs: number | null;
}

export type XAuth = { kind: "none" } | { kind: "bearer"; token: string } | { kind: "basic"; id: string; secret: string };

export interface XRequestInput {
  method: "GET" | "POST";
  /** "/2/tweets": a path on api.x.com, never a full URL. */
  path: string;
  query?: Record<string, string>;
  auth: XAuth;
  /** Exactly one of `json`, `form` and `multipart`, or none. */
  json?: unknown;
  form?: Record<string, string>;
  multipart?: FormData;
  signal: AbortSignal;
}

export type XOutcome =
  /** A 2xx. `body` is the parsed JSON, or null for an empty body. */
  | { kind: "ok"; status: number; body: unknown; rate: XRate }
  /** A 2xx whose body is not JSON. */
  | { kind: "unparseable"; status: number; rate: XRate }
  /** Any non-2xx. `body` is the parsed JSON, or null when empty or not JSON. */
  | { kind: "http_error"; status: number; body: unknown; rate: XRate }
  /** `not_sent`: refused before any byte left. `lost`: the request may have reached X (timeout, reset, abort). */
  | { kind: "network"; phase: "not_sent" | "lost" };

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

function uint(v: string | null): number | null {
  return v !== null && /^\d{1,15}$/.test(v) ? Number(v) : null;
}

export function readRate(headers: Headers): XRate {
  const reset = uint(headers.get("x-rate-limit-reset"));
  return {
    limit: uint(headers.get("x-rate-limit-limit")),
    remaining: uint(headers.get("x-rate-limit-remaining")),
    resetAtMs: reset !== null && reset > 0 ? reset * 1000 : null,
  };
}

/** Replaces each known credential string and truncates to the display limit. */
export function scrubX(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join("[redacted]");
  }
  return out.length > X_ERROR_DETAIL_MAX ? `${out.slice(0, X_ERROR_DETAIL_MAX - 3)}...` : out;
}

function authHeader(auth: XAuth): Record<string, string> {
  if (auth.kind === "bearer") return { authorization: `Bearer ${auth.token}` };
  if (auth.kind === "basic") return { authorization: `Basic ${Buffer.from(`${auth.id}:${auth.secret}`).toString("base64")}` };
  return {};
}

/** One call to api.x.com. Never throws: every failure is an outcome. */
export async function xRequest(input: XRequestInput): Promise<XOutcome> {
  const url = new URL(X_API_BASE + input.path);
  for (const [k, v] of Object.entries(input.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = { accept: "application/json", ...authHeader(input.auth) };
  let body: BodyInit | undefined;
  if (input.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(input.json);
  } else if (input.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(input.form).toString();
  } else if (input.multipart) {
    body = input.multipart; // fetch sets the multipart boundary itself
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
  const rate = readRate(res.headers);
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
  if (res.ok) return isJson ? { kind: "ok", status: res.status, body: parsed, rate } : { kind: "unparseable", status: res.status, rate };
  return { kind: "http_error", status: res.status, body: isJson ? parsed : null, rate };
}

/** X's Problem body: `title` and `detail` when strings, scrubbed and truncated. */
export function problemText(body: unknown, secrets: readonly string[]): string | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  const detail = typeof o.detail === "string" && o.detail ? o.detail : typeof o.title === "string" && o.title ? o.title : null;
  return detail ? scrubX(detail, secrets) : null;
}
