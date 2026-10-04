# Implementation Plan: Public API, API keys, idempotency, webhooks and OpenAPI

**Branch**: `009-public-api` | **Date**: 2026-10-04 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/009-public-api/spec.md`

## Summary

Docket gains a versioned REST API under `/api/v1` that drives the existing services: media, posts, the queue, generation, slots, accounts and jobs. It adds no business rule of its own (constitution IV).

- **Keys**: a **Docket-owned hashed key table**, not `@better-auth/api-key` (research D1, logged). The installed plugin fails three requirements:
  - it deletes expired keys on verify and on every create, so the list and its history would lose them;
  - it lives outside the scoped DAL, with no `project_id`;
  - it cannot share a transaction with the audit row.

  Keys look like `dkt_…`. They are SHA-256 hashed and shown once. Each carries five permissions and a per-minute limit enforced by one atomic UPDATE on the key row (D4).
- **Key actor**: `forApiKey` builds a normal `ProjectScope` whose `actor` is the key and whose `can()` comes from the key's permissions (D2). Every service still runs its own `can()` checks, and transactions re-check that the key is still valid.
- **One router**: `src/app/api/v1/[[...path]]/route.ts` hands every request to a pipeline over a single **operation table** (D6, D7). The router, the OpenAPI document (`zod-openapi`, 3.1.0; D14) and the operation-driven scope test (FR-048) all read that table, so none can drift from the others.
- **Idempotency** (D8–D10):
  - the claim row is committed first under a unique index, so duplicates get 409 and never wait;
  - each endpoint's effect and its stored response commit in **one transaction**, with slow, repeatable pre-work done before that transaction;
  - `POST /generate`, whose model call cannot sit in a held transaction, links its post to the key through 007's existing unique `generation_request_id`.
- **Jobs over the API**: an `api` item source (one file plus a registry line), plus the smallest generic change to 008. Jobs gain an **open/closed** state, with `appendItems` and `closeJob` (D18, D19).
- **Webhooks** (D15–D17):
  - an outbox of events and deliveries, written in the transaction that changes post, job or account status;
  - a fourth independent `runTick()` section that sends signed POSTs (HMAC-SHA256 over `timestamp.body`) with backoff, a delivery log, 410 and failure-streak disabling, and a 24 h rotation overlap.
- **Media by URL**: built-in `node:http(s)` with a validating `lookup`, which blocks private, loopback and link-local destinations even after redirects and DNS rebinding (D13). The bytes then go through the existing upload pipeline.
- **Settings**: API keys and Webhooks screens for owners and admins ([contracts/ui.md](./contracts/ui.md)).
- **Docs**: `docs/n8n.md` reproduces the owner's old flow with row-derived idempotency keys, plus a signature-verification recipe. Both are checked by tests.

**No new runtime dependency.** The one dev dependency wanted is the full OpenAPI validator. It is not installed, so that assertion is marked `NEEDS DEPENDENCY` and the structural checks run regardless.

## Technical Context

**Language/Version**: TypeScript 5 (strict) on Node 24 LTS (`>=24.10 <25`; planning probes ran on 24.16).

**Primary Dependencies**: all already installed (decision #19).

- `zod` 4.6.5 and `zod-openapi` 6.0.2. `createDocument` with `requestParams`, component ids and `x-*` operation extensions were probed (research F5).
- Drizzle ORM 0.45.3 (`drizzle-orm/node-postgres`).
- Next.js 16.3.8 route handlers: an optional catch-all `[[...path]]`, with `params` as a Promise (F10). Read `node_modules/next/dist/docs/01-app/` before writing routes and UI (AGENTS.md).
- Node built-ins only for the new I/O: `node:crypto` (hashing, HMAC, `timingSafeEqual`), `node:http`/`node:https` with `lookup` and `net.BlockList` (the URL fetch guard), and global `fetch` with `redirect: "manual"` (webhook delivery). All were probed (F7–F9).
- `@better-auth/api-key` 1.7.7 stays installed and **unused** (D1).
- **`NEEDS DEPENDENCY: @seriousme/openapi-schema-validator`** (dev, FR-047's full validity check, F6).

**Storage**: PostgreSQL 17 via Drizzle, in one migration (`0006`). Detail in [data-model.md](./data-model.md).

- New tables: `api_keys`, `api_idempotency_keys`, `webhook_endpoints`, `webhook_events`, `webhook_deliveries` and `webhook_delivery_attempts`. All are project-owned and registered.
- New columns:
  - `posts`, `media_assets` and `generation_jobs`: `created_by_api_key_id`;
  - `generation_jobs`: `cancelled_by_api_key_id`, `open` and `closed_at`, with the item-count check relaxed for open jobs.
- New enums, plus new `membership_action` values.

**Testing**: Vitest against real Postgres (per-worker database clones). Route modules are called directly with `Request` objects. The supporting pieces:

- local `node:http` receivers for webhooks and image URLs;
- the fake LLM;
- the mock provider;
- the DB clock.

New suites live in `tests/integration/{api,api-keys,webhooks}` and `tests/integration/docs/n8n-flow.test.ts`, plus `tests/lint/api-imports.test.ts`. They are mapped in [quickstart.md](./quickstart.md). **No live network calls.**

**Target Platform**: the existing `node:24-slim` image.

- The worker bundle gains the webhook section (fetch and crypto only).
- `/api/v1/` is added to the auth gate's public prefixes, so the proxy never redirects API calls to `/login`. Authentication happens in the pipeline.

**Project Type**: the single Next.js app (`src/app`, `src/components`, `src/server`, `src/providers`, `src/lib`).

**Performance Goals**:

- An API request costs, before the service runs, one indexed key lookup, one rate-limit UPDATE and (for writes with a key) one idempotency statement.
- `openapi.json` is built once per process.
- Webhook fan-out costs one indexed SELECT per status transition when a project has no endpoints.
- Each tick sends at most 10 deliveries, 4 at a time.

**Constraints**:

- `runTick()` stays bounded (budget ≤ 25 s), concurrent-safe and kill-safe. No network call happens inside a held transaction:
  - the model call for `/generate` is outside any transaction (D8 step 3);
  - the URL fetch, image processing and storage `put` for media, and variant preparation for queue and schedule, run before the idempotent transaction.
- There are no advisory locks (Neon pooler). Concurrency rests on unique indexes, conditional UPDATEs, `SKIP LOCKED` and row locks.
- Lock order is unchanged. Emission adds only inserts into new rows (contracts/webhooks.md).
- **Secrets**:
  - the key plaintext appears in exactly one response;
  - webhook secrets are encrypted at rest and shown once;
  - error bodies, logs, audit details and event bodies carry no secrets.
- **Interim constants**, each one constant and logged:
  - 25 keys per project; rate limit 1–1,000, default 60;
  - 7-day idempotency retention;
  - hold `max(300 s, 2 × LLM_TIMEOUT_SECONDS + 120 s)`;
  - JSON body 8 MB;
  - 100 items per add and 500 per job;
  - 10 endpoints per project;
  - deliveries: 8 attempts, 1 min doubling to 6 h, 10 s timeout, disable after 20 failed deliveries, 30-day log, 24 h overlap;
  - URL fetch: 3 redirects, 30 s, upload size cap.

**Scale/Scope**:

- Personal and team use: a handful of projects, and a few keys and endpoints each.
- **Out of scope** (the `hardening` entry): the failures view, the limits audit, the security pass (including tightening webhook URL rules and the request-size review), deployment docs and walkthroughs.
- **Also out of scope**: CSV jobs over the API, publish-now, post editing and deletion over the API, slot and voice management over the API, CORS, and browser-session API access.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Pre-research | Post-design | How the design complies |
|---|---|---|---|
| I. Verified facts over memory | PASS | PASS | Every library fact was read from installed types and source, and probed (research §1, F1–F15): the plugin's delete-on-expiry, the `zod-openapi` document shape, `http.request({ lookup })`, `BlockList`, `fetch` manual redirects, and `Request.formData()`. The missing validator is marked `NEEDS DEPENDENCY`, not guessed. |
| II. Nothing "working" unless it ran | PASS | PASS | Every behaviour has a test against real Postgres, using local receivers, the fake LLM and the mock provider. n8n is verified by scripting its exact documented requests, and the doc reports it that way. The live check (quickstart §9) is owed by the owner. |
| III. Isolation in one place | PASS | PASS | Six new project-owned tables are registered, and the scope check covers them. Keys act through `ProjectScope` (`forApiKey`), and people still resolve membership on every call. The only cross-project queries (key lookup by hash, delivery claim and recovery, housekeeping) are wrapped in `crossProject` with a reason. A new lint test forbids API route and operation files from importing the DAL or DB (FR-044). The ESLint DB-import rule already covers `src/server/api` and `src/app`. |
| IV. One service layer | PASS | PASS | Every operation calls one existing or extended service. New rules sit in services the UI also uses or can use: `appendItems`, `closeJob`, `registerMediaFromUrl`, `listUpcomingOccurrences`, `prepareUpload`/`commitUpload`. There is still one slot allocation (`queueTargetsInTx`), one approval policy (`resolvePolicies`/`applyApprovalPolicy`) and one publisher. |
| V. Providers are plug-ins | PASS | PASS | No provider folder changes. Account capabilities come from the registry. |
| VI. Boring, few dependencies | PASS | PASS | No new runtime dependency and no infrastructure. Idempotency, rate counts, outbox and deliveries live in Postgres, and delivery runs in `runTick()`. The one dev dependency is marked, not hand-rolled. |
| VII. Secrets never leak | PASS | PASS | Keys are hashed, and the plaintext appears in one response. Webhook secrets use `enc:v1` with AAD. Audit details avoid `url`, `secret` and `token` keys. Error messages come from a fixed table or user-facing service messages. Response excerpts pass through `redact()`. No-secret scans cover keys, idempotency rows and event bodies. |
| Engineering: tick bounded, `SKIP LOCKED` + lease, no network call in a held transaction | PASS | PASS | [contracts/webhooks.md](./contracts/webhooks.md): the claim and record transactions hold no network call, a send starts only with 11 s of budget left, and the lease is at least `SCHEDULER_LEASE_SECONDS`. Research D8 keeps model, storage and fetch I/O outside the idempotent transaction. |
| Engineering: Neon pooler (no session features) | PASS | PASS | No advisory locks or LISTEN. Single statements and short transactions. |
| Engineering: UI via the `docket-ui` skill | PASS | PASS | [contracts/ui.md](./contracts/ui.md) covers the four states, labelled fieldsets, the show-once dialog, confirm dialogs that name the thing, text-plus-colour badges and keyboard-only flows. |
| Workflow: tests per quality bar ("API idempotency keys work") | PASS | PASS | Quickstart §3: replay, conflict, 20× concurrency (repeated), rollback, expired hold, lost hold, and `/generate` crash recovery. |

**Result**: no violations, so Complexity Tracking is empty.

The one judgement against the spec's literal wording is that `/generate` does not store its result in the same transaction as its effect. Instead it links the effect to the key through a unique index. It is justified in research D8, recorded below, and keeps the 008 rule of no model call in a held transaction.

## Project Structure

### Documentation (this feature)

```text
specs/009-public-api/
├── plan.md              # This file
├── research.md          # Phase 0: facts F1–F15, decisions D1–D21
├── data-model.md        # Phase 1: tables, enums, state transitions, validation
├── quickstart.md        # Phase 1: runnable validation guide
├── contracts/
│   ├── http-api.md      # conventions, error codes, operations table, shapes, idempotency semantics
│   ├── services.md      # pipeline, ApiOperation, forApiKey, scope actor, idempotency repo, key/webhook/media/posts/jobs services
│   ├── webhooks.md      # events, emission hook-ins, signing, delivery tick section
│   └── ui.md            # settings screens, job page changes, server actions
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks; not created here)
```

### Source Code (repository root)

```text
src/server/db/schema/{api,webhooks}.ts            # new tables + enums (new)
src/server/db/schema/{posts,jobs,media,audit,index}.ts   # attribution columns, open/closed_at, audit enum values
src/server/db/project-owned.ts                    # + 6 tables
drizzle/0006_*.sql (+ meta)

