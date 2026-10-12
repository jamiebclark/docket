# Contract — DAL, services, runner and tick

Signatures, outcomes and errors for everything between the provider layer and the screens.

## 1. `src/server/dal/credential-owners.ts` — the FR-012 seam (NEW)

```ts
/** The install's env-configured credential: the only credential owner that exists today (C7). */
export const INSTALL_CREDENTIAL_OWNER = "install";

/**
 * Who owns the credential a call for this project would spend (FR-012).
 * Today: the install's one credential, whatever the project. Entry 2 (per-project-llm) changes only
 * this function and the owner values it returns — nothing else in the hold, the probe, the claim or the
 * notices moves (SC-010).
 * Async on purpose: entry 2 must read the project's stored credential to answer.
 */
export function credentialOwnerFor(projectId: string): Promise<string>;

/**
 * A predicate over `generation_jobs` keeping only jobs whose credential owner is NOT in `owners`.
 * `undefined` when `owners` is empty, so the claim's statement is unchanged with no hold in place.
 * Today every job has the one install owner, so a non-empty set keeps nothing.
 * Entry 2 replaces the body with a condition on the project's credential.
 */
export function jobsExcludingOwners(owners: readonly string[]): SQL | undefined;
```

Invariants the unit test pins (`src/server/dal/credential-owners.test.ts`):

- `credentialOwnerFor(anyProjectId)` resolves to `INSTALL_CREDENTIAL_OWNER` for any input, including an
  empty string.
- `jobsExcludingOwners([])` is `undefined`.
- `jobsExcludingOwners([INSTALL_CREDENTIAL_OWNER])` is a predicate that matches nothing.
- `jobsExcludingOwners(["someone-else"])` is `undefined` — an owner that does not exist today blocks nothing.
- The owner value is never derived from, and never contains, an API key or any part of one (FR-020).

## 2. `src/server/dal/credit-holds.ts` — the one hold module (NEW)

The **only** reader and writer of `llm_credit_holds` (FR-030).

```ts
/** One item every five minutes while held. A documented constant, not an environment variable (FR-014). */
export const CREDIT_PROBE_INTERVAL_MS = 5 * 60_000;

export interface CreditHold {
  owner: string;
  heldSince: Date;
  lastRefusalAt: Date;
  nextProbeAt: Date;
}

/**
 * A billing refusal: create the owner's hold, or refresh an existing one and push the next probe out one
 * interval (FR-011, FR-016). `heldSince` is not moved by a refresh.
 */
export function holdCredit(owner: string, now: Date): Promise<void>;

/** Any other call outcome: the owner is spending again (FR-017). No-op when there is no hold. */
export function clearCreditHold(owner: string): Promise<void>;

/**
 * Inside the claim transaction (FR-015): who is held, and which of them won this tick's probe.
 * `probing ⊆ held`. A held owner whose row another tick already locked is in `held` and not in `probing`,
 * so this tick claims nothing for it.
 */
export function gateCreditHolds(exec: Database, now: Date): Promise<{ held: string[]; probing: string[] }>;

/** Give a granted probe's interval back, because no model call was made (FR-016, H7). Update only. */
export function rewindCreditProbe(owner: string, now: Date): Promise<void>;

/** For the screens and the tests. */
export function readCreditHold(owner: string): Promise<CreditHold | null>;
export function readCreditHolds(): Promise<CreditHold[]>;
```

Guarantees:

| Guarantee | How |
|---|---|
| at most one hold per owner | primary key; `holdCredit` upserts |
| exactly one probe per interval per owner, across any number of workers | `gateCreditHolds` locks with `SKIP LOCKED` and writes `next_probe_at` in the same transaction (FR-015) |
| the claim never waits | `SKIP LOCKED`, and an unlockable row is treated as held-and-not-probing |
| no session-level Postgres feature | row locks only, transaction-scoped (Neon constraint) |
| a cleared hold is never resurrected | `rewindCreditProbe` is an `UPDATE`; only `holdCredit` inserts |
| no credential value or fingerprint is ever written | the module writes four values: an owner and three instants, and takes no key parameter |
| no hold expires on its own | there is no expiry statement and no `expires_at` column (FR-019) |

