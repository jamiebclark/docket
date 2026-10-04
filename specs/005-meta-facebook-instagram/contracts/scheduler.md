# Contract: engine change for G7 (credentials invalid)

Only `src/server/scheduler/publishing.ts` and `src/server/dal/accounts.ts` change. Claims, leases, backoff, limits, recovery and refresh are untouched.

## DAL

```ts
interface AccountsRepo {
  /**
   * Internal (scheduler): flags the account needs_reauth with a secret-free reason, only while the stored ciphertext
   * still equals `expectedCiphertext` and the account is not removed. Returns whether the row changed.
   * One conditional UPDATE; no lock held across provider calls.
   */
  markCredentialsInvalid(id: string, opts: { expectedCiphertext: string | null; reason: string }): Promise<boolean>;
}
```

The SQL is `UPDATE social_accounts SET status = 'needs_reauth', last_error = $reason WHERE project_id = $p AND id = $id AND removed_at IS NULL AND credentials_encrypted IS NOT DISTINCT FROM $expected`. It contains no `OR`, so the scope check can pin the project.

## Engine (`execute` in `publishing.ts`)

When the step result is `fatal_error` with `credentialsInvalid: true`:

1. The target error becomes `Reconnect ${account.displayName} to publish: ${redact(result.error)}`. This is the patch from `applyStepResult` (`failed`, no `nextAttemptAt`), recorded by `recordStepResult` as now.
2. After the record, `repos.accounts.markCredentialsInvalid(account.id, { expectedCiphertext: seenCiphertext, reason })` runs, where `reason` = the redacted provider error. A failure here is logged (key and outcome only) and swallowed. The target is already failed, so the next publish attempt will meet the same 190.
3. Counts: `failed++`. The attempt outcome stays `fatal_error`.

Outcomes:

- Other due targets of the account are refused at their next claim by the existing rule (`account.status !== "active"` → failed with no provider call).
- Targets already leased in the same batch run as they would anyway, and each gets its own 190.
- A `credentialsInvalid` flag on any other result kind is ignored, since the type forbids it.
- The existing retry action refuses while the account is `needs_reauth` ("Reconnect the account before retrying."). After a reconnect it works (US7 AS4).

## Tests (throwaway provider, no Meta code)

`tests/integration/scheduler/credentials-invalid.test.ts`:

- the account flips to `needs_reauth`, and the target is `failed` with the "Reconnect … to publish" text;
- no retry is scheduled;
- a second due target on the account fails at claim without `advance` being called;
- the ReauthBanner query lists the account;
- a reconnect that happened while the step ran (the ciphertext changed) leaves the account `active`;
- a `mayPublish` step returning the flag is `failed`, not `ambiguous`;
- after a reconnect, `retryTarget` re-arms the target.
