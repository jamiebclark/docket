# Roadmap: LLM credentials people can trust

Goal: make Docket's LLM layer survive a provider refusing on billing, then let a project bring its own model and key
and see what it spent. Docket is moving from OpenAI to Anthropic (`claude-haiku-4-5`) against a shared monthly API
credit pool that other work also consumes, so credit exhaustion is a recurring operational event, not an edge case.

Read `docs/generator.md` ("Configuring a provider", "Jobs") and `docs/security.md` in full before specifying any
entry. Behaviour on `main` that every entry builds on:

- **The provider layer** is `src/server/llm/` — `anthropic.ts` and `openai.ts` behind `LlmProvider`
  (`types.ts`), chosen by `parseLlmConfig` (`config.ts:37`) from `LLM_PROVIDER`, `LLM_MODEL`,
  `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`, `LLM_TIMEOUT_SECONDS`, `LLM_MAX_OUTPUT_TOKENS`. Generation is simply off
  when `LLM_PROVIDER` is unset; startup logs it and carries on. `generate()` never throws for provider or network
  failure — it returns `{ ok: false, kind }`.
- **`LlmFailureKind`** (`src/server/llm/types.ts`) has eight members and is persisted in **two** pgEnums:
  `llm_failure_kind` (`src/server/db/schema/generation.ts:23`) and `generation_job_item_error`
  (`src/server/db/schema/jobs.ts:39`, which carries five more runner-only kinds). Any new kind needs a migration
  touching both. One fixed sentence per kind lives in `src/server/llm/messages.ts`; SDK error text never reaches a
  user, and `messages.test.ts` asserts the map is exhaustive.
- **The jobs runner** is `src/server/services/jobs/runner.ts`. `TEMPORARY` (line 48) is
  `{timeout, rate_limited, unavailable, internal, interrupted}`; line 318 is
  `TEMPORARY.has(kind) ? retryLater(...) : fail(...)`. `retryLater` gives up at `cfg.maxAttempts` (3) with backoff
  60s growing to 15min; `fail` sets `status: "failed"` and `finishedAt` with no `nextAttemptAt` — terminal.
  Recovery is manual via `retryFailedItems` (`src/server/services/jobs/manage.ts:37`), which resets attempt counts
  and never creates a duplicate post.
- **Secrets are env-only today.** `docs/generator.md` states: "Keys are read from the environment only and never
  stored, logged or rendered." `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are both named in the secret-scan
  regression suite (`tests/integration/security/secret-scan.test.ts`, `tests/integration/no-plaintext.test.ts`).
  Social account credentials are the established encrypt-at-rest pattern, under `CREDENTIALS_ENCRYPTION_KEY`.
- **Usage is captured but never persisted.** `LlmUsage` (`inputTokens`/`outputTokens`) is returned by every call and
  written to the log line by `logLlmCall` (`src/server/llm/log.ts`). No `usage` column exists anywhere in the
  generation schema.

Rules for every entry:
- Must leave the repo working and say what it does **not** do, and which later entry owns it.
- Entry 2 reverses the env-only key invariant quoted above. It must record that in `docs/decisions.md` next to the
  generator decisions, update `docs/generator.md`, and say what happens to installs that only ever used env vars.
- No entry may let a secret reach a log, a response or the UI. Extend the secret-scan suite rather than exempting it.

## 1. credit-hold — stop mass-failing jobs when the provider refuses on billing

Credit exhaustion today permanently fails every job item it touches, and the operator is told to check the wrong
thing. Verified chain: Anthropic returns HTTP 400 `invalid_request_error` ("Your credit balance is too low..."), not
402 or 429; the SDK raises `BadRequestError`; `src/server/llm/anthropic.ts:25-31` maps it to `bad_request`; that kind
is absent from `TEMPORARY`, so `runner.ts:318` calls `fail()`. The SDK's own `maxRetries: 2` does not retry 400s.
At defaults (60s worker interval, `GENERATION_TICK_MAX_ITEMS=2`) this permanently fails ~120 items per hour of
outage, capped at the 500-item job limit. OpenAI differs only in shape: `insufficient_quota` arrives as 429 ->
`RateLimitError` -> `rate_limited`, which *is* temporary, so it burns three doomed retries over ~20 minutes and then
fails identically.

