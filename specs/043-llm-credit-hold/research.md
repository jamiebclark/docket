# Phase 0 — Research: credit hold

Two parts. **A** is external fact, read from the installed packages because the constitution forbids working
from memory and phases cannot fetch the web. **B** is the nineteen plan decisions (H1–H19) about this
repository's own code, each with the alternative it rejects and how to reverse it.

Nothing is left `NEEDS CLARIFICATION` or `NEEDS RESEARCH`.

---

## A. Verified facts

### A1 — Anthropic's error object

Read from `node_modules/@anthropic-ai/sdk/core/error.d.ts` and `node_modules/@anthropic-ai/sdk/core/error.js`:

- `APIError` exposes `status`, `headers`, `error` (**the parsed JSON body**), `requestID`, `workspaceID` and
  `type`, documented as "The `error.type` from the API response body, e.g. `"rate_limit_error"`".
- `APIError.generate()` reads `const type = error?.['error']?.['type']` and passes it to **every** subclass,
  for every status — so `type` is populated on a 400 `BadRequestError` just as on a 429.
- `BadRequestError extends APIError<400, Headers>`; `RateLimitError extends APIError<429, Headers>`.
- `APIError.makeMessage` composes `Error.message` as `` `${status} ${body.message}` ``. Reading that string
  would be scraping; FR-002 requires the structured read instead.

From `node_modules/@anthropic-ai/sdk/resources/shared.d.ts`:

```ts
export type ErrorType =
  | 'invalid_request_error' | 'authentication_error' | 'permission_error' | 'not_found_error'
  | 'rate_limit_error' | 'timeout_error' | 'overloaded_error' | 'api_error' | 'billing_error';

export interface BillingError { message: string; type: 'billing_error' }
export interface InvalidRequestError { message: string; type: 'invalid_request_error' }
export interface ErrorResponse { error: ErrorObject; request_id: string | null; type: 'error' }
```

**`billing_error` is a declared member of the SDK's own error-type union.** The spec did not know this: it
describes detection purely as "an `invalid_request_error` whose body message names a credit balance". This is
a verified fact from the installed package, and it is why H3 matches on `billing_error` as well.

So, for Anthropic:

- the structured type is `error.type` (`ErrorType | null`);
- the structured message is `(error.error as ErrorResponse).error.message` — because `APIError.error` holds
  the **whole** body `{ type: "error", error: { type, message }, request_id }`.

### A2 — OpenAI's error object

Read from `node_modules/openai/core/error.d.ts` and `node_modules/openai/core/error.js`:

- `APIError` exposes `status`, `headers`, `error`, `code`, `param`, `type` and `requestID`.
- The constructor sets `this.code = data?.['code']`, `this.param = data?.['param']`,
  `this.type = data?.['type']`, where `data` is the value handed to it as `error`.
- `APIError.generate()` passes `errorResponse?.['error']` — the **inner** object. So for OpenAI,
  `APIError.error` is `{ message, type, code, param }`, and `code` is already lifted to a top-level field.
- `RateLimitError extends APIError<429, Headers>`.

So, for OpenAI the structured read is simply `error.code === "insufficient_quota"` — one field, no body
walking.

### A3 — The asymmetry that matters

`APIError.error` means different things in the two SDKs: **the whole body** in Anthropic, **the inner `error`
object** in OpenAI. Writing one shared body-walker would be wrong for one of them. Each provider therefore
gets its own predicate in its own file (H3, FR-004), and `contracts/providers.md` fixes the exact field path
for each.

### A4 — Neither SDK retries these

`docs/research/llm-and-storage.md` records each SDK's retry policy and error classes, and says outright that
OpenAI's full error class list was **not** confirmed. Both clients are constructed with `maxRetries: 2`
(`anthropic.ts`, `openai.ts`), which does not retry a 400; a 429 *is* retried by the SDK, which is why
OpenAI's `insufficient_quota` costs three SDK attempts inside one of our attempts today. Detection does not
change `maxRetries`: that is out of scope and would slow every genuine rate-limit recovery.

