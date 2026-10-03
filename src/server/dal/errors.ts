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
  constructor(message: string, field?: string) {
    super(message);
    this.name = "ConflictError";
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
