// Typed errors thrown by the DAL and services. `src/lib/action-result.ts` maps them to
// `ActionResult` failures by `name`, so every class sets `this.name` explicitly
// (class names do not survive minification).

export class NotFoundError extends Error {
  constructor(message = "Not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/** `message` is shown to the user verbatim; `field` attaches it to a form field. */
export class ConflictError extends Error {
  readonly field?: string;
  /** A stable machine-readable code (the public API surfaces it); the message stays human text. */
  readonly reason?: string;
  constructor(message: string, opts?: string | { field?: string; reason?: string }) {
    super(message);
    this.name = "ConflictError";
    const o = typeof opts === "string" ? { field: opts } : opts;
    if (o?.field !== undefined) this.field = o.field;
    if (o?.reason !== undefined) this.reason = o.reason;
  }
}

/** `message` is shown to the user verbatim; `field` attaches it to a form field. */
export class PolicyNotAllowedError extends Error {
  readonly field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.name = "PolicyNotAllowedError";
    if (field !== undefined) this.field = field;
  }
}

export class LastOwnerError extends Error {
  constructor(message = "A project must keep at least one owner.") {
    super(message);
    this.name = "LastOwnerError";
  }
}

export class InvitationInvalidError extends Error {
  constructor(message = "This invitation is invalid, expired or already used.") {
    super(message);
    this.name = "InvitationInvalidError";
  }
}

export class EmailMismatchError extends Error {
  constructor(message = "This invitation was sent to a different email address.") {
    super(message);
    this.name = "EmailMismatchError";
  }
}

export class SetupUnavailableError extends Error {
  constructor(message = "Setup is no longer available.") {
    super(message);
    this.name = "SetupUnavailableError";
  }
}

/** Structural subset of the provider `ValidationIssue`, so the DAL does not import the provider framework. */
export type ValidationIssueLike = { severity?: string; code: string; message: string; field?: string };

/** Whole-request validation failure: a flat list, or issues grouped by target id. */
export class ValidationIssuesError extends Error {
  readonly issues: ValidationIssueLike[] | Record<string, ValidationIssueLike[]>;
  constructor(
    issues: ValidationIssueLike[] | Record<string, ValidationIssueLike[]>,
    message = "Some posts have validation problems.",
  ) {
    super(message);
    this.name = "ValidationIssuesError";
    this.issues = issues;
  }
}

/** The API key is missing, malformed, unknown, revoked, expired, or its project is gone. Maps to 401. */
export class InvalidApiKeyError extends Error {
  constructor(message = "Invalid API key") {
    super(message);
    this.name = "InvalidApiKeyError";
  }
}

/** Items cannot be added to a job that is closed, finished or cancelled. */
export class JobClosedError extends Error {
  constructor(message = "This job is closed and accepts no more items.") {
    super(message);
    this.name = "JobClosedError";
  }
}

export type ReservedMediaIssue = { index: number; mediaId: string; reason: "reserved" | "deleted" | "unknown" };

/** Images in a job request are held by another job, deleted, or not in this project. */
export class MediaReservedError extends Error {
  readonly items: ReservedMediaIssue[];
  constructor(items: ReservedMediaIssue[], message = "Some images cannot be used by this job.") {
    super(message);
    this.name = "MediaReservedError";
    this.items = items;
  }
}

export class JobItemLimitError extends Error {
  constructor(message = "A job can have at most 500 items.") {
    super(message);
    this.name = "JobItemLimitError";
  }
}

/** Fetching an image by URL failed (blocked address, redirect loop, timeout, too large, not an image). */
export class UrlFetchError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "UrlFetchError";
    this.code = code;
  }
}