## 3. `src/server/services/generation/credit.ts` — the observation point (NEW)

```ts
/**
 * The provider, with credit-hold tracking (FR-017). Delegates `generate` and returns its result unchanged;
 * in between, a billing refusal sets or refreshes the owner's hold and every other outcome clears it.
 * Hold-write failures are swallowed: a database hiccup must never turn a good generation into a failure,
 * and the runner's decision not to fail an item comes from `result.kind`, not from the table.
 */
export function withCreditHold(llm: LlmProvider, owner: string): LlmProvider;
```

| Outcome of the inner `generate` | Hold effect |
|---|---|
| `{ ok: true }` | `clearCreditHold(owner)` |
| `{ ok: false, kind: "credit_exhausted" }` | `holdCredit(owner, now)` |
| `{ ok: false, kind: anything else }` — `timeout`, `invalid_output`, `refused`, `incomplete`, `rate_limited`, `unavailable`, `auth`, `bad_request` | `clearCreditHold(owner)` — the account is spending again (C9, US2 AS2) |
| the inner `generate` throws (programmer error) | nothing; the throw propagates unchanged |

The write is **awaited**, so the next tick and the asserting test both see it.

### Where it is applied

| Call site | Covers |
|---|---|
| `runGenerationStep` (`src/server/services/generation/core.ts`), wrapping its `llm` argument once at the top | the job item, and — through `runGeneration` — single, series post, regenerate and voice "Try it" |
| `planSeries` (`src/server/services/generation/series.ts`), the same | the series plan |
| `scripts/llm-check.ts`, wrapping `getLlm()` with `INSTALL_CREDENTIAL_OWNER` | `pnpm llm:check` (C11); works unchanged with no `DATABASE_URL`, because the write errors are swallowed |

These are the only places in `src/` where a provider's `generate` is called, so every caller is covered with
no per-caller logic — including a provider injected by a test through `setLlmForTests`, `routeLlm` or
`ctx.llm`, which is what lets the ordinary job tests exercise the hold.

The owner comes from `credentialOwnerFor(scope.project.id)` in both service call sites.

## 4. `src/server/dal/job-claims.ts` — the claim

```ts
export interface ClaimedJobItem {
  item: JobItemRecord;
  job: JobRecord;
  token: string;
  kind: "run" | "finish";
  recovered: boolean;
  /** This job's credential owner, from the one named seam (FR-012). */
  owner: string;                      // NEW
  /** This item is the one a held owner was allowed through as a probe (FR-014). */
  probe: boolean;                     // NEW
}

export interface ClaimResult {
  items: ClaimedJobItem[];
  /** Owners that had a hold at claim time (FR-021). */
  held: string[];
  /** Those granted this tick's probe; `probing ⊆ held`. */
  probing: string[];
}

export function claimDueJobItems(opts: {
  now: Date; limit: number; leaseMs: number; maxAttempts: number;
}): Promise<ClaimResult>;           // was Promise<ClaimedJobItem[]>
```

Order of work inside the one existing transaction:

1. `gateCreditHolds(exec, now)` → `{ held, probing }`; `blocked = held \ probing`.
2. The job `SELECT` gains `jobsExcludingOwners(blocked)` — omitted entirely when `blocked` is empty, so with
   no hold the statement is unchanged (FR-031, SC-007).
3. Per job, the due-item predicate is `queuedDue` for a probing owner and today's `itemDue` for everyone
   else, so a probe can never reach the recovery branch that counts an attempt or fails an item as
   `interrupted` (US1 AS5, FR-019).
4. Round-robin and keep, respecting `budgetFor(owner) = probing.has(owner) ? 1 : opts.limit` as well as the
   global `limit`.
5. Each kept item is stamped with its `owner` and `probe = probing.has(owner)`.
6. For every probing owner that ended with **zero** kept items, `rewindCreditProbe(owner, now)` inside this
   transaction — the interval was not spent (FR-016).
7. Today's `lastClaimedAt` and `refreshJobStatus` work for touched jobs, unchanged.

