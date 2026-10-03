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
    };

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
