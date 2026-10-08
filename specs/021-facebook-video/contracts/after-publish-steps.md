# Contract: steps after publishing (generic change G23)

Covers spec D9, FR-010 and SC-003 where the engine, not the provider, decides an outcome. Rationale is in [../research.md](../research.md) P12–P13.

## Declaration

- `StepInfo.afterPublish?: true`, returned by `stepFor` for a step that runs after a step with `mayPublish: true` was sent for this target.
- It requires `mayPublish: false`. `registry.test.ts` does not check this, because `stepFor` results are dynamic; the engine treats `mayPublish: true` as winning.
- **Facebook** returns it for `check_publish`, and for `invalid` on a video post with unreadable state.
- **Every other provider** returns nothing, so their behaviour is unchanged. `tests/integration/meta/engine-unchanged.test.ts` and the scheduler suites pin this.

## The rule

> For a lease whose step has `afterPublish`, the engine never records **failed** on its own. Where it would, it records **ambiguous** instead, appending " The post may already be live; check before retrying." A `fatal_error` returned by the provider itself still fails.

| Engine path (`src/server/scheduler/…`) | Change |
|---|---|
| `publishing.ts` claim: `leased.set(…)` | also stores `afterPublish: info.afterPublish === true` on the in-memory lease |
| `publishing.ts` `execute` catch: `MediaUnavailable`, `CredentialsUnreadable`, `SettingsInvalid` | `ambiguous` when `lease.afterPublish`, else `fatal_error` as today |
| `publishing.ts` `execute` catch: `ContentInvalid` | not reachable (G15 runs only when `stepState === null`) |
| `publishing.ts` `execute` catch: `PostGone` | unchanged |
| `record.ts` `applyStepResult` | new optional input `afterPublish`. A `retryable_error` reaching `maxAttempts` gives `status: "ambiguous"`, outcome `"ambiguous"` |
| `recovery.ts` `recoverExpiredLease` | new optional `opts.afterPublish`. At `maxAttempts` it settles `ambiguous` with "Publishing was interrupted too many times after the post was sent; check before retrying." |
| `publishing.ts` claim, recovery branch | **only** when recovery would settle `failed`, derive the step: settings parse, `ctx.contentShape(target)`, `provider.stepFor(...)`. If the step has `afterPublish`, call recovery again with `{ afterPublish: true }`. A throw, or no shape, keeps `failed` |

## Ambiguous with flagged credentials

- `StepResult` `ambiguous` gains `credentialsInvalid?: true`.
- In `execute`, `credentialsInvalidReason` is computed for `fatal_error` **or** `ambiguous` with `credentialsInvalid`.
- For `ambiguous`, `lastError` becomes `<provider error> Reconnect <displayName> to publish again.`. For `fatal_error` it keeps today's "Reconnect <displayName> to publish: <reason>" prefix.
- In both cases `markInvalidEmitting(repos, account.id, { expectedCiphertext: seenCiphertext, reason })` is called once.

## Tests

| Case | File |
|---|---|
| `applyStepResult` with `afterPublish`: retryable at max → ambiguous; below max → retry; fatal stays fatal | `src/server/scheduler/record.test.ts` (extended) |
| `recoverExpiredLease` with and without `afterPublish` at max | `src/server/scheduler/recovery.test.ts` (extended or new) |
| a test provider whose step 2 has `afterPublish`: media deleted after step 1 → ambiguous; 8 provider timeouts → ambiguous; 8 stale leases → ambiguous; a provider fatal → failed | `tests/integration/scheduler/after-publish.test.ts` (new) |
| ambiguous with `credentialsInvalid` flags the account (`needs_reauth`), emits the event once, and keeps the target ambiguous | same file |
| providers that never set it: unchanged outcomes | existing `tests/integration/scheduler/*.test.ts`, `tests/integration/meta/engine-unchanged.test.ts` |
| `docs/adding-a-provider.md` lists `afterPublish`, `ambiguous.credentialsInvalid` and G23 | `tests/integration/docs/provider-guide.test.ts` (existing check) |
