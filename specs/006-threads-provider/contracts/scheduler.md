# Contract: scheduler behaviour relied on, and the one change (G11)

## Unchanged and relied on

- **Claim and lease** (002): one step per claim; `next_attempt_at = max(now + backoff, notBefore)`; `continue` resets `attempt_count`.
- **Lease recovery**: a non-publishing step is retried; a `mayPublish` step becomes `ambiguous` and is never called again. For Threads, only `publish` is `mayPublish`.
- **Own publish-limit counter**: the provider default of 250 / 86 400 s plus an optional account override. The 251st start in the window is deferred to `oldest start + window` with no provider call (SC-006).
- **G7**: `fatal_error.credentialsInvalid` → `needs_reauth`, conditional on the ciphertext used, with no retry and no ambiguity.
- **Token-refresh section**: claims active accounts with `credentials_expires_at ≤ now + TOKEN_REFRESH_WINDOW_HOURS` (default 72, max 720), at most 5 per tick, ordered by expiry, under a refresh lease. A definitive failure → `needs_reauth`; a transient one → stays `active` with `last_error` noted (G3).
- `PUBLISH_MAX_DURATION_HOURS` and `PUBLISH_MAX_ATTEMPTS` still apply to Threads targets.

## G11 — transient `retryAt` in the scheduled section

`applyRefreshResult(repos, account, token, result, secrets, opts?: { holdTransient?: boolean })`:

- With `opts.holdTransient` and `result = { ok: false, transient: true, retryAt }`, `recordRefresh` writes `refresh_lease_until = min(retryAt, now + 24 h)` and `refresh_lease_owner = null` (instead of `null`/`null`), plus the usual `last_error`. The value is ignored when it is not later than `now`.
- Without `holdTransient` (publish-time refresh) the behaviour is unchanged.
- `runTokenRefresh` passes `{ holdTransient: true }`.
- `claimRefreshAccounts` is unchanged. It already excludes rows with `refresh_lease_until > now`.
- `acquireRefreshLease` (publish-time) is unchanged. A parked account reports `busy`, which only matters for providers with `needsRefresh`. Threads has none.

**Tests** (throwaway provider, real `runTokenRefresh`):

1. A transient result with `retryAt = now + 2 h` → no reclaim on the next tick, reclaimed after the DB clock passes `retryAt`.
2. `retryAt = now + 10 days` → parked for 24 h only.
3. A transient result without `retryAt` → reclaimed next tick (unchanged).
4. Bluesky's existing refresh tests pass unchanged.

## Threads-specific expectations through the real engine

| Scenario | Expected |
|---|---|
| Text post, container `FINISHED` at first check | 4 ticks: create, check, quota, publish → `published` with the post id |
| Image post, `IN_PROGRESS` then `FINISHED` | 5 ticks; the second check's `next_attempt_at` is about 60 s after the first |
| N-image carousel | N + 4 ticks (SC-004) |
| Publish times out | `ambiguous`, no automatic retry, shown in the ambiguous UI |
| 190 on any step | target `failed` ("Reconnect @user to publish: …"), account `needs_reauth` |
| Refresh: expiry inside the window, token ≥ 24 h old | one `GET /refresh_access_token`; new ciphertext, `credentials_expires_at ≈ now + 60 d`, `last_refreshed_at` set |
| Refresh: token < 24 h old | no request; account `active`; parked until `issuedAt + 24 h` (G11) |
| Refresh: token expired | no request; `needs_reauth` with "The Threads token expired. Reconnect the account." |
