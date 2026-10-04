import { ZodError } from "zod";
import {
  ConflictError,
  ForbiddenError,
  InvalidApiKeyError,
  JobClosedError,
  JobItemLimitError,
  MediaReservedError,
  NotFoundError,
  PolicyNotAllowedError,
  UrlFetchError,
  ValidationIssuesError,
} from "../dal/errors";
import { LlmNotConfiguredError } from "../llm";
import { redact } from "../scheduler/redact";
import { StorageUnavailableError } from "../storage/errors";

/** The documented error codes (contracts/http-api.md, FR-010). */
export const API_ERROR_CODES = [
  "invalid_api_key",
  "missing_permission",
  "not_found",
  "method_not_allowed",
  "validation_failed",
  "invalid_json",
  "invalid_idempotency_key",
  "confirmation_required",
  "job_item_limit",
  "url_not_allowed",
  "url_too_many_redirects",
  "url_fetch_failed",
  "url_timeout",
  "idempotency_in_progress",
  "conflict",
  "job_closed",
  "media_reserved",
  "payload_too_large",
  "unsupported_media_type",
  "idempotency_key_reused",
  "generation_failed",
  "rate_limited",
  "internal_error",
  "generation_not_configured",
  "storage_not_configured",
  "generation_unavailable",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

const STATUS: Record<ApiErrorCode, number> = {
  invalid_api_key: 401,
  missing_permission: 403,
  not_found: 404,
  method_not_allowed: 405,
  validation_failed: 400,
  invalid_json: 400,
  invalid_idempotency_key: 400,
  confirmation_required: 400,
  job_item_limit: 400,
  url_not_allowed: 400,
  url_too_many_redirects: 400,
  url_fetch_failed: 400,
  url_timeout: 400,
  idempotency_in_progress: 409,
  conflict: 409,
  job_closed: 409,
  media_reserved: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  idempotency_key_reused: 422,
  generation_failed: 422,
  rate_limited: 429,
  internal_error: 500,
  generation_not_configured: 503,
  storage_not_configured: 503,
  generation_unavailable: 503,
};

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string; details?: unknown; requestId: string };
}

/** A pipeline-level failure. `headers` are extra response headers (Allow, Retry-After, WWW-Authenticate). */
export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
  }
  get status(): number {
    return STATUS[this.code];
  }
}

export function apiError(code: ApiErrorCode, message: string, details?: unknown, headers?: Record<string, string>): ApiError {
  return new ApiError(code, message, details, headers);
}

export function statusFor(code: ApiErrorCode): number {
  return STATUS[code];
}

const URL_CODES: Record<string, ApiErrorCode> = {
  url_not_allowed: "url_not_allowed",
  url_too_many_redirects: "url_too_many_redirects",
  url_fetch_failed: "url_fetch_failed",
  url_timeout: "url_timeout",
  payload_too_large: "payload_too_large",
  unsupported_media_type: "unsupported_media_type",
};

export function zodDetails(e: ZodError): { path: string; message: string }[] {
  return e.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
}

/** Maps a service or DAL error to an API error (research D11). Anything unknown is a generic 500. */
export function mapServiceError(e: unknown, ctx: { permission: string | null }): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof ZodError) {
    if (e.issues.some((i) => i.path[0] === "confirmUnreviewedQueue")) {
      return apiError(
        "confirmation_required",
        "Queueing posts that were not reviewed needs confirmUnreviewedQueue: true.",
        zodDetails(e),
      );
    }
    return apiError("validation_failed", "The request is not valid.", zodDetails(e));
  }
  if (e instanceof InvalidApiKeyError) {
    return apiError("invalid_api_key", "Invalid API key.", undefined, { "WWW-Authenticate": "Bearer" });
  }
  if (e instanceof PolicyNotAllowedError && (e.field === undefined || e.field === "approval")) {
    return apiError("missing_permission", "This key needs the auto_approve permission.", { permission: "auto_approve" });
  }
  if (e instanceof ForbiddenError || e instanceof PolicyNotAllowedError) {
    return apiError(
      "missing_permission",
      ctx.permission ? `This key needs the ${ctx.permission} permission.` : "This key is not allowed to do that.",
      ctx.permission ? { permission: ctx.permission } : undefined,
    );
  }
  if (e instanceof NotFoundError) return apiError("not_found", "Not found.");
  if (e instanceof JobClosedError) return apiError("job_closed", e.message);
  if (e instanceof MediaReservedError) return apiError("media_reserved", e.message, { items: e.items });
  if (e instanceof JobItemLimitError) return apiError("job_item_limit", e.message);
  if (e instanceof ConflictError) return apiError("conflict", e.message);
  if (e instanceof ValidationIssuesError) {
    return apiError("validation_failed", e.message, e.issues);
  }
  if (e instanceof LlmNotConfiguredError) {
    return apiError("generation_not_configured", "Generation is not set up for this Docket.");
  }
  if (e instanceof StorageUnavailableError) {
    return apiError("storage_not_configured", "Media storage is not set up.");
  }
  if (e instanceof UrlFetchError) {
    return apiError(URL_CODES[e.code] ?? "url_fetch_failed", e.message);
  }
  return apiError("internal_error", "Something went wrong. Quote the request id if you contact support.");
}

/** Log line for an unexpected error: the request id and error name only, through `redact()`. */
export function logUnexpected(requestId: string, e: unknown): void {
  const name = e instanceof Error ? e.name : typeof e;
  console.error(JSON.stringify(redact({ msg: "api internal error", requestId, error: name })));
}
