# Contract: the `runInsightsPoll` tick section

**Feature**: 080-insights-core-bluesky | **File**: `src/server/scheduler/insights-poll.ts`

One new section in `runTick()`, concurrent with the rest, modelled on
`src/server/scheduler/engagement-read.ts`.

---

## 1. Where it runs

```text
runTick()
├── publishing                                    ─┐
├── token refresh, generation, housekeeping, …      │ concurrent, one shared deadline
├── webhooks, email, standing series                │
├── engagement read                                 │
├── insights poll            NEW, concurrent       ─┘
└── engagement send          (awaited after publishing resolves, unchanged)
```

Insights is **not** sequenced after publishing. It only reads, so it never competes with publishing
for the account's write path; the allowance reserve (§4) is the whole of the protection FR-048
requires. Research §6.

`src/server/scheduler/index.ts` gains one `section(...)` entry in the existing `Promise.all`, one
`TickSummary` field (`insightsPoll: SectionResult<InsightsPollCounts>`) and one import. A throw
inside the section is caught by the existing `section()` wrapper, which logs the message and returns
`{ ok: false, counts: emptyInsightsPollCounts(), error: "section_failed" }` — so a failure is
contained and no other section is affected (FR-038, US4-AS2).

## 2. The counts (FR-036)

```ts
export interface InsightsPollCounts {
  targetsClaimed: number;
  accountsClaimed: number;
  postSnapshotsWritten: number;
  accountSnapshotsWritten: number;
  targetsFrozen: number;           // age reached the freeze boundary
  postsGone: number;               // the platform no longer returns the post
  targetsSkippedNoExternalId: number;
  deferredForAllowance: number;
  retried: number;                 // retryable_error + fatal_error
  rateLimited: number;
  credentialsInvalid: number;
  unavailable: number;
  failed: number;                  // a read that produced no snapshot and no classified stop
  outOfBudget: number;             // times it stopped claiming or calling for want of time
}

export const emptyInsightsPollCounts = (): InsightsPollCounts => /* every key 0 */;
```

Every key is present on every run, including a run that did nothing (US4-AS1). `writeHeartbeat(
"insights_poll", now, { ...counts })` is called **unconditionally** at the end of the section, before
it returns, on every path including the out-of-budget one (FR-037).

`outOfBudget` is what distinguishes "nothing was due" (every count zero) from "the section ran out of
time" (`outOfBudget >= 1`, everything else zero) without reading a log line — SC-007.

## 3. The flow

```text
insightsConfig(config)  →  deadline = startedAt + floor(timeBudgetMs × INSIGHTS_TIME_SHARE)

providerKeys = listProviders()
  .filter(p => p.insights && !p.insights.declaration.unavailable)   ← FR-003: never claimed
  .map(p => p.key)
if providerKeys is empty → write the heartbeat with zeroes and return      ← SC-010

if (deadline − now) < providerTimeoutMs → outOfBudget++, heartbeat, return  ← FR-035

accounts = claimDueAccountMetricPolls({ limit: INSIGHTS_ACCOUNTS_PER_RUN, … })
targets  = claimDuePostMetricPolls({ limit: INSIGHTS_TARGETS_PER_RUN, … })
targetsSkippedNoExternalId = countPublishedWithoutExternalId(providerKeys)   ← FR-039

group targets by socialAccountId
for each account with claimed work, concurrently (Promise.all, as engagement-read does):
    processAccount(account, claimedTargets, claimedAccountState?)
```

`processAccount`, per account:

```text
1. decrypt credentials (failure → release every lease, lastError "Stored credentials are
   unreadable.", failures+1, next_poll_at = nextRetryAt(...), failed++)
2. parse settings through provider.settingsSchema (same handling)
3. budget = stricterBudget(provider.insights.declaration.readBudget, accountPublishLimit)
   since  = windowStart(now, budget)
   used   = writesStartedSince(projectId, accountId, since).length
          + postSnapshots.countForAccountSince(accountId, since)
          + accountSnapshots.countForAccountSince(accountId, since)
   if used >= reserveFloor(budget, INSIGHTS_READ_RESERVE):
       release every lease, leave next_poll_at UNCHANGED (still due),
       deferredForAllowance++, no lastError, no failure count     ← FR-045, FR-046
       return
4. for each batch of min(INSIGHTS_READ_PAGE_SIZE, maxPostsPerRead) targets:
       if (deadline − now) < providerTimeoutMs: outOfBudget++, release remaining leases, break
       result = await provider.insights.readPostMetrics({ …, signal: AbortSignal.timeout(providerTimeoutMs) })
                   ← OUTSIDE any transaction (constitution: no provider call in a held transaction)
       commit this batch in ONE transaction (§5)
5. if an account poll was claimed and time remains:
       result = await provider.insights.readAccountMetrics({ … })
       commit in one transaction
6. (every lease released on every path, including every throw)                ← FR-033
```

