/** Media storage is not configured. Mapped to `conflict` in `action-result.ts` by name. */
export class StorageUnavailableError extends Error {
  constructor() {
    super("Media storage is not set up.");
    this.name = "StorageUnavailableError";
  }
}

/**
 * A storage call failed. The message carries only the operation and HTTP status: the SDK's own
 * message can echo request details (endpoint, signed URLs), so it is kept as `cause` for server logs.
 */
export class StorageError extends Error {
  constructor(
    readonly operation: string,
    readonly httpStatus?: number,
    cause?: unknown,
  ) {
    super(`Storage ${operation} failed${httpStatus ? ` (HTTP ${httpStatus})` : ""}`, { cause });
    this.name = "StorageError";
  }
}
