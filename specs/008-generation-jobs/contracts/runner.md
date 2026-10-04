# Contract: the generation-jobs tick section

This contract covers `src/server/scheduler/generation.ts`, `src/server/services/jobs/runner.ts` and `src/server/dal/job-claims.ts`.

It follows the publishing pattern (002) at every step:

1. claim with `FOR UPDATE SKIP LOCKED` plus a lease;
2. do the slow work outside any held transaction;
3. persist under a lease-token check.

The section never throws into `runTick()`; a thrown error becomes `{ ok: false, error: "section_failed" }` for this section only (FR-015).

## Tick integration (`src/server/scheduler/index.ts`)

```ts
export interface TickSummary {
  // …existing…
  generation: SectionResult<GenerationCounts>;
}
const [publishing, tokenRefresh, generation] = await Promise.all([
  section("publishing", …), section("token refresh", …),
  section("generation jobs", () => runGenerationJobs({ config, tickId, startedAt }), emptyGenerationCounts()),
]);
```

```ts
export interface GenerationCounts {
  claimed: number;     // items claimed this tick (cap: config.jobMaxItems)
  done: number;        // items that reached `done` this tick
  failed: number;      // items that reached `failed` this tick
  retried: number;     // temporary failures sent back to `queued` with backoff
  deferred: number;    // correction retries deferred to a later tick (no attempt counted)
  released: number;    // items released uncounted (image prep or variant warm-up overran)
  recovered: number;   // expired leases picked up
  finishing: number;   // items finished without a model call (already had a post)
  cancelled: number;   // in-flight items whose job was cancelled (no post saved, or policy skipped)
  staleResults: number;// lease lost before persisting
  notConfigured: 0 | 1;
  notRunnable: 0 | 1;  // tick budget too short for any item (research D3)
}
```

- `writeHeartbeat("generation", now, counts)` runs at the end of each section run.
- `loop.ts`'s summary line gains `generated=<done> gen_failed=<failed>`.

## Config (`src/server/scheduler/config.ts`)

| Field | Source | Default |
|---|---|---|
| `jobMaxItems` | `GENERATION_TICK_MAX_ITEMS` (integer 1–10, `src/server/env.ts`, `.env.example`) | 2 |
| `jobMinCallMs` | constant | 8,000 |
| `jobPersistReserveMs` | constant | 3,000 |
| `jobMaxAttempts` | constant `JOB_ITEM_MAX_ATTEMPTS` | 3 |
| `jobBackoffBaseMs` / `jobBackoffMaxMs` | constants | 60,000 / 900,000 |
| `leaseMs` | existing `SCHEDULER_LEASE_SECONDS` | 300 s |

Every field can be overridden through `runTick({ config })` in tests. A unit test asserts that the minimum lease (60 s) is greater than the maximum budget (25 s) plus `jobPersistReserveMs` (FR-021).

## Section algorithm (`runGenerationJobs`)

```text
deadline = startedAt + timeBudgetMs
if !getLlmStatus().configured            → counts.notConfigured = 1; heartbeat; return   (items untouched, FR-022)
if timeBudgetMs < jobMinCallMs + jobPersistReserveMs → counts.notRunnable = 1; heartbeat; return
if now + jobMinCallMs + jobPersistReserveMs > deadline → heartbeat; return
claimed = claimDueJobItems({ now, limit: jobMaxItems, leaseMs, tickId })
await Promise.all(claimed.map(c => processClaimedItem(c, ctx).catch(recordInternal)))
heartbeat; return counts
```

## Claim (`dal/job-claims.ts`)

```ts
export interface ClaimedJobItem {
  item: JobItemRecord;            // after the claim patch
  job: JobRecord;                 // the locked job row at claim time
  token: string;                  // lease_owner written by this claim
  kind: "run" | "finish";         // finish = the item already has a post (no model call)
  recovered: boolean;             // the lease had expired
}
export function claimDueJobItems(opts: { now: Date; limit: number; leaseMs: number; maxAttempts: number }): Promise<ClaimedJobItem[]>;
```

The claim is one transaction inside `crossProject("scheduler: claim due job items")`. Its job and item selection is research D4. For each kept item:

| Item state at claim | Decision applied in the claim transaction |
|---|---|
| `queued` and due | `status: running`, `lease_owner: token`, `lease_until: now + leaseMs`, `started_at: coalesce(started_at, now)` → `kind: "run"` |
| `running` with an expired lease, has a post | new lease, `kind: "finish"`, `recovered: true` |
| `running` with an expired lease, no post, `attempt_count + 1 < maxAttempts` | `attempt_count + 1`, new lease, `kind: "run"`, `recovered: true` |
| `running` with an expired lease, no post, `attempt_count + 1 ≥ maxAttempts` | `status: failed`, lease cleared, `last_error_kind: interrupted`, `last_error: "Generation was interrupted too many times."`, `finished_at: now`. The item is not returned for processing |

Then, for each job touched:

- `last_claimed_at = now`;
- `refreshJobStatus(tx, job)`, which turns a `queued` job `running` and sets `started_at`.

## Runner scope

```ts
/** A ProjectScope pinned to one project, with no session (research D11). Never writes membership.userId. */
export function forJobRunner(projectId: string, actorUserId: string | null): Promise<ProjectScope>;
```

## Item processing (`processClaimedItem`)