A `try/finally` around each account's work releases any lease still held, so a throw mid-batch
cannot leave a lease outstanding beyond the `finally` (and even if the process dies, the lease
expires and a later tick reclaims it with no manual step — FR-033, SC-008).

## 4. Mapping each result (FR-040, FR-042, FR-043)

| Result | Snapshot | `consecutive_failures` | `next_poll_at` | `frozen` | Count |
|---|---|---|---|---|---|
| `page`, entry `metrics`, schema valid | inserted | ← 0, `failing_since` ← NULL | `nextPostPollAt(publishedAt, capturedAt=now, now)`; `NULL` if that returns `null` | `settled` when `NULL` | `postSnapshotsWritten++`, `targetsFrozen++` if frozen |
| `page`, entry `metrics`, schema invalid or oversized | **none** | +1 | `nextRetryAt(now, failures+1, config)` | — | `failed++` |
| `page`, entry `gone` | none | **unchanged (0)** | `NULL` | `gone` | `postsGone++`, `targetsFrozen++` |
| `retryable_error` / `fatal_error` | none | +1 | `retryAt ?? nextRetryAt(...)` | — | `retried++` |
| `rate_limited` | none | **unchanged** | `retryAt ?? nextRetryAt(now, failures+1, config)` | — | `rateLimited++` |
| `credentials_invalid` | none | +1 | unchanged | — | `credentialsInvalid++`, `markInvalidEmitting(...)` |
| `unavailable` | none | unchanged | unchanged | — | `unavailable++`, lease released, nothing else changed |
| allowance refusal (before any call) | none | unchanged | **unchanged — still due** | — | `deferredForAllowance++` |

Rules this table encodes:

- **A failed read never advances a target's schedule as though it had succeeded** (FR-043): only the
  `metrics`-and-valid row sets `next_poll_at` from the cadence; every other row sets it from the
  backoff or leaves it alone.
- **`last_captured_at` is written only when a snapshot was inserted**, so the cadence is always
  computed from a real capture.
- **Snapshots already committed in an earlier batch stay committed** when a later batch stops on a
  failure (FR-043): the commit is per batch, not per account.
- **One `gone` entry freezes one target** and the other entries in the same response are stored
  normally (FR-042, US2-AS6).
- **Every `error`, `reason` and `last_error` passes through
  `redact(text, secretValues(credentials))`** before it is written, logged or returned (FR-041).
- **No activity event and no notification is written for a success** (FR-044). The only emission is
  `markInvalidEmitting` on `credentials_invalid`, which is the existing generic needs-reauth path.

## 5. Transaction boundaries

```text
claim (one transaction)        : create missing state rows, SELECT … FOR UPDATE OF <state> SKIP LOCKED,
                                 stamp leases. Touches the poll-state tables only.         ← FR-032
provider call                  : no transaction held.
commit per batch (one transaction):
    for each entry → postMetricSnapshots.insertIfAbsent(…)   (ON CONFLICT DO NOTHING)
    for each entry → postMetricPollStates.update(id, patch, expectedLeaseOwner = token)
account commit (one transaction): accountMetricSnapshots.insertIfAbsent + poll-state update
```

`FOR UPDATE` names only the poll-state table, so a publish holding `post_targets` or
`social_accounts` never blocks a claim and a claim never blocks a publish (FR-032, SC-008). There is
exactly **one** row class locked per transaction in the claim and two in the commit (snapshot insert,
then its own state row) — and because the commit only ever touches rows the caller already leased,
no two transactions in this section ever want the same two rows in a different order, so there is no
lock-order pair to get wrong (research §4).

`expectedLeaseOwner` conditions every state write on the lease still being ours, so a worker whose
lease already expired and was reclaimed cannot clobber the newer tick's progress — 077's
stale-result guard, reused verbatim.

## 6. Housekeeping (FR-073)

`runHousekeeping` gains two calls and two counts:

```ts
const postMetricSnapshotsPruned = await prunePostMetricSnapshots(config, await now());
const accountMetricSnapshotsPruned = await pruneAccountMetricSnapshots(config, await now());
```

Each is one bounded batch of `INSIGHTS_PRUNE_BATCH`, cross-project, deleting only rows whose
`captured_at` is older than `INSIGHTS_RETENTION_DAYS`. Neither deletes a poll state, a target, a post
or an account (FR-074).

## 7. Test helper

`tests/helpers/scheduling.ts` gains `parkAllInsightsPolls()`, after `parkAllEngagementReads()`: it
creates the missing poll-state rows for every account and target on the worker's database and sets
`next_poll_at = PARKED_UNTIL`, so one file's claims are not filled by accounts another file left
active. `parkAllTickWork()` (the existing aggregate) calls it. Every `runTick` in a new test pins
`timeBudgetMs` via `tickConfig()` — `tests/lint/tick-budget.test.ts` fails the build otherwise.