Unchanged: `FOR UPDATE SKIP LOCKED` on jobs and items, `lastClaimedAt ASC NULLS FIRST` ordering, the
round-robin interleave, the lease write, the `finish` detection, the `interrupted` rule for a non-held owner,
and the `crossProject("scheduler: claim due job items")` wrapper.

Callers to update: `src/server/scheduler/generation.ts`, `tests/integration/jobs/recovery.test.ts`,
`tests/integration/jobs/dal.test.ts` — mechanical (`.items`), relaxing no assertion.

## 5. `src/server/scheduler/generation.ts` — the tick section

```ts
export interface GenerationCounts {
  // … existing fields, all unchanged …
  /** Items a billing refusal sent back to the queue with no attempt counted (FR-009). */
  requeued: number;                   // NEW
  /** At least one credential owner was held, so its items were not claimed (FR-021). */
  held: 0 | 1;                        // NEW
  /** A held owner was allowed one item through as a probe this tick (FR-021). */
  probed: 0 | 1;                      // NEW
}
```

`runGenerationJobs` changes in two places and nowhere else:

```ts
const claim = await claimDueJobItems({ now, limit: cfg.maxItems, leaseMs: cfg.leaseMs, maxAttempts: cfg.maxAttempts });
counts.claimed  = claim.items.length;
counts.recovered = claim.items.filter((c) => c.recovered).length;
counts.held     = claim.held.length > 0 ? 1 : 0;        // NEW
counts.probed   = claim.probing.length > 0 ? 1 : 0;     // NEW
await Promise.all(claim.items.map((c) => processClaimedItem(c, { config, deadline, counts }).catch(…)));
```

Ordering that must not move: the `getLlmStatus().configured` check and the `timeBudgetMs < needed` check stay
**first**, so a not-configured or not-runnable install never reaches the gate — nothing about holds applies
and the existing notices are what show (spec edge cases). The `now + needed > deadline` check also stays
before the claim, so a tick too short to start anything never spends a probe interval (FR-016).

`held` and `probed` reach the heartbeat for free: `writeHeartbeat("generation", …, { ...counts })` spreads the
whole object, the same route `notConfigured` and `notRunnable` take (FR-021).

## 6. `src/server/services/jobs/runner.ts` — the item

```ts
type ErrorKind = NonNullable<JobItemPatch["lastErrorKind"]>;
const TEMPORARY = new Set<ErrorKind>(["timeout", "rate_limited", "unavailable", "internal", "interrupted"]);
//                                   ^ UNCHANGED: credit_exhausted is deliberately absent (FR-010, C6)
```

The dispatch becomes three-way:

```ts
if (step.ok === false) {
  const kind: LlmFailureKind = step.kind;
  if (kind === "credit_exhausted") return await requeueForCredit();
  return TEMPORARY.has(kind) ? await retryLater(kind, llmFailureMessage(kind))
                             : await fail(kind, llmFailureMessage(kind));
}
```

```ts
/** A billing refusal never fails an item (FR-007..FR-009, C5). */
async function requeueForCredit(): Promise<void> {
  const ok = await commit({
    status: "queued",
    nextAttemptAt: await clock.now(),              // immediately due
    ...UNLEASED,                                   // lease released cleanly
    pendingRetry: null,                            // in-request correction state cleared
    lastErrorKind: "credit_exhausted",
    lastError: llmFailureMessage("credit_exhausted"),
  });                                              // attemptCount deliberately not written
  if (ok) { counts.requeued++; outcome = "requeued:credit_exhausted"; }
}
```

| Property | How it holds |
|---|---|
| lease-checked like every other post-claim write | it goes through the same `commit()`, which locks the job and calls `updateWithLease`; a lost lease counts `staleResults` (FR-009) |
| job status recomputed | `commit`'s default `refresh: true`; a no-op in practice because `queued + running` does not change, which is why no job becomes `completed_with_failures` (FR-008) |
| an already-saved post is left alone | `findByJobItemId` routes such an item to `finish()` long before the model call (FR-009) |
| its own tick outcome | `counts.requeued`, distinct from `failed`, `retried`, `released` and `deferred` (FR-009) |
| no attempt counted | `attemptCount` is not in the patch |
| no secret in the log line | `outcome=requeued:credit_exhausted` only, through the existing redacting `logLine` (FR-032) |