```text
scope = forJobRunner(job.projectId, job.createdByUserId)
remaining() = deadline − clock.now()

if kind == "finish": goto FINISH(postId from findByJobItemId(includeDeleted))

existing = posts.findByJobItemId(item.id, { includeDeleted: true })
if existing: goto FINISH(existing.id)                                  (FR-018: no model call)

voice    = voiceVersions.get(job.voiceProfileVersionId)                (pinned; archived profile is fine)
accounts = job.targetAccountIds → accounts.get(id), dropping missing/removed
if accounts empty: FAIL(no_targets, "No target accounts left.")        (lasting)
asset    = item.mediaAssetId ? media.get(id) : null
if item.mediaAssetId && !asset: FAIL(image_deleted, "Image deleted.") (lasting, no model call)

if asset:
  prepared = withinBudget(imagesForModel(scope,[asset]), remaining() − jobMinCallMs − jobPersistReserveMs)
  overran → RELEASE (no attempt);  not ok → FAIL(image_unavailable, message)

window = min(llmTimeoutMs, remaining() − jobPersistReserveMs)
if window < jobMinCallMs: RELEASE (no attempt)

step = runGenerationStep(scope, req(timeoutMs = window, itemData, instructions = renderTemplate(mark), brief = source brief),
                         llm, { pending: item.pendingRetry,
                                retryWindowMs: () => w = min(llmTimeoutMs, remaining() − jobPersistReserveMs); w ≥ jobMinCallMs ? w : null })

step.ok == "retry"  → DEFER: lease-checked update { status: queued, pending_retry: step.pending, lease cleared, next_attempt_at: now }   (no attempt)
step.ok == false    → temporary kind? RETRY_LATER : FAIL(kind, llmFailureMessage(kind))
step.ok == true     → SAVE

SAVE (one transaction, scope.transaction):
  lock job FOR UPDATE                         → cancelled? abort → counts.cancelled
  jobItems.updateWithLease(item, token, { pending_retry: null }) → no row? abort → counts.staleResults
  postId = saveGeneratedPost(tx, { …, record(mode "job_item", job link), createdByUserId: job.createdByUserId,
                                     link: { generationJobItemId: item.id } })
  refreshJobStatus(tx, job)
  unique violation on posts_generation_job_item_uq → goto FINISH(winner)

FINISH(postId):
  post = posts.get(postId)
  if post && post.reviewState == "needs_review" && lastRecord(post)?.policies.decision == null:
     withinBudget(prepareVariants(scope, postId), remaining()) overran/failed → RELEASE_FINISHING: lease-checked update { lease_until: now }
       (stays running with its post and an already-expired lease, so the next tick claims it as kind "finish")
     applyApprovalPolicy(scope, postId, job.resolved, { guard: tx => lock job FOR SHARE; require !cancelled && lease_owner == token })
       guard failed → counts.cancelled (post stays in review)
       ConflictError("already reviewed") → continue
  DONE: one transaction: lock job FOR UPDATE; updateWithLease(item, token, { status: done, lease cleared, finished_at: now, pending_retry: null });
        refreshJobStatus

RETRY_LATER: attempts = attempt_count + 1; attempts ≥ jobMaxAttempts → FAIL; else lease-checked update
             { status: queued, attempt_count: attempts, next_attempt_at: nextRetryAt(now, attempts, jobBackoff), lease cleared,
               last_error_kind, last_error }
FAIL(kind, message): job lock; lease-checked update { status: failed, lease cleared, last_error_kind, last_error, finished_at: now,
                     pending_retry: null }; refreshJobStatus
RELEASE: job lock; lease-checked update { status: queued, lease cleared }   (attempt_count unchanged)
any unexpected exception → RETRY_LATER(internal, "Something went wrong while generating this post.")   (FR-017)
```

Rules that hold on every path:

- Every write after the claim is lease-checked (`WHERE lease_owner = token`) and holds the job lock first (research D9).
- A lost lease writes nothing more and counts `staleResults`.
- No model call, storage call or sharp work happens inside a held transaction.
- A thrown error is caught per item. It never reaches `Promise.all` and never touches another item (FR-017).
- The model call's `timeoutMs` always ends before `deadline − jobPersistReserveMs`, so a tick that processes items finishes within its budget plus the DB time of at most two short transactions (SC-006).

## Errors

| Kind | Class | Message stored on the item |
|---|---|---|
| `timeout`, `rate_limited`, `unavailable`, `invalid_output`, `refused`, `incomplete`, `auth`, `bad_request` | as in research D7 | `llmFailureMessage(kind)` (007, fixed sentences) |
| `internal` | temporary | "Something went wrong while generating this post." |
| `interrupted` | temporary, then failed at the cap | "Generation was interrupted too many times." |
| `image_deleted` | lasting | "Image deleted." |
| `image_unavailable` | lasting | the `imagesForModel` message (names the image, never a URL or key) |
| `no_targets` | lasting | "No target accounts left." |

After 3 temporary failures, the item is failed with its last kind and message.

## Logging

Each item writes one line:

```text
generation_job_item job=<id> item=<id> outcome=<done|failed:kind|retried:kind|deferred|released|stale|cancelled> latency_ms=<n>
```

- The line holds ids, outcome and timing only: no prompt, no field values and no error text from an SDK.
- It is passed through `redact()` with the configured key as a backstop (constitution VII).
- The model call itself is logged by the existing `llm/log.ts` line.
