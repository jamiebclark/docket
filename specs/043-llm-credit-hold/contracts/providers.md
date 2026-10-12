# Contract — provider detection

The two predicates that turn a provider's refusal to spend into `credit_exhausted`, the structured fields
they read, the order they run in, and the mappings that must not move.

Both predicates are exported (for their unit tests) and live in the provider's own file. There is **one per
provider** (FR-004), so adding an observed code or phrase later is a one-line change in one place.

## 1. Anthropic — `src/server/llm/anthropic.ts`

```ts
/** The verified credit-balance wording (research A5). One list, so another observed phrase is one line. */
export const ANTHROPIC_CREDIT_PHRASES: readonly RegExp[] = [/credit balance/i];

/**
 * The provider refusing to spend: either the SDK's declared `billing_error` type, or an
 * `invalid_request_error` whose body message names a credit balance (FR-002, C2).
 * Reads `APIError.type` and the body's `error.message` — never the composed `Error.message`.
 */
export function isCreditRefusal(error: unknown): boolean;
```

**Fields read, and only these:**

| Field | Type | Source of truth |
|---|---|---|
| `error instanceof Anthropic.APIError` | — | `node_modules/@anthropic-ai/sdk/core/error.d.ts` |
| `error.type` | `ErrorType \| null`, set from the body's `error.type` for every status | same file; `APIError.generate` in `core/error.js` |
| `(error.error as ErrorResponse).error.message` | `string` | `resources/shared.d.ts` — `APIError.error` holds the **whole** body `{ type: "error", error: { type, message }, request_id }` |

**Returns `true` when:**

- `error.type === "billing_error"` — the provider naming the condition itself; or
- `error.type === "invalid_request_error"` **and** the body message is a string matching one of
  `ANTHROPIC_CREDIT_PHRASES` (case-insensitive, FR-002).

**Returns `false` for everything else**, including: a missing or malformed body, a body whose `error` is not
an object, a non-string `message`, any other `ErrorType`, and anything that is not an `APIError` (a network
error, an abort, a programmer error).

## 2. OpenAI — `src/server/llm/openai.ts`

```ts
/** The verified quota code (research A5). One set, so another observed code is one line. */
export const OPENAI_CREDIT_CODES: ReadonlySet<string> = new Set(["insufficient_quota"]);

/** The provider refusing to spend, by its own error code (FR-003, C2). */
export function isCreditRefusal(error: unknown): boolean;
```

**Fields read, and only these:**

| Field | Type | Source of truth |
|---|---|---|
| `error instanceof OpenAI.APIError` | — | `node_modules/openai/core/error.d.ts` |
| `error.code` | `string \| null \| undefined`, lifted from the body's inner `error.code` | same file; the constructor in `core/error.js` |

**Returns `true` when** `typeof error.code === "string"` and `OPENAI_CREDIT_CODES.has(error.code)`.
**Returns `false`** otherwise, including a 429 with no `code`, a 429 with `code: "rate_limit_exceeded"`, a
missing body and a non-`APIError`.

> Note the asymmetry with Anthropic (research A3): OpenAI's `APIError.error` is the **inner** `error`
> object, not the whole body, and `code` is already a top-level field. Do not share a body-walker between
> the two providers.

## 3. Where the predicate runs

In both files, `kindOfError` gains exactly one branch, immediately after the timeout branch:

```ts
function kindOfError(error: unknown, timedOut: boolean): LlmFailureKind {
  if (timedOut || error instanceof X.APIConnectionTimeoutError || error instanceof X.APIUserAbortError) {
    return "timeout";
  }
  if (isCreditRefusal(error)) return "credit_exhausted";   // NEW — before rate_limited and bad_request
  if (error instanceof X.RateLimitError) return "rate_limited";
  if (error instanceof X.AuthenticationError || error instanceof X.PermissionDeniedError) return "auth";
  if (error instanceof X.BadRequestError || error instanceof X.UnprocessableEntityError || error instanceof X.NotFoundError) {
    return "bad_request";
  }
  return "unavailable";
}
```

Rules this ordering enforces:

- **Before `rate_limited`** — FR-003: an OpenAI billing 429 is never reported as rate limiting.
- **Before `bad_request`** — an Anthropic billing 400 is never reported as a rejected request.
- **After timeout** — an aborted or timed-out request has no body to read, and `timeout` is the honest kind
  for it. A timeout is also not a billing refusal, so it clears the hold (FR-017).
