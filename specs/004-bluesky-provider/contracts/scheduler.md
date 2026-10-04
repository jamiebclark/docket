# Contract: engine changes (G2, G3, G4)

These are generic changes in `src/server/scheduler/` and `src/server/dal/`. No Bluesky-specific code and no schema change. Every behaviour below is proven with a throwaway test provider registered via `registerTestProvider`, as well as with Bluesky.

## 1. Claim: `stepFor` gets the content shape (G4)

`runPublishing` → `claimDueTargets({ decide })`:

```ts
const shape = await ctx.contentShape(target);            // { text, mediaCount } | null — DB read in the claim tx
const info = provider.stepFor(target.stepState, settings, shape ?? { text: "", mediaCount: 0 });
```

- `ClaimContext.contentShape` is new ([data-model §7](../data-model.md#7-dal-additions-generic-scheduler-internal)).
- Order inside `decide` is unchanged:
  1. recovery;
  2. the account-unavailable check;
  3. the max-duration check;
  4. the limit check (first step only);
  5. settings parse;
  6. **content shape**;
  7. `stepFor`;
  8. lease.
- **`execute`**: if `effectiveContent` returns `null` (the post is gone), the result is `fatal_error` "The post is no longer available." with no provider call. Previously this was a generic throw, which made it `ambiguous` on a `mayPublish` step.
- `advance` receives `step: { name: lease.step, mayPublish: lease.mayPublish }`.

## 2. Publish-time refresh (`execute`)

New module `src/server/scheduler/credentials.ts`:

```ts
type PublishRefresh =
  | { kind: "refreshed"; credentials: unknown; ciphertext: string }        // we refreshed and persisted
  | { kind: "changed"; credentials: unknown; ciphertext: string }          // someone else already did; re-read
  | { kind: "busy" }                                                       // another caller holds the refresh lease
  | { kind: "unavailable" }                                                // removed / not active / no credentials
  | { kind: "transient"; reason: string; retryAt?: Date }                  // G3: account stays active
  | { kind: "refused"; reason: string };                                   // account now needs_reauth

refreshForPublish(input: {
  projectId: string; account: ClaimedAccount; provider: SocialProvider;
  seenCiphertext: string | null; config: SchedulerConfig;
}): Promise<PublishRefresh>
```

### Algorithm

1. `token = randomUUID()`, then `acquireRefreshLease(account.id, token, { now: clock.now(), leaseMs: config.leaseMs, expectedCiphertext: seenCiphertext })`.
   - `changed`: re-read the ciphertext, decrypt it, and return `changed`.
   - `busy` / `unavailable`: return as is.
2. Decrypt, then call `provider.refreshCredentials({ …, signal: AbortSignal.timeout(providerTimeoutMs) })` inside `withTimeout(providerTimeoutMs)`.
3. Hand the result to the **shared** `applyRefreshResult(repos, accountId, token, result, secrets)` (§3).
   - Success: `kind: "refreshed"`, returned **only if `recordRefresh` returned true**. If the lease was lost, the result is `transient` "Lease lost while renewing credentials."
   - A thrown error or a timeout in step 2 is treated as `{ ok:false, transient:true }`. The lease is released with `recordRefresh(token, { lastError })`.

### `execute` integration (after media resolution and decrypt, before `advance`)

```text
if provider.refreshCredentials && provider.needsRefresh?.(credentials, now):
    if now + providerTimeoutMs > deadline:  release(lease)  → return            # existing release path, no attempt counted
    r = refreshForPublish(...)
    switch r.kind:
      refreshed | changed  → credentials = r.credentials; secrets ∪= secretValues(r.credentials)
                             if now + providerTimeoutMs > deadline: release(lease) → return   # creds are persisted; next tick publishes
      busy | unavailable   → release(lease, error: "Waiting for account credentials to be renewed." | "The account needs reconnecting.") → return
      refused              → release(lease, error: "The account needs reconnecting.") → return   # next claim fails it via account_unavailable (002)
      transient            → result = { kind: "retryable_error", error: "Could not renew the account's session; will retry.", notBefore: r.retryAt }
                             → skip advance, record as usual
result = advance(ctx)        # unchanged otherwise
record(result)               # unchanged: applyStepResult + recordStepResult
if result.kind === "retryable_error" && result.credentialsExpired && provider.refreshCredentials
   && now + providerTimeoutMs <= deadline:
    refreshForPublish(...)   # outcome only affects the account (refused → needs_reauth); the target is already recorded
```

- `release(lease, error?)` is the existing "out of budget" branch, extracted into a function. It restores `lease.before`, keeps `attemptCount`, and writes a `released` attempt (with an optional `error`).
- The reactive refresh runs **after** the result is recorded, so a slow refresh can never hold back the target's own record.
- `credentialsExpired` is ignored on result kinds other than `retryable_error`. It does **not** change backoff or attempt counting: `applyStepResult` is unchanged.

### Guarantees

- **FR-022, serialised**: one refresh lease per account, shared with the scheduled section. The loser either reuses the persisted credentials (`changed`) or releases and retries next tick (`busy`). It never refreshes a second time.
- **FR-022, persist before use**: credentials reach `advance` only after `recordRefresh` succeeded under the caller's token.
- **FR-023, not the may-publish request**: refresh runs outside `advance` and is never covered by `inFlightMayPublish`. A crash during refresh leaves the target lease to expire.
  - On a `mayPublish` step, expiry is treated as `recovered_ambiguous` (002's conservative rule). This is the same accepted outcome as media resolution in 003 (decision "Media-resolution recovery"). It is recorded again for refresh in `docs/decisions.md`.
  - The window is one refresh call. Bluesky's proactive refresh runs only when the token is within 5 minutes of expiry.
- **FR-024**: `refused` → `needs_reauth` with a redacted reason. `transient` → the target is retryable and the account stays `active`.
- **Bounded**: at most one refresh before `advance` and one after, each within `providerTimeoutMs`. Each is skipped when it does not fit the tick deadline.

## 3. Shared refresh core and the scheduled section

`applyRefreshResult(repos, accountId, token, result, secrets)` is used by **both** `runTokenRefresh` and `refreshForPublish`:

| `result` | `recordRefresh(token, patch)` |
|---|---|
| `ok:true` | `{ credentialsEncrypted: encrypt(result.credentials), credentialsExpiresAt, lastRefreshedAt: now, lastError: null, displayName? (when it differs) }` |
| `ok:false`, definitive | `{ status: "needs_reauth", lastError: redact(reason) }` |
| `ok:false, transient` | `{ lastError: redact("Renewing credentials failed temporarily: " + reason) }`. Status stays `active` and the lease is released |

`runTokenRefresh` changes only by delegating to `applyRefreshResult`. Its existing behaviour is otherwise unchanged:

- a thrown error still means `needs_reauth` (decision 002);
- the counts gain `deferred` for transient failures.

## 4. DAL

- `AccountsRepo.acquireRefreshLease` is new, and `RefreshPatch.displayName` is new ([data-model §7](../data-model.md#7-dal-additions-generic-scheduler-internal)). Both are reachable only through `forSchedulerProject` (scheduler-internal, like `recordRefresh`).
- `ClaimContext.contentShape` is new.
- Project scope: every new query filters on `project_id` from the claimed row. `scope-check` and the query-log test must stay green.

## 5. Tests (real Postgres, `runTick`, stubbed `fetch` or a throwaway provider)

- **`tests/integration/scheduler/step-content.test.ts`** (G4):
  - `stepFor` receives `{ text, mediaCount }` reflecting `override_text`;
  - a provider whose first step depends on `mediaCount` gets the right `inFlightMayPublish`;
  - a deleted post → `fatal_error`, never `ambiguous`;
  - a mismatched `ctx.step` is visible to the provider.
- **`tests/integration/scheduler/publish-refresh.test.ts`** (G2/G3), with a test provider whose `needsRefresh` and `refreshCredentials` are scripted:
  - proactive refresh persists before `advance` sees the new credentials (assert the DB ciphertext decrypts to what `advance` received);
  - `changed`: credentials rotated by another caller are reused with no second refresh call;
  - `busy`: the target lease is released, `attemptCount` is unchanged, there is one `released` attempt, and the next tick publishes;
  - `refused` → the account is `needs_reauth`, and on the next tick the target fails with `account_unavailable`;
  - `transient` → `retryable_error` with `notBefore = retryAt`, and the account stays `active`;
  - reactive `credentialsExpired` → recorded as retryable, then a refresh; the next tick uses the new credentials and publishes once;
  - budget: a refresh that would overrun the deadline releases instead.
- **`tests/integration/scheduler/refresh-concurrency.test.ts`**: two `refreshForPublish` calls plus one `runTokenRefresh` race on the same account, using separate pool connections and repeated 20×.
  - Exactly **one** platform refresh request is made.
  - The persisted refresh token is the newest one.
  - Every caller ends with that token, either directly or on its next read (SC-006).
- **`tests/integration/scheduler/refresh.test.ts`** (existing, extended):
  - transient → stays `active` with `last_error` set, and is retried next tick;
  - `displayName` is updated on a handle change;
  - every 002 case is unchanged.