### A5 — What is still unverified, and why that is safe

`docs/research/` does not record Anthropic's 400 body wording or OpenAI's `insufficient_quota` code; both come
from the spec author's own verification against the live APIs. Phases cannot fetch the web and provider tests
never make live calls (constitution II), so:

- detection is narrow, and **anything unmatched keeps today's kind** (FR-004) — a missed detection costs
  today's behaviour, not a stall;
- the phrase list is one named constant per provider so adding an observed wording later is a one-line
  change (C2);
- Anthropic has a second, wording-independent signal (`billing_error`, A1), so a wording change does not
  silently disable detection for the provider Docket is moving to;
- every detection test is mocked HTTP, and the feature is reported as "verified with mocks only".

### A6 — Postgres and the migration

`ALTER TYPE … ADD VALUE` inside a transaction block is allowed on Postgres 12+, provided the new label is not
*used* in the same transaction. Migration `drizzle/0004_lowly_silver_surfer.sql` already ships
`ALTER TYPE "public"."post_review_state" ADD VALUE 'rejected'` alongside `CREATE TABLE` statements in one
file, so drizzle's transactional migrator handles this combination in this repository today. This entry's
migration adds two labels and creates one table and uses neither label, so it is safe on a live, populated
install (FR-029).

### A7 — What `main` already gives us for free

Read from the code, and relied on rather than rebuilt:

- **The deferred-retry precedent.** `runner.ts` already sends an item back to `queued` with
  `nextAttemptAt = now` and **no attempt counted** when a correction retry will not fit the tick
  (`counts.deferred`). The billing requeue is the same move with a recorded reason (H11).
- **`release()`** already returns an item to `queued` with the lease cleared and nothing counted.
- **`refreshJobStatus`** derives status from the counts, and `queued + running > 0` is invariant across the
  requeue, so no job can become `completed_with_failures` because of it (FR-008).
- **Lease recovery lives in the claim.** Because a held owner is not claimed for, a `running` item with an
  expired lease is simply not touched: no attempt, no `interrupted` (US1 AS5). The hold is the protection.
- **The job page already auto-refreshes** every 5 s while queued or running (`AutoRefresh intervalMs={5000}`),
  and is `force-dynamic`, so the notice clears itself (FR-023).
- **The public API maps explicitly.** `toApiJobSummaryFromList`, `toApiJob` and `toApiJobItem` list every
  field, so adding fields to the read services cannot change a payload (FR-024, US4 AS4).
- **`logLlmCall`** logs only provider, model, label, latency, outcome and usage, and `redact()` drops
  sensitive-looking keys; the runner's `logLine` already replaces the configured key. No new redaction is
  needed, only new lines that stay inside those rules (FR-032).
- **`tests/helpers/llm-scenarios.ts`** is a shared scenario table run against both providers over
  `createFakeLlmFetch`; it already asserts `[400, "bad_request"]`, `[429, "rate_limited"]`, `[401/403,
  "auth"]`, `[500, "unavailable"]` and that SDK detail never reaches the result. Detection belongs there.
- **`tests/integration/no-plaintext.test.ts`** already dumps **every** table in `information_schema` as text,
  so a new table is covered by construction; what it needs is the two API keys in its `secrets` list and a
  hold row present when it runs (FR-033).

---

## B. Plan decisions (H1–H19)

### Storage and identity

**H1 — One install-wide table, `llm_credit_holds`, keyed by `owner`.**
Four columns: `owner text primary key`, `held_since`, `last_refusal_at`, `next_probe_at`, all `timestamptz
not null`. It lives in `src/server/db/schema/generation.ts` next to `llmFailureKind` (the LLM concern stays in
one file, exactly as `scheduler.ts` already holds one system-wide and one project-owned table) and is
registered in `notProjectOwned`.
*Rejected:* a column on `scheduler_heartbeats` (it is keyed by scheduler section, not by credential, and is
overwritten every tick); a JSON blob on `install_state` (a singleton, so "at most one per owner" would stop
being a database fact); a project-owned table (a hold belongs to a credential, not a project — FR-030, and
entry 2 will still key it by owner, not by project row ownership).
*Reverse:* drop the table; the gate then finds no rows and the claim is `main`'s.

