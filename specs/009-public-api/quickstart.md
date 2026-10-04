# Quickstart: validating the public API (009)

These runnable checks show the feature works. Behaviour lives in [contracts/](./contracts/) and [data-model.md](./data-model.md) and is not repeated here.

- Every model call is faked with `tests/helpers/fake-llm.ts`. Every provider is the mock provider. Webhook receivers and image URLs are local `node:http` servers started by the test (constitution II). n8n itself is never run: §6 scripts its exact requests instead.
- Tests call the route module directly: `import { GET, POST } from "src/app/api/v1/[[...path]]/route"` with a `Request`, as `tests/integration/tick-endpoint.test.ts` does. There is no listening server.
- Time comes from the DB clock helpers (`tests/helpers/clock.ts`), never sleeps.
- A new helper, `tests/helpers/api.ts`, provides:
  - `createKey(scope, permissions, opts)`, which returns the plaintext through the real service;
  - `api(method, path, { key, body, headers, idem })`;
  - `world()`, which builds two projects. Each has an account with slots, an image, a post with targets, a job with items, and keys.

## 0. Prerequisites

- Node 24, pnpm, and the test Postgres (decision #21):

  ```bash
  docker start docket-pg   # postgres://docket:docket@127.0.0.1:5433/docket_test
  export DATABASE_URL=postgres://docket:docket@127.0.0.1:5433/docket_test
  ```

- No new runtime dependency. The full OpenAPI validator is `NEEDS DEPENDENCY: @seriousme/openapi-schema-validator` (dev). Until it is installed, that single assertion is skipped with its reason, and every structural check still runs (§7).
- Migration `0006` exists and is current:

  ```bash
  pnpm db:check            # "Migrations are current"
  ```

## 1. Keys: show-once, permissions, revocation, expiry (US1, FR-001–FR-008, SC-004, SC-005)

```bash
pnpm vitest run tests/integration/api-keys
```

Expected:

- `show-once.test.ts`:
  - the create response's `secret` authenticates `GET /api/v1/accounts` (200);
  - `listApiKeys`, the settings page render and the audit rows hold only `dkt_…` plus the last 4 characters;
  - a scan of every text and jsonb column of every table, plus captured console output, finds the plaintext 0 times, and finds `key_hash` = sha256(plaintext) once.
- `revoke.test.ts`:
  - the request right after `revokeApiKey` returns 401 `invalid_api_key`;
  - a second revoke returns `{ revoked: false }` and changes nothing;
  - 20 parallel revokes produce exactly one audit row;
  - a request in flight whose key is revoked before its transaction commits nothing and gets 401.
- `expiry.test.ts`: after the DB clock passes `expires_at` the key gets 401, and it is still listed as "expired".
- `cap.test.ts`:
  - 25 active keys, then a 26th is refused;
  - two concurrent creates at 24 → exactly one succeeds;
  - an editor's create, list and revoke are refused.
- `creator-left.test.ts`: after the creator is removed from the project, the key still works, and the list shows "(no longer a member)".

## 2. Requests, errors and rate limits (FR-009–FR-012, SC-006, SC-011)

```bash
pnpm vitest run tests/integration/api/pipeline.test.ts tests/integration/api/rate-limit.test.ts tests/integration/api/errors.test.ts
```

Expected:

- **Auth and request parsing**:
  - a missing, malformed or unknown key → 401 with `WWW-Authenticate: Bearer`;
  - a session cookie alone → 401;
  - `Bearer` and `X-API-Key` that differ → 401;
  - an unknown path → 404, a wrong method → 405 with `Allow`;
  - a non-JSON content type → 415, bad JSON → 400 `invalid_json`, an oversized body → 413;
  - every response has `X-Request-Id`.
- **Rate limit**:
  - a key with `rate_limit_per_minute = 3`: the 4th request in the minute → 429 with `Retry-After` between 1 and 60;
  - after the clock moves to the next minute → 200;
  - 50 parallel requests at limit 10 → exactly 10 non-429;
  - `last_used_at` changes at most once per minute.
- **Error shape**: every error response the suite produced matches the shared `Error` schema, with a `code` from the documented list, and contains no stack trace, SQL or key.

## 3. Idempotency (US2, FR-013–FR-017, SC-002)

```bash
pnpm vitest run tests/integration/api/idempotency.test.ts tests/integration/api/idempotency-generate.test.ts
```

Expected:

- **Replay**: `POST /posts` with key K and body B → 201. Again → the same status and body, with `Idempotent-Replayed: true`, and one post in the DB. The same body with keys in another order → still a replay (canonical hash).
- **Conflict**: K with B′ → 422 `idempotency_key_reused`.
- **Concurrency**: 20 parallel `POST /posts` with a new key and the same body → exactly 1 post. Every other response is a replay of that 201 or a 409 `idempotency_in_progress` with `Retry-After`. Repeated 5 times in the test.
- **Scoping**: K on `/generate` or with another API key runs independently.
- **Rollback**: a forced 500 inside the service (test seam) → no post, no stored row, and the same key then runs normally.
- **Expired hold**: a claim row left `in_progress` with an expired `hold_until` (simulating a killed process) → the retry takes over and runs once.
- **Lost hold**: a slow request whose hold was taken over commits nothing (the completion check fails and rolls back).
- **Refused early**: 401, 403, 429 and `invalid_json` with K store no row, and a corrected retry with K runs.
- **`/generate`**:
  - 20 parallel identical calls → 1 post and 1 model call (fake-LLM call count);
  - killing between the save and the store (test seam) followed by a retry after the hold → the same post, 200, no second model call;
  - a fake `refused` → 422 `generation_failed`, which is replayed;
  - a fake `timeout` → 503, not stored.

## 4. Endpoints and scope enforcement (US4, FR-018–FR-030, FR-048, SC-003)

```bash
pnpm vitest run tests/integration/api/scope-enforcement.test.ts tests/integration/api/endpoints
```

Expected:

- **`scope-enforcement.test.ts`** iterates `OPERATIONS`. For every operation:
  - no key → 401;
  - a key with every permission except the operation's → 403 `missing_permission` naming it;
  - a key with it → not 401 or 403;
  - for each `resourceParams` entry, the other project's id → 404, the same body as for a random uuid.

  Adding an operation without fixtures fails the test.
- `endpoints/media.test.ts`:
  - multipart upload → 201 with dimensions;
  - `from-url` from a local server (test address policy) → 201;
  - redirect chains of 3 → ok, 4 → `url_too_many_redirects`;
  - a redirect to 127.0.0.1 or 169.254.169.254 or `[::1]` under the **production** policy → `url_not_allowed`;
  - `file:` and credentials in the URL → refused;
  - too large → 413;
  - text/html → 415;
  - slow → `url_timeout` (shortened constant);
  - no storage → 503;
  - `GET /media?unused=true` excludes used and job-reserved images.
- `endpoints/posts.test.ts`:
  - create → origin `api`, the creator is the key, per-target validation is returned;
  - queue → slot times per target, `not_queueable` for a post in review, `no_active_slots`;
  - schedule with `+02:00` → the right UTC instant, `in_past` per target, and near-queued warnings;
  - `GET /posts/{id}` and the target endpoint shapes contain no tokens.
- `endpoints/generate.test.ts`:
  - fake LLM → origin `generated`, creator = key;
  - `auto_approve` without the permission → 403 (and allowed when it is the project default);
  - `auto_approve` + `add_to_queue` without confirmation → 400 `confirmation_required`;
  - no LLM → 503 `generation_not_configured`.
- `endpoints/jobs.test.ts` (US4 independent test):
  - create an open job with fields `product` and `price`;
  - add two batches, one item with a media id;
  - a repeat add with the same idempotency key adds nothing;
  - close, then run ticks with the fake model → `completed`, one post per item, prompt values seen by the fake;
  - an add to the closed job → 409 `job_closed`;
  - a reserved media id → 409 `media_reserved` naming the item, and nothing added;
  - 501 items → 400 `job_item_limit`;
  - an undeclared field → 400 naming item and field;
  - closing an empty open job → 409;
  - `source.kind: "media"` with `unused` works, and `csv` is refused.
- `endpoints/slots-accounts.test.ts`:
  - upcoming occurrences show free and taken (with post id) in UTC and local time;
  - 61 days → 400;
  - the accounts list has capabilities and no credentials.

## 5. Webhooks (US5, FR-033–FR-040, SC-007, SC-008)

```bash
pnpm vitest run tests/integration/webhooks src/server/services/webhooks/sign.test.ts
```

Expected:

- `sign.test.ts`:
  - good signature → true;
  - wrong secret, one changed body byte, or a timestamp 301 s off → false;
  - two `v1=` values verify against either secret;
  - comparison is constant-time (it uses `timingSafeEqual`).
- `emission.test.ts`:
  - publishing through the mock provider and a tick → exactly one `post.published` event and one delivery per subscribed endpoint;
  - an endpoint not subscribed, or disabled, gets none;
  - a forced rollback of the status-changing transaction leaves no event (atomicity);
  - `job.finished` on complete and on cancel, and again after a retry finishes;
  - `account.needs_reauth` only on the active → needs_reauth change.
- `delivery.test.ts` (local receiver):
  - headers and body as documented, and the doc's Node snippet verifies them;
  - 500, 500, then 200 → 3 attempts at backoff spacing 1 min then 2 min (DB clock), all logged with status, duration and excerpt;
  - 8 failures → `failed`;
  - 410 → endpoint disabled `gone`;
  - 20 failed deliveries → disabled `failing`, and re-enable does not resend;
  - a 3xx is a failure (not followed);
  - a 10 s timeout (shortened constant) → `timeout`;
  - a killed send (expired lease) → retried;
  - two concurrent ticks never send one delivery twice.
- `outage.test.ts` (SC-008): the receiver is down for 60 minutes of DB-clock time with events arriving, then comes back → every event is delivered by the 63-minute attempt, and the endpoint is still enabled.
- `rotation.test.ts`:
  - after rotation, deliveries carry two `v1=` values for 24 h, then one;
  - a second rotation in the overlap drops the earliest secret;
  - secrets are stored as `enc:v1:`, and the plaintext is never in any column.
- `settings.test.ts`: create, edit, enable, disable and delete are audited without `url` or `secret` keys; the cap is 10; editors are refused; resend and send-test queue deliveries.

## 6. The n8n flow (US3, FR-045, SC-001)

```bash
pnpm vitest run tests/integration/docs/n8n-flow.test.ts
```

The test reads the request blocks from `docs/n8n.md` (fenced blocks tagged `http`), fills in the template variables for three rows, and runs the whole sequence twice with the same row-derived idempotency keys:

1. `POST /media/from-url`;
2. `POST /generate` with `auto_approve`, `add_to_queue` and the confirmation;
3. `POST /posts/{id}/queue`.

Expected:

- 3 media assets, 3 posts, and 3 queued targets per account, each in its own slot;
- the second run creates nothing (every response is a replay);
- every endpoint the doc names exists in `OPERATIONS`.

## 7. OpenAPI (US6, FR-042, FR-043, FR-047, SC-009)

```bash
pnpm vitest run tests/integration/api/openapi.test.ts
```

Expected:

- `GET /api/v1/openapi.json` with no key → 200 JSON with `openapi: "3.1.0"`;
- every `$ref` resolves;
- unique `operationId`s;
- the documented (method, path) set equals the router's;
- every write has the `Idempotency-Key` header parameter, every operation has `security` and `x-docket-permission`, and every error response references the `Error` component;
- a fixture operation with a changed body schema changes the generated document;
- the full validator check is skipped with `NEEDS DEPENDENCY: @seriousme/openapi-schema-validator` until it is installed.

## 8. Boundaries and regressions

```bash
pnpm vitest run tests/lint tests/integration/actions-authz.test.ts tests/helpers/scope-check.test.ts src/server/services/jobs/status.test.ts
```

Expected:

- `api-imports.test.ts`: no file under `src/app/api/v1` or `src/server/api/operations` imports the DAL, the DB, `pg` or `drizzle-orm` (FR-044);
- the scope check covers the six new tables;
- every new action × role row passes;
- `deriveJobStatus` open-job cases pass, and the 008 cases are unchanged;
- `worker-bundle.test.ts` and `import-boundaries.test.ts` still pass.

## 9. Manual check (owner, after merge; not run by the pipeline)

1. Run `pnpm dev`.
2. Open Settings → API keys and create a key with `read`.
3. Run:

   ```bash
   curl -s -H "Authorization: Bearer $KEY" http://localhost:3000/api/v1/accounts
   ```

   This should list the accounts (SC-010, in under 2 minutes from the settings screen).
4. Add a webhook pointing at a request bin on the home server, then use "Send test event" and run a tick.

Record the result as "verified live on <date>" in `docs/decisions.md`.
