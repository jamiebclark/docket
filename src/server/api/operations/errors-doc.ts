import type { ApiExamples } from "./types";

/** The `Error` schema's body, for a documentation example (not sent by the pipeline itself). */
export function errorExample(code: string, message: string, details?: unknown) {
  return { error: { code, message, ...(details ? { details } : {}), requestId: "req_example" } };
}

/**
 * The seven error statuses every `manage_setup` operation can answer with (FR-042), one example
 * each. Callers spread the subset that applies to their operation and may override individual
 * entries with an operation-specific description or example.
 */
export function standardErrors(permission: string): Record<number, { description: string; examples: ApiExamples }> {
  return {
    400: {
      description: "The request is not valid",
      examples: {
        invalid: {
          summary: "Invalid request",
          value: errorExample("validation_failed", "The request is not valid.", [{ path: "field", message: "Fix this field." }]),
        },
      },
    },
    401: {
      description: "Missing or invalid API key",
      examples: { invalid: { summary: "Bad key", value: errorExample("invalid_api_key", "Invalid API key.") } },
    },
    403: {
      description: `The key lacks the ${permission} permission`,
      examples: {
        missing: {
          summary: "Missing permission",
          value: errorExample("missing_permission", `This key needs the ${permission} permission.`, { permission }),
        },
      },
    },
    404: {
      description: "Not found",
      examples: { not_found: { summary: "Not found", value: errorExample("not_found", "Not found.") } },
    },
    409: {
      description: "Conflict",
      examples: { conflict: { summary: "Conflict", value: errorExample("conflict", "Conflict.") } },
    },
    422: {
      description: "The Idempotency-Key was reused with a different request",
      examples: {
        mismatch: { summary: "Key reuse", value: errorExample("idempotency_key_reused", "This Idempotency-Key was used with a different request.") },
      },
    },
    429: {
      description: "Rate limited",
      examples: { limited: { summary: "Slow down", value: errorExample("rate_limited", "Too many requests.") } },
    },
  };
}
