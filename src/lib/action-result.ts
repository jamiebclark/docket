export type ErrorCode =
  | "validation"
  | "not_found"
  | "forbidden"
  | "last_owner"
  | "conflict"
  | "invitation_invalid"
  | "email_mismatch"
  | "setup_unavailable"
  | "unauthenticated";

export type ActionResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: ErrorCode;
      message: string;
      fieldErrors?: Record<string, string>;
      /** Present for `validation` failures raised by `ValidationIssuesError`. */
      issues?: ValidationIssues;
    };

export type ValidationIssues =
  | Array<{ severity?: string; code: string; message: string; field?: string }>
  | Record<string, Array<{ severity?: string; code: string; message: string; field?: string }>>;

export function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

export function fail(
  error: ErrorCode,
  message: string,
  fieldErrors?: Record<string, string>,
): ActionResult<never> {
  return fieldErrors
    ? { ok: false, error, message, fieldErrors }
    : { ok: false, error, message };
}

const ERROR_NAME_TO_CODE: Record<string, ErrorCode> = {
  NotFoundError: "not_found",
  ForbiddenError: "forbidden",
  LastOwnerError: "last_owner",
  ConflictError: "conflict",
  StorageUnavailableError: "conflict",
  InvitationInvalidError: "invitation_invalid",
  EmailMismatchError: "email_mismatch",
  SetupUnavailableError: "setup_unavailable",
  ValidationIssuesError: "validation",
  LlmNotConfiguredError: "conflict",
  PolicyNotAllowedError: "forbidden",
  JobClosedError: "conflict",
  MediaReservedError: "conflict",
  JobItemLimitError: "conflict",
};

/** Errors whose message is written for the user and safe to show, beyond the codes that always keep theirs. */
const KEEPS_MESSAGE_NAMES = new Set(["PolicyNotAllowedError"]);

const GENERIC_MESSAGE: Record<string, string> = {
  not_found: "Not found.",
  forbidden: "You don't have permission to do that.",
  last_owner: "A project must keep at least one owner. Transfer ownership first.",
  conflict: "That conflicts with the current state. Reload and try again.",
  invitation_invalid: "This invitation is invalid, expired or already used.",
  email_mismatch: "This invitation was sent to a different email address.",
  setup_unavailable: "Setup is no longer available.",
  validation: "Some posts have validation problems.",
};

/**
 * Map a thrown service/DAL error to an `ActionResult` failure by error name
 * (so this module stays free of server-only imports). Unknown errors rethrow.
 * Not-found never reveals whether the resource exists for someone else.
 */
export function failFromError(err: unknown): ActionResult<never> {
  const code = err instanceof Error ? ERROR_NAME_TO_CODE[err.name] : undefined;
  if (!code) throw err;
  // These carry a deliberate, user-facing message; the rest stay generic so nothing leaks.
  const flatIssues = code === "validation" ? (err as { issues?: ValidationIssues }).issues : undefined;
  // A flat issue list is a whole-request refusal whose message was written for the person; grouped ones are per post.
  const keepsMessage =
    code === "last_owner" ||
    code === "conflict" ||
    (Array.isArray(flatIssues) && flatIssues.length > 0) ||
    (err instanceof Error && KEEPS_MESSAGE_NAMES.has(err.name));
  const message =
    keepsMessage && err instanceof Error && err.message
      ? err.message
      : (GENERIC_MESSAGE[code] ?? "Something went wrong.");
  if (code === "validation") {
    const issues = (err as { issues?: ValidationIssues }).issues;
    if (!issues) return fail(code, message);
    const fieldErrors: Record<string, string> = {};
    if (Array.isArray(issues)) for (const i of issues) if (i.field) fieldErrors[i.field] ??= i.message;
    return { ok: false, error: code, message, issues, ...(Object.keys(fieldErrors).length > 0 ? { fieldErrors } : {}) };
  }
  const field = (err as { field?: unknown }).field;
  return typeof field === "string" && field
    ? fail(code, message, { [field]: message })
    : fail(code, message);
}

/** First message per field of a Zod error, keyed by the top-level field name. */
export function fieldErrorsFromZod(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }) {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) fieldErrors[String(issue.path[0] ?? "form")] ??= issue.message;
  return fieldErrors;
}
