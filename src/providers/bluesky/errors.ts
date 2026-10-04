import { XRPCError } from "@atproto/api";
import type { StepResult } from "../types";

export type ErrorKind = "read" | "upload" | "publish";
type Outcome = Extract<StepResult, { kind: "retryable_error" | "fatal_error" | "ambiguous" }>;

const DAY_MS = 86_400_000;
const PRE_SEND_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
const HTTP_UNKNOWN = 1;
const HTTP_INVALID_RESPONSE = 2;

type HeaderBag = Headers | Record<string, string | undefined> | undefined;

function headerValue(headers: HeaderBag, name: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

/** `Retry-After` as delta-seconds or an HTTP-date. Junk and past values are ignored; the result is capped at 24 h. */
export function rateLimitNotBefore(headers: HeaderBag, now: Date): Date | null {
  const raw = headerValue(headers, "retry-after")?.trim();
  if (!raw) return null;
  let at: number;
  if (/^\d+$/.test(raw)) at = now.getTime() + Number(raw) * 1000;
  else {
    at = Date.parse(raw);
    if (Number.isNaN(at)) return null;
  }
  if (at <= now.getTime()) return null;
  return new Date(Math.min(at, now.getTime() + DAY_MS));
}

/** True when the failure happened before anything was sent (so nothing can have been written). */
export function isPreSend(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && PRE_SEND_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function statusOf(err: unknown): number | null {
  return err instanceof XRPCError ? err.status : null;
}

export function errorName(err: unknown): string {
  if (err instanceof XRPCError) {
    if (err.error && err.error !== "Unknown") return err.error;
    return err.status === HTTP_UNKNOWN ? "NoResponse" : `HTTP ${err.status}`;
  }
  return "Error";
}

/** Secret-free text for a reason: the platform error name and status only. */
export function safeReason(err: unknown): string {
  if (!(err instanceof XRPCError)) return "no response";
  return err.status > HTTP_INVALID_RESPONSE ? `${errorName(err)}, HTTP ${err.status}` : errorName(err);
}

export function isCredentialRejection(err: unknown): boolean {
  return err instanceof XRPCError && (err.status === 401 || (err.status === 400 && err.error === "ExpiredToken"));
}

/** Definitive refusal of a refresh (R2). */
export function isDefinitiveRefusal(err: unknown): boolean {
  return (
    err instanceof XRPCError &&
    (err.status === 401 || err.error === "ExpiredToken" || err.error === "InvalidToken" || err.error === "AccountTakedown")
  );
}

function unsure(kind: ErrorKind, error: string, notBefore?: Date): Outcome {
  if (kind === "publish") return { kind: "ambiguous", error };
  return { kind: "retryable_error", error, ...(notBefore ? { notBefore } : {}) };
}

/** Map a thrown error to a step outcome. `index` is the 1-based image number for upload errors. */
export function classify(err: unknown, kind: ErrorKind, now: Date = new Date(), index?: number): Outcome {
  if (isPreSend(err)) return { kind: "retryable_error", error: "Could not reach Bluesky; will retry." };
  if (!(err instanceof XRPCError)) return unsure(kind, "Bluesky call failed unexpectedly.");
  const status = err.status;
  if (status === 429) {
    const notBefore = rateLimitNotBefore(err.headers, now);
    return { kind: "retryable_error", error: "Bluesky is rate limiting requests; will retry.", ...(notBefore ? { notBefore } : {}) };
  }
  if (kind !== "read" && isCredentialRejection(err)) {
    return { kind: "retryable_error", error: "Bluesky rejected the session; renewing it.", credentialsExpired: true };
  }
  if (status === HTTP_UNKNOWN || status === HTTP_INVALID_RESPONSE || status >= 500) {
    return unsure(kind, `Bluesky did not give a usable answer (${safeReason(err)}).`);
  }
  if (status >= 400) {
    const name = errorName(err);
    if (kind === "upload") return { kind: "fatal_error", error: `Bluesky refused image ${index ?? "?"} (${name}).` };
    if (kind === "publish") {
      const message = (err.message ?? "").slice(0, 200);
      return {
        kind: "fatal_error",
        error: `Bluesky rejected the post (${name}: ${message}). If it mentions an image, use Retry to upload the images again.`,
      };
    }
    return { kind: "fatal_error", error: `Bluesky refused the request (${name}).` };
  }
  return unsure(kind, "Bluesky call failed unexpectedly.");
}