src/server/dal/api-keys.ts                        # generate/hash, repo, forApiKey (new)
src/server/dal/idempotency.ts                     # claim/complete/release/purge (new)
src/server/dal/webhooks.ts                        # endpoints, events, deliveries, attempts, claims (new)
src/server/dal/scope.ts                           # actor, can() by actor, key re-check in transaction, actorColumns, repos wiring
src/server/dal/{accounts,targets,jobs,media,errors,index}.ts   # previousStatus results, heldOccurrences, open/close, attribution, new errors

src/server/auth/access.ts                         # + api_key: ["manage"], webhook: ["manage"] (owner, admin)
src/lib/auth-gate.ts (+ test)                     # "/api/v1/" public prefix

src/app/api/v1/[[...path]]/route.ts               # the only API route file (new)
src/server/api/{handle,router,auth,idempotency,errors,respond,pagination,openapi}.ts   # pipeline (new)
src/server/api/operations/{index,accounts,media,posts,generate,slots,jobs,openapi}.ts # operation table (new)
src/lib/api/schemas.ts                            # output schemas (new)
src/lib/validation/api.ts                         # key, webhook, idempotency, upcoming schemas (new)

src/server/services/api-keys.ts                   # (new)
src/server/services/webhooks/{index,endpoints,emit,deliver,sign}.ts (+ sign.test.ts)   # (new)
src/server/services/views/{post,job,media,account}.ts   # shared API/event presenters (new)
src/server/services/media-from-url.ts             # registerMediaFromUrl, fetchForUpload (new)
src/server/net/safe-fetch.ts (+ test)             # guarded fetch (new)
src/server/services/media.ts                      # prepareUpload/commitUpload split; limit/offset; attribution
src/server/services/posts/{index,status}.ts       # origin api + attribution; prepareForScheduling; applyDerivedStatus emits
src/server/services/queue/index.ts                # listUpcomingOccurrences
src/server/services/jobs/{create,append,manage,read,status,runner,index}.ts   # api source use, appendItems, closeJob, getJobItem, open derivation, emits, attribution
src/server/services/jobs/sources/{api,types,index}.ts   # api source; mediaRules
src/server/services/generation/save.ts            # createdByApiKeyId
src/server/scheduler/webhooks.ts                  # delivery section (new)
src/server/scheduler/{index,config,credentials,token-refresh,publishing}.ts   # 4th section; constants; emit on needs_reauth