- **It cannot shadow `auth`** — Anthropic's 401 carries `authentication_error` and OpenAI's carries
  `invalid_api_key`; neither predicate matches either.

## 4. What must not change

| Behaviour | Must stay | Why |
|---|---|---|
| `generate()` never throws for a provider or network failure | unchanged | FR-001 |
| the `{ ok: false, kind, message, rawText, usage, latencyMs, provider, model }` result shape | unchanged | FR-001; `message` is `llmFailureMessage(kind)`, never SDK text |
| a non-billing 400 → `bad_request` | unchanged | FR-004, SC-009 |
| a non-billing 429 → `rate_limited` | unchanged | FR-004, SC-009 |
| 401/403 → `auth`, 5xx and connection errors → `unavailable`, abort/timeout → `timeout` | unchanged | FR-004 |
| `maxRetries: 2` on both clients | unchanged | out of scope; changing it would slow genuine rate-limit recovery |
| no SDK error text, account identifier or request id in the result, the log line or a stored row | unchanged | FR-032; only `kind` leaves the predicate |
| `bad_request`'s existing sentence in `messages.ts` | unchanged | C4, FR-005 — the author marks it done |
| the image-generation interface | unimplemented, untouched | spec Out of Scope |

## 5. The failure message

```ts
// src/server/llm/messages.ts
credit_exhausted:
  "The model provider refused: the account has no credit or quota left. Add credit to the provider account.",
```

It names credit as the cause and what to do (FR-005, SC-005); it carries no provider error text, account
identifier, provider name or key; and it is caller-neutral, because the same sentence is shown for a single
generation, a stored failure, a waiting job row, the API's 503 body and `pnpm llm:check`. The "waiting, not
failed, resumes by itself" context belongs to the notice, not to this sentence (see `ui.md`).

`messages.test.ts` becomes nine kinds; the exhaustive `Record<LlmFailureKind, string>` type is what forces
the entry.

## 6. Test contract (mocked HTTP only)

Added to the shared scenario table `tests/helpers/llm-scenarios.ts`, which runs for **both** providers, via
two new `LlmWire` members:

```ts
export interface LlmWire {
  // … existing members …
  /** This provider's billing-refusal response. `keyEcho` is embedded in the body message when given. */
  creditRefusal(keyEcho?: string): FakeLlmResponse;
  /** The same HTTP status, a different cause — must keep today's kind. */
  nonBillingAtSameStatus(): FakeLlmResponse;
}
```

| Wire | `creditRefusal()` | `nonBillingAtSameStatus()` | Expected kind |
|---|---|---|---|
| Anthropic | `400`, body `{ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API…" } }` | `400`, body `{ type: "error", error: { type: "invalid_request_error", message: "max_tokens: must be <= 8192" } }` | `credit_exhausted` / `bad_request` |
| Anthropic (second signal) | `400`, body `{ type: "error", error: { type: "billing_error", message: "…" } }` | — | `credit_exhausted` |
| OpenAI | `429`, body `{ error: { message: "You exceeded your current quota…", type: "insufficient_quota", code: "insufficient_quota", param: null } }` | `429`, body `{ error: { message: "Rate limit reached", type: "rate_limit_error", code: "rate_limit_exceeded" } }` | `credit_exhausted` / `rate_limited` |

Scenarios asserted for both providers:

1. `creditRefusal()` → `{ ok: false, kind: "credit_exhausted" }` with `message === llmFailureMessage("credit_exhausted")`.
2. `nonBillingAtSameStatus()` → today's kind, unchanged (SC-009).
3. The **existing** `[400, "bad_request"]` / `[429, "rate_limited"]` rows keep passing with no change: their
   body `{ error: { message: "SDK-DETAIL-SHOULD-NOT-LEAK" } }` has no `type` and no `code`, so neither
   predicate matches.
4. A malformed body (`status` with no body, `{}`, `{ error: "a string" }`, `{ error: { } }`) → today's kind,
   never `credit_exhausted` and never a thrown error (FR-004).
5. `creditRefusal(SCENARIO_KEY)` → the key does not appear anywhere in `JSON.stringify(result)` (FR-032),
   and not in the captured log line.
6. `credit_exhausted` makes **one** call only — no in-request correction retry (FR-006), asserted through
   `runGenerationStep` in `core.test.ts` and through `fetch.calls.length === 1`.
