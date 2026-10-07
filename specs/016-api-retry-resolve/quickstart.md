# Quickstart: validating the recovery API

**Feature**: `016-api-retry-resolve` | Contracts: [http-api.md](./contracts/http-api.md), [services.md](./contracts/services.md) | Data: [data-model.md](./data-model.md)

## Prerequisites

- Node 24, pnpm, and a local Postgres as used by `pnpm test`. Test databases are run-scoped.
- No credentials. Every test uses the mock provider and `tests/helpers/api.ts` (`world()`, `createKey()`, `api()`). No live calls (constitution II).
- After the schema edit: `pnpm db:generate --name api_key_attribution`, then `pnpm db:check`.

## Test map (FR-030)

Run only the affected files per task, for example `pnpm vitest run tests/integration/api/endpoints/retry-target.test.ts`. Run the full set once at the end of implement.

| File | Proves |
|---|---|
| `tests/integration/api/endpoints/retry-target.test.ts` (new) | US1 1–7 and US2 1–4. Covers: `now` / `requeue` (with and without `expected`, matching and differing) / `at`; `in_past`; `no_free_occurrence` and `no_active_slots`, checking the stored `last_error` and the single `retry_requested` entry; `validation` with `issues`; and 409 `publishing`, `not_failed` (scheduled, published, ambiguous, cancelled), `account_removed`, `needs_reconnecting` and `provider_unavailable`, each with zero new attempt rows. Also: wrong post/target pairing → 404 with no writes; deleted post → 404; bad bodies → 400 (missing mode, extra key, `at` without offset); two concurrent retries with different keys → one 200 and one 409 `not_failed` |
| `tests/integration/api/endpoints/resolve-target.test.ts` (new) | US3 1–6 and US2-4. Covers: `published` with and without `url`, and a `post.published` event when the post becomes published; `not_published` with `requeue: false` → `not_requeued`; `requeue: true` → scheduled, with `resolved_not_published` then `requeued` entries and `changedFromPreview` against an offset `expected`; no slot → `no_free_slot`; gate refused → 409 `cannot_publish`, target still `ambiguous`; a failed target → 409 `already_resolved`; bad `url` → 400 at `url`; `{outcome:"failed"}` → 400; pairing → 404 |
| `tests/integration/api/endpoints/retry-failed-targets.test.ts` (new) | US4 1–6. Covers: counts add up (`retried + Σ skipped + remaining = inScope`); all six keys are present; the `accountId` filter; unknown and foreign `accountId` give identical 200s with `inScope: 0`; requeue exhausting an account gives `no_free_slot` with earlier failures getting earlier slots; more than 100 eligible gives `remaining > 0` and a message containing "Call again with a new Idempotency-Key"; `targetIds` key or missing mode → 400 |
| `tests/integration/api/endpoints/recovery-idempotency.test.ts` (new) | US5 1–4 and SC-003, per operation. Covers: replay of a 200 and of a stored 409, with `Idempotent-Replayed: true`, unchanged attempt count, target row and webhook event count; different body with the same key → 422; in-progress → 409 with `Retry-After` (hold the claim as `idempotency.test.ts` does); no key twice → second is 409 `not_failed`; bulk with the same key after `remaining > 0` replays with no new retries, and a new key continues |
| `tests/integration/api/endpoints/recovery-attribution.test.ts` (new) | US6 1–4 and FR-024, plus SC-005 parity. Covers: an API action writes `actor_api_key_id` / `resolved_by_api_key_id` and the creator's user id; the creator has left the project → succeeds, user id kept; the creator's user deleted → succeeds, user id null (the F12 regression: no 500); the view reads "API key {name}" before and after revoke and after expiry; a UI (member scope) action writes no key; side-by-side API vs member-service runs give equal target rows and attempt entries (ignoring ids, timestamps and attribution) and the same webhook event types |
| `tests/integration/api/scope-enforcement.test.ts` (extend) | US6 5–6 and SC-006. Adds `FIXTURES` for `retryPostTarget`, `resolvePostTarget` and `retryFailedTargets`. 403 naming `write_posts` for a `read` key; a foreign `postId` / `targetId` → 404 identical to unknown |
| `tests/integration/api/openapi.test.ts` (extend) | SC-007 and FR-027. The three operations have request schemas and examples, and examples on 200/400/401/403/404/409/422/429. The 409 description lists every reason. All `$ref`s still resolve, and the document still validates |
| `tests/integration/security/secret-scan.test.ts` (extend) | FR-026. Calls all three operations with a key and an `Idempotency-Key`, then scans the response bodies, the `publish_attempts` rows written and the rendered Failures page attempt log. None may contain the raw key, its hash, its `last4`, the idempotency key value or any env secret |
| `tests/integration/failures/attempts.test.ts` (extend) | `toAttemptViews`: a key entry → `api_key` with its name; a stub `apiKeys.get` returning null → name null; member and system entries unchanged |
| `src/lib/failures/attempt-actor.test.ts` (new) | `attemptActorLabel`: the four labels |
| `src/lib/failures/retry-all-text.test.ts` (extend) | `continueWith: "call"` changes only the last sentence. The default output is unchanged |
| Existing 012/015 suites (`tests/integration/failures/*.test.ts`) | Unchanged and green. Proves FR-003 (no UI behaviour change), including the `ConflictError` reason addition and `withLockedTarget` opts |

## Final pass (once, end of implement)

```sh
pnpm lint && pnpm typecheck && pnpm test
pnpm db:check
pnpm build        # routes and server/client boundaries touched (two pages import a new lib module)
```

Expected: all green. The OpenAPI document test lists 3 more operations.

## Manual walk-through (not claimed as verified by tests)

1. Run `pnpm dev`. Create a project with a mock account and slots, and a key "n8n recovery" with `write_posts`.
2. Force a target to `failed` (mock provider fatal error, then run the tick).
3. Send:

   ```sh
   curl -s -X POST localhost:3000/api/v1/posts/$POST/targets/$TARGET/retry \
     -H "Authorization: Bearer $KEY" -H "Idempotency-Key: retry-evt1-$TARGET" \
     -H "Content-Type: application/json" -d '{"mode":"requeue"}'
   ```

   Expect `200` with `status: "scheduled"` and a slot.
4. Send the same command again. Expect the same body and `Idempotent-Replayed: true`.
5. Open the post page and the Failures page attempt log. The actor reads "API key n8n recovery".
6. Send `curl … /targets/retry-failed -d '{"mode":"now"}'` and expect the counts JSON.
7. Fetch `/api/v1/openapi.json` and find the `Recovery` tag with three operations and their examples.