src/app/p/[projectSlug]/settings/layout.tsx       # links for owners/admins
src/app/p/[projectSlug]/settings/api-keys/{page,loading,actions}.tsx|ts, CreateKeyForm.tsx, RevokeKeyDialog.tsx   # (new)
src/app/p/[projectSlug]/settings/webhooks/{page,loading,actions}.tsx|ts, EndpointForm.tsx, EndpointRowActions.tsx  # (new)
src/app/p/[projectSlug]/settings/webhooks/[endpointId]/{page,loading}.tsx, DeliveryLog.tsx, RotateSecretDialog.tsx  # (new)
src/app/p/[projectSlug]/settings/members/activity-list.tsx   # labels for new audit actions
src/app/p/[projectSlug]/jobs/[jobId]/{page.tsx, CloseJobDialog.tsx}; jobs/actions.ts   # open state, close
src/components/ui/ShowOnceDialog.tsx              # CopyField + "I have stored this" (new)

tests/helpers/{api,webhook-receiver,image-server}.ts      # (new)
tests/integration/api/{pipeline,rate-limit,errors,idempotency,idempotency-generate,scope-enforcement,openapi}.test.ts
tests/integration/api/endpoints/{media,posts,generate,jobs,slots-accounts}.test.ts
tests/integration/api-keys/{show-once,revoke,expiry,cap,creator-left}.test.ts, ui.test.tsx
tests/integration/webhooks/{emission,delivery,outage,rotation,settings}.test.ts
tests/integration/docs/n8n-flow.test.ts
tests/integration/actions-authz.test.ts           # rows
tests/lint/api-imports.test.ts                    # FR-044 (new)
docs/n8n.md (new), README (API + n8n links), docs/decisions.md (009 entries)
```

**Structure Decision**: the existing single Next.js app.

- API infrastructure lives in `src/server/api/`, which is not a service: it only authenticates, checks, parses, calls and maps.
- Business logic stays in `src/server/services/` (constitution IV), and data access in `src/server/dal/` (constitution III).
- The webhook sender is a scheduler section beside `publishing.ts` and `generation.ts`.

## Generic changes to existing code

Each change is small and keeps existing behaviour. Each is recorded in `docs/decisions.md` with how to reverse it.

1. **`ProjectScope.actor`** and `can()` by actor; the key re-check in `transaction()`; `actorColumns()` (D2, D3).
2. **Attribution columns** on posts, media and jobs (D3). Views show "API key: <name>".
3. **`applyDerivedStatus`, `refreshJobStatus`, `cancelJob` and the account flag call sites** emit webhook events in their transaction. `applyDerivedStatus`'s parameter type widens, and `createSchedulingRepos` gains `webhooks` (D15).
4. **`accounts.recordRefresh` / `markCredentialsInvalid`** return `{ changed, previousStatus }`, and their four scheduler call sites run in a transaction (D15).
5. **Open jobs**: `open`, `closed_at`, the relaxed item-count check, the `deriveJobStatus` open branch, `closeJob`, `appendItems`, and `cancelJob` closing the job (D18).
6. **`PreparedSource.mediaRules`**, optional, defaulting to 008 behaviour; plus the `api` source (D19).
7. **`uploadMedia`** split into `prepareUpload` + `commitUpload` with unchanged behaviour; `registerMediaFromUrl` (D20).
8. **`listUpcomingOccurrences`** and `targets.heldOccurrences`; `listEmptySlots` is unchanged (D20).
9. **`listMedia`, `listJobs`, `listJobItems`** take an optional `limit`/`offset` (D12). `getJobItem` is new.
10. **`createDraft`** forces origin `api` for key actors. `prepareForScheduling` is exported (D20).
11. **Access statements** `api_key` and `webhook` (owner and admin).
12. **Auth gate**: `/api/v1/` is public at the proxy, with authentication in the pipeline (F11).
13. **`runTick()`** gains a fourth section, `webhooks`, with its heartbeat. `TickSummary` gains `webhooks`.
14. **Audit enum values**, plus their labels in the activity list.

## Spec notes for later phases

- **Key plugin**: not used (research D1). The spec's preference is answered, and the choice is logged.
- **Multipart body hash**: the hash covers the file bytes plus canonical text fields, not the raw multipart bytes, because the boundary is random per request (research D9). JSON bodies hash canonically. Logged.
- **`/generate` idempotency**: the effect is linked to the key by a unique index, and the result is stored right after, not in the same transaction, because the model call cannot run in a held transaction (research D8). The outcome the spec asks for (no duplicate, and a replay after a lost response) holds and is tested. Logged.
- **Stored results** include 4xx responses from the endpoint. 5xx responses are never stored (research D10). The n8n doc says to use a new key after changing a body.
- **Two codes added** to FR-010's list: `generation_failed` (422) and `generation_unavailable` (503), plus the media URL codes `url_not_allowed`, `url_too_many_redirects`, `url_fetch_failed` and `url_timeout` (all 400), and `job_item_limit` (400, already in the spec's edge cases).
- **"Consecutive failed deliveries"** counts deliveries that ended `failed` after 8 attempts, not individual attempts. Counting attempts would disable an endpoint during a 1-hour outage, which breaks SC-008 (research D16).
- **Closing an empty open job** is refused with 409. An empty job cannot finish meaningfully, and it can be cancelled instead (research D18).
- **Expired keys** stay listed as "expired", and revoking one is still allowed and recorded.
- **External post URL** stays `null`: no provider stores permalinks (005 R5, 006 R10).
- **The full OpenAPI validator** is `NEEDS DEPENDENCY: @seriousme/openapi-schema-validator`. The task that would use it is marked, and the structural checks run.
- **Delivery order** for `/speckit-tasks`:
  1. migration, schema, project-owned registry, DAL repos (keys, idempotency, webhooks), new errors, and access statements;
  2. the scope actor (`forApiKey`, `can()` mapping, transaction re-check, `actorColumns`) and attribution writes, with existing tests green;
  3. the API keys service, the settings screen and show-once/revoke/expiry tests (P1, US1);
  4. the pipeline (router, auth, rate limit, errors, pagination) and the auth-gate prefix, with pipeline and rate-limit tests;
  5. idempotency (claim, transaction completion, generate mode) with its tests (P1, US2);
  6. operations for accounts, media (prepare/commit split, URL fetch guard), posts (create, get, target, queue, schedule), generate and slots, plus the scope-enforcement test (P1/P2);
  7. open jobs, the `api` source, `appendItems`, `closeJob`, `getJobItem`, the job operations and the job page close action (P2, US4);
  8. the n8n doc and its flow test (P1, US3);
  9. webhooks: emission hook-ins, signing, the delivery section, settings screens and the endpoint page, with tests (P2, US5);
  10. OpenAPI generation, `openapi.json` and its test (P3, US6);
  11. the API import lint test, `actions-authz` rows, README, `.env.example` (no new variables; a comment pointing to the constants) and `docs/decisions.md`;
  12. final gates.

## Complexity Tracking

No constitution violations, so there is nothing to justify.