Build: detect billing refusal on both providers (Anthropic by inspecting the 400's message, OpenAI by
`insufficient_quota`), give it its own persisted failure kind in both pgEnums, and **stop the runner claiming items
while the credential is refusing on billing** — resuming automatically when a call succeeds again. Adding the kind to
`TEMPORARY` is explicitly **not** sufficient: three attempts over ~20 minutes still mass-fails an outage that lasts
until someone tops up. Surface the held state honestly on the Batch jobs screens, and name billing as the cause.

Design constraint that exists for entry 2: **scope the hold by credential owner from day one**, even though there is
exactly one credential today. Entry 2 widens that scope to per-project; it must not have to rework it.

Does not: add per-project keys or settings of any kind (entry 2), persist token usage or cost (entry 3), or change
what happens to the already-landed operator message in `src/server/llm/messages.ts` (done, do not re-spec).

## 2. per-project-llm — a project can bring its own model and API key

So a project willing to spend its own tokens can choose a more capable model than the install's default. Per-project
provider, model and API key, resolved as **project override falls back to the env default**, so an install that sets
only env vars behaves exactly as it does today.

Build: encrypted-at-rest storage reusing the `CREDENTIALS_ENCRYPTION_KEY` pattern that social account credentials
already use; a project settings surface restricted to owner and admin for editing; a per-project equivalent of
`pnpm llm:check` so someone can validate a key before trusting it with a 500-item job; redaction everywhere a key
could surface. Extend entry 1's hold to per-project credential scope — one project running dry must not hold
another's jobs. Record the reversal of the env-only invariant in `docs/decisions.md`, and update `docs/generator.md`.

Does not: report spend or cost (entry 3), add any provider beyond the existing `openai` and `anthropic`, or let a
non-admin see or test a key.

## 3. llm-cost-visibility — show a project what it spent

Only worth building once entry 2 has projects spending their own money. `LlmUsage` is already returned by every call
and logged, but nothing persists it, so there is no history to report.

Build: persist per-call input and output tokens against the generation that produced them, and surface per-project
usage and estimated spend. Per-token prices differ by provider and model and change over time, so the spec must
decide where rates live and how an unpriced model is displayed — an estimate labelled as one beats a confident wrong
number.

**Tokens are not money, and this entry must not pretend otherwise.** Verified against the live provider on
2026-10-12: on OpenAI's data-sharing offer every one of Docket's calls was free. 360 tokens across 8 requests,
all of them attributed to the "data sharing incentive tier" on the usage dashboard, total spend `$0.00`. At the
Build tier that offer covers 2.5M tokens a day on the mini group — roughly a thousand Docket generations — so for
an install like this one the free share is not an edge case, it is the normal case. Tokens × list price would
therefore have overstated spend by about 100%.

Two consequences the spec has to face rather than discover:

- **The API will not tell you what was free.** A response's `service_tier` reports processing priority
  (`default`/`flex`/`priority`), not billing attribution; the free share appears only on the provider's usage
  dashboard, grouped by processing tier. Nothing Docket can read at call time distinguishes a free call from a
  billed one.
- **So a number computed from tokens and list prices is an upper bound, not spend**, and must be labelled as
  one wherever it appears. Reporting usage — tokens, calls, per model — is honest and useful on its own; a
  money figure presented as "spend" is not, and a tenant who reads it as a bill will be wrong by roughly the
  whole amount. The spec should decide deliberately whether to show money at all, and if it does, what it is
  called.

Does not: enforce budgets, cap or throttle generation on spend, or bill anyone. Reporting only. It also does not
try to reconcile against the provider's own billing, which is the only place the free share is visible.