**H2 — The credential-owner seam is `src/server/dal/credential-owners.ts`, and it is async and SQL-aware from
day one.** It exports `INSTALL_CREDENTIAL_OWNER = "install"`, `credentialOwnerFor(projectId): Promise<string>`
(today: the constant, ignoring its argument) and `jobsExcludingProjects(projectIds): SQL | undefined`
(`undefined` when `projectIds` is empty, otherwise a `NOT IN` predicate over those ids — resolved from the
blocked owners by `job-claims.ts`'s `resolveBlockedProjectIds`, SC-010). It sits in the DAL because
entry 2 will have to read the project's stored credential to answer, and because `job-claims.ts` needs it
inside the claim transaction — a service module there would invert the layering.
Async and SQL-aware **now**, even though a constant needs neither, is the whole point of C7/SC-010: entry 2
rewrites this one file and nothing else.
*Rejected:* a sync `credentialOwnerFor` (entry 2 would have to change every caller's signature); a pure
TypeScript predicate with no SQL form (the claim's job `SELECT` has a `LIMIT`, so a held owner's jobs filtered
only in memory would crowd a free owner's jobs out of the tick — see H10); putting the seam in
`src/server/llm/` (that layer must stay free of the database).
*Reverse:* inline the constant at its two call sites.

**H3 — Detection is one named predicate per provider, reading structured fields, and Anthropic matches
`billing_error` as well as the credit-balance wording.**

```ts
// anthropic.ts
const CREDIT_PHRASES = [/credit balance/i];            // the one verified wording (A5)
export function isCreditRefusal(error: unknown): boolean {
  if (!(error instanceof Anthropic.APIError)) return false;
  if (error.type === "billing_error") return true;      // A1: a declared ErrorType
  if (error.type !== "invalid_request_error") return false;
  const message = (error.error as { error?: { message?: unknown } } | undefined)?.error?.message;
  return typeof message === "string" && CREDIT_PHRASES.some((p) => p.test(message));
}

// openai.ts
const CREDIT_CODES = new Set(["insufficient_quota"]);   // the one verified code (A5)
export function isCreditRefusal(error: unknown): boolean {
  return error instanceof OpenAI.APIError && typeof error.code === "string" && CREDIT_CODES.has(error.code);
}
```

Going beyond the spec's illustration with `billing_error` is deliberate and conservative: it is the provider
declaring the condition by name, so it cannot produce a false positive, and it keeps detection working if
Anthropic rewords the sentence.
*Rejected:* matching `error.message` (that is the composed `"400 …"` string — scraping, forbidden by FR-002);
one shared body-walker for both SDKs (A3 — `APIError.error` means different things); matching any 400 as
billing (FR-004, SC-009: a false positive stalls an install); matching on `status === 402` (neither provider
uses it — the spec verified this).
*Reverse:* make both predicates `return false`; every error falls back to today's mapping.

**H4 — The predicate runs immediately after the timeout branch, before every other branch.**
In both `kindOfError` functions. This satisfies FR-003 literally for OpenAI (before
`RateLimitError → rate_limited`) and gives Anthropic the same shape, which also covers a `billing_error`
arriving on a 429 or a 422. It cannot shadow `auth`: Anthropic's 401 carries `authentication_error`, and
OpenAI's 401 carries `invalid_api_key` — neither matches.
Timeout stays first because an aborted request has no body to read.
*Rejected:* a branch after `bad_request` (an OpenAI billing 429 would already have become `rate_limited`);
a branch inside the `bad_request` arm only (misses `billing_error` on other statuses).
*Reverse:* delete the two lines.

### The hold, the gate and the probe

**H5 — The gate is two statements inside the existing claim transaction, and a row it cannot lock counts as
held.**

1. `SELECT owner, next_probe_at FROM llm_credit_holds` — unlocked, so every held owner is seen.
2. For the held owners whose `next_probe_at <= now`:
   `SELECT owner FROM llm_credit_holds WHERE owner = ANY($due) AND next_probe_at <= $now FOR UPDATE SKIP LOCKED`,
   then one `UPDATE … SET next_probe_at = $now + interval` for the rows it locked.

The rows returned by (2) are this tick's probing owners. A held owner that is due but whose row another tick
already holds is **not** in (2), so it is treated as held-and-not-probing: the claim takes nothing for it this
tick. That is the conservative direction, and it is why exactly one probe happens per interval across any
number of workers (FR-015) **without waiting** on a lock.
*Rejected:* a single conditional `UPDATE … WHERE next_probe_at <= now RETURNING owner` (correct single-flight,
but the losing tick **blocks** on the row until the winner's claim transaction commits, and
`claimDueJobItems` is documented as never waiting); one combined `SELECT … FOR UPDATE SKIP LOCKED` (an owner
locked by another tick would be invisible and therefore read as *not held* — the claim would then run at full
throughput during an outage, which is the bug this entry exists to fix); `pg_try_advisory_xact_lock`
(forbidden by the Neon constraint).
*Reverse:* make the gate return `{ held: [], probing: [] }`.

**H6 — `next_probe_at` is always `now + CREDIT_PROBE_INTERVAL_MS`, never `next_probe_at + interval`.**
Absolute from the moment of the decision. A missed window, a long outage, a clock that moves backwards or a
`next_probe_at` already in the past at startup therefore all yield exactly **one** probe, never a queue of
them (spec edge cases). `CREDIT_PROBE_INTERVAL_MS = 5 * 60_000` is a documented constant exported from
`src/server/dal/credit-holds.ts`, with no environment variable (FR-014).
*Rejected:* an environment variable (FR-014); accumulating from the stored value (a backlog of probes after a
pause); storing the interval in the row (nothing would ever change it).
*Reverse:* change the constant.

**H7 — A granted probe is rewound unless a model call was actually made.**
`rewindCreditProbe(owner, now)` is an `UPDATE … SET next_probe_at = $now WHERE owner = $owner` — an update
only, **never** an insert, so a hold cleared by a concurrent success is not resurrected. It runs in two
places: inside the claim transaction for a probing owner that ended up with zero claimed items, and in
`processClaimedItem`'s `finally` when the item was a probe and `runGenerationStep` was never reached.
This is what makes FR-016 true (a probe skipped for tick budget does not consume the interval) and extends
the same honesty to a probe that found only `finish` work, a cancelled job, a lost lease or an exception.
*Rejected:* pushing `next_probe_at` only after a call returns (two ticks would then both probe — the write
must be in the gate's transaction to be single-flight, H5); accepting the lost interval (a worker restarted
every few minutes under a short tick budget would never probe).
*Reverse:* delete both rewind calls; a skipped probe then costs one interval.

**H8 — `itemDue` (queued-and-due, or `running` with an expired lease) is the item predicate for every owner,
probing or not.** US1 AS5 is protected instead by gating the recovery branch — the `attempt_count` increment
and the `interrupted` failure at `maxAttempts` — on `!probe`. So a probing owner whose only due work is a
lease-expired `running` item can still claim and probe it, with no attempt counted and no failure possible.
Without this gate, a hold whose only owner has nothing `queued`-and-due could never probe at all, starving
the hold forever (the shipped fix for the first review's F1).
*Rejected:* a narrower `queuedDue`-only predicate for probing owners (the original design): it fixes US1 AS5
but starves the probe whenever the owner's sole due item is lease-expired `running`, which is common after
any outage long enough to expire a lease.
*Reverse:* narrow the per-job item predicate back to `queuedDue` for a probing owner, and drop the `!probe`
gates on the recovery branch.

**H9 — `claimDueJobItems` returns `{ items, held, probing }`.**
The gate must run inside the claim's transaction (FR-015), so its result has to come back with the items;
the tick summary cannot re-read it afterwards without a second, racy read. Two call sites change
(`src/server/scheduler/generation.ts`, `tests/integration/jobs/recovery.test.ts`) plus
`tests/integration/jobs/dal.test.ts`; both are mechanical and relax no assertion.
*Rejected:* an out-parameter object passed in and mutated (hides the dependency); a second read after the
transaction (racy, and would double-count a probe).
*Reverse:* return the array and drop the two flags from the summary.

**H10 — Blocked owners are excluded in SQL; probing owners are capped in memory at one item.**
`jobsExcludingProjects(blockedProjects)` is added to the job `SELECT`'s `WHERE` **only when
`blockedProjects` is non-empty**,
so with an empty hold table the statement is byte-identical to `main`'s (SC-007). Excluding in SQL is what
keeps FR-013's "a held owner MUST NOT consume the tick's item budget" true: the `SELECT` has `LIMIT $limit`,
so a held owner's jobs filtered only after the fact would eat slots a free owner could have used. A probing
owner is not excluded — it has real work to do — but `budgetFor(owner)` caps it at 1 while free owners get
the full `limit`, applied inside the existing round-robin loop.
A probing owner's one item can still take a slot ahead of a free owner's job in the same tick; that is the
existing `last_claimed_at` fairness rule, which Out of Scope says not to change.
*Rejected:* filtering held owners in memory only (starves free owners, above); a separate second `SELECT`
per probing owner (more statements, and the round-robin fairness would have to be re-derived); raising the
`SELECT`'s `LIMIT` when a hold exists (an arbitrary multiplier with no right value).
*Reverse:* pass `[]` as `blocked` and `limit` as every owner's budget.

### Not failing items

**H11 — The requeue is `release()` plus the recorded reason, counted as `requeued`.**

```ts
async function requeueForCredit(): Promise<void> {           // FR-007..FR-009
  const ok = await commit({
    status: "queued",
    nextAttemptAt: await clock.now(),   // immediately due
    ...UNLEASED,                        // lease released cleanly
    pendingRetry: null,                 // in-request correction state cleared
    lastErrorKind: "credit_exhausted",
    lastError: llmFailureMessage("credit_exhausted"),
  });                                   // attemptCount deliberately absent
  if (ok) { counts.requeued++; outcome = "requeued:credit_exhausted"; }
}
```

It goes through the same lease-checked `commit()` as every other post-claim write (FR-009), and leaves
`refresh` at its default so the job's status is recomputed (FR-008) — a no-op in practice, because
`queued + running` does not change, which is exactly why no job can be reported finished-with-failures. An
item whose post was already saved never reaches this branch: `findByJobItemId` sends it to `finish()` first
(FR-009).
The dispatch at `runner.ts:320` becomes a three-way: `credit_exhausted` → requeue, `TEMPORARY` → `retryLater`,
otherwise → `fail`. `TEMPORARY` itself is not touched (FR-010, C6).
`counts.requeued` is a new `number` on `GenerationCounts`, distinct from `retried` (which counts an attempt
and backs off) and from `released` (which records no reason) — FR-009.
*Rejected:* adding the kind to `TEMPORARY` (explicitly rejected by the roadmap and C6); reusing `deferred`
(that means a correction retry, and a reader of the summary could not tell an outage from a slow tick);
reusing `released` (loses the reason the screens need); writing `attemptCount: item.attemptCount` explicitly
(a no-op that invites someone to "fix" it to `+ 1`).
*Reverse:* restore the two-way dispatch.

**H12 — `withCreditHold(llm, owner)` wraps the provider inside `runGenerationStep` and `planSeries`.**

```ts
// src/server/services/generation/credit.ts
export function withCreditHold(llm: LlmProvider, owner: string): LlmProvider;
```

It delegates `generate`, returns the result **unchanged**, and in between awaits one hold write: an upsert
when `result.kind === "credit_exhausted"`, a delete for every other outcome including `ok` (FR-017). Errors
from that write are swallowed — a database hiccup must never turn a good generation into a failure, and
safety does not depend on it (the runner decides to requeue from `step.kind`, not from the table).

Those two functions are the only places in `src/` where a provider's `generate` is called, and every caller
reaches one of them: the job item and `runGeneration` (single, series post, regenerate, voice "Try it") go
through `runGenerationStep`; the series plan goes through `planSeries`. Wrapping at the point of **use**,
not of construction, means a provider injected by a test (`setLlmForTests`, `routeLlm`, `ctx.llm`) is
observed too, so the hold is exercised by the same tests that exercise everything else.
The write is awaited rather than fired and forgotten, so a tick's effect is visible to the next tick and to
the test that asserts it.
*Rejected:* wrapping inside `getLlm()` (couples `src/server/llm/` to the database, and makes `pnpm llm:check`
need `DATABASE_URL`); calling an `observeCredit(...)` helper at each call site (three sites to keep in step,
and the `LlmResult` would have to be threaded back out of `planSeries`'s helper); a Postgres trigger (no).
*Reverse:* return `llm` unchanged from `withCreditHold`.

**H13 — `pnpm llm:check` uses the same wrapper and tolerates having no database.**
`scripts/llm-check.ts` wraps `getLlm()` with `withCreditHold(…, INSTALL_CREDENTIAL_OWNER)` so a billing
refusal from the configuration check sets the hold and a success clears it (C11, FR-017). Because H12
swallows write errors, running `llm:check` without `DATABASE_URL` behaves exactly as it does today, and
`outcome=credit_exhausted` is printed with the existing non-zero exit for a failed check (US4 AS3).
*Rejected:* leaving `llm:check` unwrapped (C11 names it); requiring a database (it is a configuration check,
and an unconfigured install is not a failure).
*Reverse:* use `getLlm()` directly.

**H14 — `credit_exhausted` is added to neither `RETRYABLE` set, and `FAILURE_PROBLEM` gains no entry.**
`core.ts:66` and `series.ts:81` stay as they are, so the first call's failure returns straight away with no
second call (FR-006, C4): a correction retry cannot buy credit. `FAILURE_PROBLEM` is already
`Partial<Record<…>>`, so no exhaustiveness check forces an entry.
*Reverse:* n/a — this is the absence of a change.

### Surfacing

**H15 — One route-local notice component, rendering the `role="note"` shape the job page already uses.**
`JobNotice.tsx` renders `<p role="note" className="rounded-md border border-warning-border p-3 text-sm">`;
all three notices on the job page (not configured, tick budget, credit hold) and the one on the list page go
through it. The wording lives in `src/lib/jobs/credit-hold.ts` as fixed strings so one unit test owns it; the
component composes them with `<LocalTime value={since} timeZone={…} />`.
`Alert` is deliberately **not** used: its `warning` tone defaults to `role="alert"`, which is announced, and
FR-026 requires announcements no more aggressive than today's; `role="note"` is not announced, which is what
the two existing notices do. Routing the existing two through the same component keeps the rendered markup
identical when there is no hold (FR-026, SC-007), and adds no `src/components/ui/` primitive, so
`docs/design-system.md` needs no new row.
*Rejected:* `Alert tone="warning"` (more aggressive announcement, and a different shape from its two
neighbours on the same page — FR-023); `SetupNotice` (a prerequisites checklist, not a status note);
duplicating the markup in two files (the wording would drift).
*Reverse:* inline the `<p>` in both pages.

**H16 — The waiting row shows its reason only for a `queued` item whose kind is `credit_exhausted`.**
`JobItemsTable`'s `Detail` gains that one condition. The status badge stays `Queued`, the per-status counts
already count it as queued, and the retry control is already gated on `status === "failed"`, so FR-024 needs
no further change. Scoping to the one kind keeps a `queued` item that merely has an old `rate_limited` error
rendering exactly as it does today (SC-007).
*Rejected:* showing the reason for any `queued` item with an error (changes today's rows); a new badge or a
new item status (FR-025).
*Reverse:* restore `Detail`'s single `failed` condition.

**H17 — The fixed sentence names credit and what to do, and reads nothing like `bad_request`'s.**

```
credit_exhausted: "The model provider refused: the account has no credit or quota left. Add credit to the provider account."
```

It must work for every caller — a single generation, a stored failure, an API 503, a waiting job row and
`llm:check` — so it says nothing about jobs resuming; the *notice* carries that (FR-022). `bad_request`'s
already-landed sentence is untouched (C4, FR-005). `messages.test.ts`'s `toHaveLength(8)` becomes `9`.
*Rejected:* "out of credit, waiting items resume by themselves" (false for a single generation); naming the
provider or the account (FR-032).
*Reverse:* n/a.

**H18 — `credit_exhausted` maps to the existing 503 `generation_unavailable`, with no new API error code.**
`UNUSABLE` in `src/server/api/operations/generate.ts` is left alone, so the new kind falls to the
`generation_unavailable` branch: 503, `Retry-After: 30`, `details.kind = "credit_exhausted"` and the fixed
sentence. That is the honest reading — nothing about the request is wrong, and `docs/n8n.md` § 4 already tells
a caller that `generation_unavailable` means "retrying the same key later is safe". Adding it to `UNUSABLE`
would give 422 `generation_failed`, whose documented advice is "retry with a **new** key" — wrong.
No new error code, no new operation, and `JobItemSchema.error.kind` is already `z.string()` so a held item's
payload is not a contract change (US4 AS4).
*Rejected:* a new `generation_no_credit` code (Out of Scope: no new public-API operation, and a caller cannot
act on it differently); 422 (above).
*Reverse:* n/a.

**H19 — The secret-scan extension, and what proves it can fail.**
`tests/integration/security/secret-scan.test.ts` gains a generation section inside the same scanned run: a
real `createAnthropicProvider` / `createOpenAiProvider` over `createFakeLlmFetch` answering a billing refusal
whose body **message embeds `ENV.ANTHROPIC_API_KEY` / `ENV.OPENAI_API_KEY`**, the service result pushed as a
piece, a tick run against a held job, and both Batch jobs screens rendered held and pushed as pieces — so the
one scan covers logs, responses, stored rows and rendered UI for this path at once. The file's existing
"reports a deliberately leaked secret" test is what proves the scan can still fail.
`tests/integration/no-plaintext.test.ts` gains the two keys **and their SHA-256 hex** to its `secrets` list
(so "nor a hash of one" is actually checked) and creates a hold row before the all-tables dump, which already
walks `information_schema` and therefore covers `llm_credit_holds` with no new code.
`docs/security.md` extends the "Secrets in logs", "Secrets in responses", "Secrets in rendered UI" and
"Secrets in attempt logs and audit rows" rows' *What was checked* cells to name the billing-refusal path and
the new table, keeping all six columns and the `Accepted:`/`Fixed:` prefix that
`tests/integration/docs/security-findings.test.ts` enforces.
*Rejected:* exempting the new table or the new path (the roadmap forbids it); a separate new scan file (the
value of the existing one is that it is a single run with one capture).
*Reverse:* n/a — removing it would fail the roadmap rule.

---

## Where this plan goes beyond the spec

Both are additive, conservative and recorded above:

1. **Anthropic's `billing_error`** (A1, H3). The spec describes only the wording match. The SDK declares a
   billing error type, so matching it as well cannot cause a false positive and keeps detection alive through
   a rewording.
2. **Rewinding a probe that never reached a model call** (H7). The spec requires this only for the
   tick-budget case (FR-016); the same rule applied to a `finish` claim, a cancelled job, a lost lease or an
   exception costs nothing and is the only way "exactly one probe per interval" means one *call* per interval
   rather than one *attempt to find work*.

Neither widens the feature's scope, adds a dependency, or touches anything the spec lists as out of scope.