### The probe rewind

```ts
let calledModel = false;              // set true immediately after runGenerationStep returns
// … in the existing finally, before/with the log line:
if (claimed.probe && !calledModel) await rewindCreditProbe(claimed.owner, await clock.now());
```

So a probe spends its interval only when a model call was actually made. It is given back when the item was
released for tick budget, found an existing post and went to `finish()`, was skipped on an `externalId`, had
its job cancelled, lost its lease, or threw before the call (FR-016, H7). `rewindCreditProbe` is an update
only, so a hold cleared by a concurrent success is not recreated.

Unchanged in this file: `TEMPORARY`, `retryLater`, `fail`, `release`, `skip`, `finish`, the `Overran`
budget rules, the `GuardLost` policy guard, the unique-violation recovery and the `internal` catch-all.

## 7. `src/server/services/jobs/read.ts` — what the screens read

```ts
/**
 * The billing pause covering this project, or null (FR-022). Install-wide today, because there is one
 * credential owner (C7); keyed by owner, so entry 2 narrows it with no change here.
 */
export async function generationCreditHold(scope: ProjectScope): Promise<{ since: Date } | null>;
```

Implementation: `readCreditHold(await credentialOwnerFor(scope.project.id))`, mapped to `{ since: heldSince }`.
Permission: `canView(scope)` — the same `post: ["view"]` gate the rest of the module uses, so every role that
can already see Batch jobs sees the notice and nothing more (FR-027). The result carries the instant only,
never the owner, the provider or anything about the credential.

`getJob()` gains one field beside the existing `generationConfigured` and `jobsRunnable`:

```ts
  /** The billing pause covering this project, or null (FR-022). */
  creditHold: { since: Date } | null,
```

`listJobs`, `JobListItem`, `listJobItems` and `JobItemView` are **unchanged**; the list page calls
`generationCreditHold(scope)` itself. Because every public-API mapper (`toApiJobSummaryFromList`,
`toApiJob`, `toApiJobItem`) lists its fields explicitly, no API payload changes (US4 AS4, SC-007).

## 8. The public API

No new operation, schema or error code.

| Path | Behaviour |
|---|---|
| `POST /v1/generate` during a billing refusal | `credit_exhausted` is **not** in `UNUSABLE`, so the existing branch returns **503 `generation_unavailable`** with `Retry-After: 30`, `details.kind = "credit_exhausted"` and the fixed sentence as the message. `docs/n8n.md` § 4 already says that retrying the same idempotency key later is safe (H18) |
| `GET /v1/jobs/{id}/items` for a held job | each waiting item is `status: "queued"` with `error: { kind: "credit_exhausted", message: <fixed sentence> }`; `JobItemSchema.error.kind` is already `z.string()`, so the schema is unchanged (US4 AS4) |
| `GET /v1/jobs/{id}` for a held job | `counts.queued` includes the waiting items and `counts.failed` does not move; `status` stays `queued`/`running` (FR-024, FR-025) |
| every other operation | unchanged |

## 9. Unaffected, and asserted to be so

- `getLlmStatus()`, `getLlm()`, `parseLlmConfig`, `setLlmForTests` and `LlmNotConfiguredError`: unchanged.
  `src/server/llm/` gains no database dependency.
- `RETRYABLE` in `core.ts` and `series.ts`: unchanged, so no in-request correction retry can reach the new
  kind (FR-006, C4).
- `retryItem`, `retryFailedItems`, `cancelJob` and `closeJob` in `src/server/services/jobs/manage.ts`:
  unchanged. "Retry failed items" during a hold resets items to due and they then wait instead of failing;
  cancelling a held job cancels its items and releases its images, and leaves the hold alone because the hold
  belongs to the credential, not the job (FR-019, spec edge cases).
- `refreshJobStatus`, `deriveJobStatus` and the webhook `job.finished` emission: unchanged.
- The media reservation rule: unchanged — a reservation is an item in `queued`/`running`/`failed`, and a
  requeued item is `queued` (FR-019).
