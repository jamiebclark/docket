# Feature Specification: Public API, API keys, idempotency, webhooks and OpenAPI

**Feature Branch**: `009-public-api`

**Created**: 2026-10-04

**Status**: Draft

**Input**: User description: "Build the public API over the existing service layer. Before specifying, read docs/build-prompt.md ('Public API', 'Generation jobs', 'Quality bar'), docs/research/better-auth.md (API key plugin @better-auth/api-key: organization-owned keys, hashed by default, permissions, per-key rate limits, expiry; show-once is unverified — prove it with a test), docs/research/tooling.md (zod-openapi with Zod 4), .specify/memory/constitution.md, the docket-ui skill and docs/decisions.md. Must deliver: versioned REST API under /api/v1 that calls the same services as the UI and jobs (no API-only business logic). Auth with project-scoped API keys (prefer @better-auth/api-key if it fits; otherwise a hashed-key table — log the choice): created and revoked in project settings by owners/admins, shown once, stored hashed, carrying permissions read, write_posts, generate, auto_approve, manage_jobs; per-key rate limits; a consistent, documented error shape. An Idempotency-Key header accepted on every write: stored per key + route with a request-body hash and the response for replay; same key with a different body => 422; concurrent duplicates handled safely. Endpoints, at minimum: upload media or register it by URL, list media with the unused filter, create a post, generate a single post, create a generation job and add items to it (adding the API-submitted ItemSource to the interface from generation-jobs), get job and item status, add a post to the queue, schedule at a time, list upcoming slots, get post and target status, list social accounts. OpenAPI 3 document generated from the route Zod schemas with zod-openapi, served at /api/v1/openapi.json. Optional outgoing webhooks per project for post.published, post.failed, job.finished and account.needs_reauth: HMAC-SHA256 signature over timestamp + body, retries with backoff driven by runTick, delivery log, secret rotation. Settings UI for API keys and webhooks. docs/n8n.md with a worked example reproducing the owner's old flow (loop over rows, call generate with an image, add to queue) using idempotency keys so a retried n8n step never duplicates a post. Tests: key permissions, revocation, show-once, rate limiting, idempotency replay/conflict/concurrency, API-submitted job items, webhook signing and verification, retry, OpenAPI document validity, scope enforcement on every endpoint. Must NOT do: failures view, limits audit, security pass and deployment docs (hardening entry)."

## Context and sources

- Product behaviour: `docs/build-prompt.md` "Public API" (everything drivable over HTTP; UI, jobs and API call one service layer; project-scoped keys, stored hashed, shown once, with permissions; idempotency key on every write; signed optional webhooks; per-key rate limits; consistent documented errors; OpenAPI document; `docs/n8n.md`), "Generation jobs" (item sources include "items submitted through the API"), "Approval policy" (a job or an API call can override the project defaults, limited by the caller's API key permissions) and "Quality bar" ("API idempotency keys work").
- External facts: `docs/research/better-auth.md` "API key plugin" — `@better-auth/api-key` supports organization-owned keys, permissions checked at verify time, hashing by default, per-key rate limiting, expiry, metadata and a prefix. **UNVERIFIED there**: that the plaintext key is returned only on create, and how organization-owned keys interact with organization roles. This spec requires a test proving show-once (FR-006) and maps key permissions to Docket's own permission set (FR-004), not to member roles. `docs/research/tooling.md`: `zod` 4.6.5 (native JSON Schema) and `zod-openapi` 6.0.2 as the OpenAPI generator. Both packages and `@better-auth/api-key` 1.7.7 are already installed (`docs/decisions.md` #19). Its installed types confirm `references: "user" | "organization"`, a configurable key header and `disableKeyHashing` (hashing is the default).
- What already exists and what this feature reuses rather than reimplements (constitution IV):
  - **Services** in `src/server/services/`: media upload and listing (with the "Unused" filter, which also excludes images reserved by active job items), post creation, add to queue (with the transactional slot guarantee), schedule at a time, post and target views, upcoming empty slots, accounts, single-post generation with the approval and scheduling policy service, and the job services (create, read, retry, cancel). Every endpoint calls one of these. No endpoint holds business rules of its own.
  - **Item source interface** (008 FR-005, `src/server/services/jobs/sources/types.ts`): `ItemSource` with `kind`, `brief`, `inputSchema` and `prepare()`, and a registry. This feature adds the API-submitted source.
  - **Policy rules** (007): an override to `auto_approve` needs the `generation: auto_approve` right unless it is the project default, and `auto_approve` + `add_to_queue` needs explicit confirmation. A post that fails platform validation always goes to review.
  - **Scheduler tick** (002, 008): independent sections under one time budget, each claiming work with skip-locked plus a lease. Webhook delivery becomes another such section.
  - **Secrets at rest** (001 D16): AES-256-GCM `enc:v1:…` encryption for anything that must be read back.
  - **Audit log** (001): membership changes are recorded. Key and webhook changes join it.
  - **Settings** screens exist under `/p/[projectSlug]/settings` (members). API keys and webhooks are added there.

**Tension found while specifying (recorded for planning):** 008 FR-005 says a new source needs "only a new source and its registration". But "add items to a job" means items arrive after the job exists, and 008's jobs receive all their items at creation and derive `completed` as soon as every item is done. Planning must add an "open to new items" state and an append operation to the job service, kept as small and generic as possible, and log it as a generic change (FR-031, FR-032).

**NEEDS RESEARCH**: none blocking. The OpenAPI validity test (FR-047) may need a validator package. If none is installed, the task is marked `NEEDS DEPENDENCY: <pkg>` and the structural checks in FR-047 still run (constitution VI).

## Decisions made while specifying

Each is a judgement call. It will be appended to `docs/decisions.md` and can be reversed.

- **Key choice: prefer `@better-auth/api-key`.** Planning confirms it fits with organization-owned keys, hashing, expiry, per-key rate limits and Docket's permission names. If any of FR-001 to FR-012 cannot be met with it, planning falls back to a Docket-owned hashed-key table and logs why.
- **The key decides the project.** Paths carry no project slug (`/api/v1/posts/{id}`, not `/api/v1/p/{slug}/posts/{id}`). A key works in exactly one project, so the slug would be redundant and a mismatch could only cause errors.
- **The API accepts API keys only.** Browser session cookies are not accepted under `/api/v1`. This keeps the API free of cross-site request forgery concerns.
- **Keys belong to the project, not to the person who made them.** A key stays valid if its creator later leaves the project or changes role. Owners and admins can revoke it at any time. Actions taken with a key are attributed to the key (its name and creator).
- **Permissions are independent.** `read` is not implied by the write permissions. The creation form preselects `read` because almost every integration needs it to poll status.
- **API-created posts behave like composer posts.** A post made with `POST /posts` has origin `api`, is not put in review, and can be queued or scheduled at once, just as an editor's composed post can. Review applies to generated posts, as today.
- **Idempotency records last 7 days.** That covers an n8n execution re-run days later. After that, the same key is treated as new.
- **Idempotency in-flight duplicates get 409.** A duplicate that arrives while the first request is still running is refused with "in progress" and a retry hint. It never runs a second time and never waits on the first.
- **Webhook URLs may use `http` and private addresses.** Owners and admins configure them, and the owner's n8n runs on the same home server. The form warns when a URL is not `https`. Tightening this belongs to the hardening entry's security pass.
- **Media registered by URL is copied into the bucket**, through the same upload pipeline (conversion, dimensions, variants), because platforms need a stable public URL and Docket needs the bytes. Fetching is refused for loopback, private and link-local addresses, since any key holder can trigger it.
- **`job.finished` fires on every move into a finished state**: `completed`, `completed_with_failures` or `cancelled`. A job that is retried and finishes again sends a new event with a new event id.
- **The API includes the media library source for jobs** (for example "all unused images") alongside the API-submitted source, because it is the same service call. The CSV source is not offered over the API: callers submit items directly.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Create a scoped API key and call the API with it (Priority: P1)

A project owner opens Settings → API keys and creates a key named "n8n", ticking `read`, `write_posts` and `generate`. Docket shows the key once, with a copy button and a warning that it will not be shown again. The owner pastes it into n8n. Requests with the key reach only that project's data, only for the permissions it carries. The owner later revokes the key, and the next request with it is refused.

**Why this priority**: Nothing else in the API is usable or safe without keys. The key's permissions are the API's whole authorization model.

**Independent Test**: Create a key with `read` only. Confirm the creation response holds the plaintext key and no later read (list, detail, settings page) returns it. Confirm the stored record has no plaintext. Call `GET /api/v1/accounts` with it and get the project's accounts. Call `POST /api/v1/posts` and get 403 `missing_permission` naming `write_posts`. Call a resource id from another project and get 404. Revoke the key and confirm the next call gets 401.

**Acceptance Scenarios**:

1. **Given** an owner or admin, **When** they create a key with a name, permissions, an optional expiry and a rate limit, **Then** the plaintext key is shown once in a dialog with a copy button, and the list then shows only its name, prefix and last four characters, permissions, creator, created time, last used time, expiry and status.
2. **Given** an editor, **When** they open Settings, **Then** API keys and Webhooks are not offered, and the server refuses every key and webhook action from them.
3. **Given** a key, **When** a request names a post, job, media asset, account or item belonging to another project, **Then** the response is 404 `not_found`, exactly as for an id that does not exist.
4. **Given** a key without the permission an endpoint needs, **When** it calls that endpoint, **Then** the response is 403 `missing_permission`, naming the permission needed, and nothing changes.
5. **Given** a revoked or expired key, **When** it is used, **Then** the response is 401 `invalid_api_key` and the request has no effect. Revocation takes effect for the very next request.
6. **Given** a missing, malformed or unknown key, **When** a request is made, **Then** the response is 401 `invalid_api_key` with no hint about which keys exist.

---

### User Story 2 - Retried writes never duplicate (Priority: P1)

An n8n step calls "generate" with an `Idempotency-Key` header and times out on its side while Docket is still working. n8n retries with the same key and body. Docket either says the first request is still in progress, or returns the first request's stored response. It never generates or saves a second post. A step that reuses a key with a different body by mistake is refused.

**Why this priority**: The brief names this guarantee directly: "a retried n8n step never creates a duplicate post". A duplicate in a filled calendar is the failure the owner most wants to avoid.

**Independent Test**: Send `POST /api/v1/posts` with key K and body B and get 201. Send it again with K and B and get the same status and body, marked as a replay, with one post in the database. Send K with body B′ and get 422 `idempotency_key_reused`. Fire 20 concurrent requests with a new key and the same body and confirm exactly one post exists. Every other response is either a replay of the one result or 409 `idempotency_in_progress`.

**Acceptance Scenarios**:

1. **Given** a completed write with key K, **When** the same API key sends the same method, route and body with K again, **Then** the stored status and body are returned with the header `Idempotent-Replayed: true`, and nothing runs again.
2. **Given** a completed write with key K, **When** the same API key sends K to the same route with a different body, **Then** the response is 422 `idempotency_key_reused` and nothing runs.
3. **Given** a write with key K still running, **When** a duplicate with K arrives, **Then** the response is 409 `idempotency_in_progress` with a `Retry-After` header, and the duplicate never runs.
4. **Given** key K used on `POST /posts`, **When** K is sent to `POST /generate`, or by a different API key, **Then** it is treated as a new, unrelated key.
5. **Given** a write whose process died before its effect was committed, **When** it is retried with the same key after the in-progress hold expires, **Then** it runs once and its result is stored.
6. **Given** a write whose effect was committed, **When** it is retried with the same key, **Then** the stored response is replayed, even if the client never received the first response.
7. **Given** a write sent without an `Idempotency-Key`, **When** it is processed, **Then** it runs normally with no replay protection. The docs recommend always sending one.

---

### User Story 3 - Reproduce the old n8n flow over the API (Priority: P1)

The owner's old n8n workflow looped over rows, generated a post for each image with OpenAI, and added it to Postiz's queue. With Docket, each row registers its image by URL, calls `POST /generate` with that image and the target accounts, then `POST /posts/{id}/queue`. Each call carries an idempotency key derived from the row. `docs/n8n.md` walks through this end to end.

**Why this priority**: It is the brief's acceptance example for the whole API and the reason the API exists.

**Independent Test**: With the mock provider, a fake model and a key holding `write_posts`, `generate` and `auto_approve`, script the documented sequence for three rows. Run the whole sequence twice, with the same idempotency keys the documented expressions produce. Confirm three media assets, three posts and three queued targets per account, each in its own slot, and no extras.

**Acceptance Scenarios**:

1. **Given** an image URL, **When** `POST /api/v1/media/from-url` is called, **Then** Docket fetches it, stores it like an upload (conversion, dimensions and alt text if given), and returns the media asset.
2. **Given** a media id and target accounts, **When** `POST /api/v1/generate` is called with a brief, **Then** the generator runs as from the Generate screen, the post is saved with origin `generated` and the API key recorded as its creator, and the response holds the post with its review state and validation problems.
3. **Given** an approved post, **When** `POST /api/v1/posts/{id}/queue` is called, **Then** each target takes its account's next free slot, and the response lists each target's time or the reason it could not be queued.
4. **Given** the documented flow run twice with the same row-derived idempotency keys, **When** the second run completes, **Then** no extra media, post or slot was created.
5. **Given** `docs/n8n.md`, **When** a reader follows it, **Then** it covers creating the key and the n8n credential, the loop, each request with its exact body, the idempotency key expression, error handling (429, 409 and 422), and checking status afterwards, using only endpoints that exist.

---

### User Story 4 - Drive posts, the queue and generation jobs over HTTP (Priority: P2)

An integration creates posts, queues or schedules them, reads upcoming slots and posts' per-target status, and lists accounts. For batch work it creates a generation job and adds items to it in batches. Each item has its own fields and an optional image. It polls job and item status until the job finishes.

**Why this priority**: These are the rest of the brief's minimum endpoints. Jobs over the API are the API-submitted item source the brief asks for.

**Independent Test**: With a `manage_jobs` + `read` key, create an open job with fields `product` and `price` and a template using both. Add two batches of items, one item carrying a media id. Close the job. Run ticks with a fake model until it finishes, then read the job and each item, and confirm one post per item with the right prompt values. Repeat the add-items call with the same idempotency key and confirm no extra items.

**Acceptance Scenarios**:

1. **Given** a key with `write_posts`, **When** it creates a post with text, target accounts, optional per-platform overrides and media ids, **Then** the post is saved with origin `api` through the composer's service. Validation problems per target are returned in the response, as the composer shows them.
2. **Given** a post, **When** `POST /posts/{id}/schedule` is called with an RFC 3339 time that has an offset, **Then** each target is scheduled at that instant through the existing service, with its near-queued-post warnings. A time in the past is refused.
3. **Given** accounts with slots, **When** `GET /slots/upcoming` is called with an optional account and range, **Then** it lists upcoming slot occurrences per account in UTC and project local time, each marked free or taken.
4. **Given** a post, **When** `GET /posts/{id}` is called, **Then** it returns the post's status and review state, plus per target: account, status, schedule kind, scheduled time, external id and URL once published, attempt count and last error.
5. **Given** a key with `manage_jobs`, **When** it creates a job with source `api`, declared fields, a template, target accounts and policies, plus optional initial items, **Then** the job is created through the existing job service with each item's fields, label and optional media id.
6. **Given** an open job, **When** items are added, **Then** they are appended in order and processed like any other job item. **When** the job is closed, **Then** it finishes once every item is done or failed.
7. **Given** a closed job, **When** items are added, **Then** the response is 409 `job_closed` and nothing is added.
8. **Given** an item naming a media id reserved by another active job item, **When** the items are added, **Then** the whole request is refused with 409 `media_reserved`, naming the offending items, and nothing is added.
9. **Given** a job, **When** `GET /jobs/{id}` and `GET /jobs/{id}/items` are called, **Then** they return the job's status, open or closed state and counts, and each item's status, attempts, output post id and error, matching the job page.

---

### User Story 5 - Get told when things happen (Priority: P2)

An owner adds a webhook endpoint in Settings → Webhooks, picks events (post published, post failed, job finished, account needs reauth) and copies its signing secret. Docket sends a signed JSON event when each happens. The receiver checks the signature with the documented recipe. Failed deliveries are retried with backoff, and every attempt is visible in a delivery log. The owner rotates the secret without missing events.

**Why this priority**: It saves n8n from polling and gives the owner a push signal when an account needs reconnecting. It is optional per project, so it comes after the core API.

**Independent Test**: Add an endpoint subscribed to `post.published`. Publish a post through the mock provider and run ticks. Confirm one delivery whose signature verifies with the documented recipe and the secret, and fails verification with a wrong secret, a changed body or a timestamp outside tolerance. Make the receiver return 500 twice and then 200. Confirm three attempts, spaced by the backoff, in the log. Rotate the secret and confirm deliveries during the overlap carry signatures for both the new and old secrets.

**Acceptance Scenarios**:

1. **Given** an owner or admin, **When** they add an endpoint with a URL, a description and a set of events, **Then** its signing secret is shown once, and the endpoint is listed with its events, status (enabled or disabled) and its last delivery's result.
2. **Given** a subscribed event occurs, **When** it is recorded, **Then** it is recorded together with the change that caused it, so a killed process can neither lose it nor send one for a change that did not happen.
3. **Given** a pending delivery, **When** a tick runs, **Then** it is sent as a POST with a JSON body, an event id, an event type, a timestamp and a signature header holding the HMAC-SHA256 of `timestamp + "." + raw body`, keyed with the endpoint's secret.
4. **Given** a delivery that times out, gets a non-2xx response or cannot connect, **When** it fails, **Then** it is retried with exponential backoff up to a fixed number of attempts, then marked failed. Every attempt is logged with its time, response status, duration and a short excerpt of the response.
5. **Given** an endpoint, **When** its secret is rotated, **Then** a new secret is shown once, and for a fixed overlap period every delivery is signed with both the new and old secrets, so a receiver can switch without dropping events.
6. **Given** a delivery log entry, **When** "Resend" is chosen, **Then** the same event (same id and body, newly signed) is queued again.
7. **Given** an endpoint, **When** "Send test event" is chosen, **Then** a `ping` event is delivered and logged like any other.

---

### User Story 6 - Discover the API from its OpenAPI document (Priority: P3)

A developer, or n8n's HTTP node, fetches `/api/v1/openapi.json` and sees every endpoint with its parameters, request and response bodies, the permission it needs, the error shape and the `Idempotency-Key` header on writes. The document is generated from the same schemas the routes validate with, so it cannot drift.

**Why this priority**: The brief asks for it, and it makes the API self-describing. The API works without it, though.

**Independent Test**: Fetch the document without a key. Confirm it is valid OpenAPI 3.x and lists exactly the routes the router serves, each with its security requirement, needed permission, request schema and documented error responses. Change a route's request schema in a test fixture and confirm the generated document changes with it.

**Acceptance Scenarios**:

1. **Given** the running app, **When** `GET /api/v1/openapi.json` is requested with no key, **Then** it returns the document as JSON.
2. **Given** the document, **When** it is checked, **Then** every `/api/v1` route appears with its methods, every write declares the optional `Idempotency-Key` header, and every operation lists its error responses using the shared error schema.

---

### Edge Cases

- **Key from a project that was deleted**: 401 `invalid_api_key`.
- **Key's creator removed from the project**: the key keeps working (decision above). The list still shows the creator's name, marked "no longer a member".
- **Two simultaneous revocations, or revoking a revoked key**: the second changes nothing and says so.
- **Rate limit reached**: 429 `rate_limited` with `Retry-After`. Idempotent replays count towards the limit. A refused request has no effect and is not stored as an idempotency result.
- **Idempotency key format**: 1 to 255 printable ASCII characters. Anything else is 400 `invalid_idempotency_key`.
- **Idempotency key on a read**: ignored.
- **A request refused before it reaches the endpoint** (401, 403, 429, malformed JSON, body too large): it stores no idempotency result, so a corrected retry with the same key runs normally.
- **Server error (500) inside a write**: the write's effect is rolled back and no result is stored, so a retry with the same key runs again. A write whose effect committed always has its stored response.
- **Generation slow or not configured**: `POST /generate` waits up to the configured model timeout. With generation not configured it returns 503 `generation_not_configured`, as the Generate screen reports.
- **Auto-approve without the permission**: a request asking for `approvalPolicy: auto_approve` from a key without `auto_approve` is refused with 403 `missing_permission`, unless `auto_approve` is the project default (the editor rule from 007).
- **`auto_approve` + `add_to_queue` without confirmation**: refused with 400 `confirmation_required` unless the body sets `confirmUnreviewedQueue: true`, mirroring the UI's explicit confirmation.
- **Queueing a post in review**: the target result is `not_queueable` with the existing message. The request itself succeeds, with per-target results.
- **Account with no slots**: that target's result is `no_active_slots`, as in the UI.
- **Media by URL**: non-`http(s)` schemes, loopback, private and link-local addresses, redirects to such addresses, responses over the upload size limit, unsupported types and fetches over a time limit are refused with a specific code and message. Nothing is stored.
- **Media upload with no storage configured**: 503 `storage_not_configured`.
- **Job items over the limit**: a job holds at most 500 items. An add that would exceed it is refused whole with 400 `job_item_limit`. One add request carries at most 100 items.
- **Item fields not declared by the job**: refused with 400 `validation_failed`, naming the item and field. A declared field missing from an item renders as empty, as with an empty CSV cell.
- **Open job left open**: it stays open and shows "Open: accepting items" on the job page. Its processed items still produce posts, and it can be closed or cancelled from the UI or the API.
- **Webhook endpoint returning 410 Gone**: the endpoint is disabled, and the settings page says why.
- **Webhook endpoint failing every delivery**: after 20 consecutive failed deliveries the endpoint is disabled and flagged in Settings. Re-enabling it does not resend old failures automatically.
- **Webhook receiver slow**: each attempt times out after 10 seconds. Redirects are not followed.
- **Many events at once**: each tick delivers a bounded number, oldest first, within the tick budget. The rest wait for later ticks.
- **Unknown path or wrong method under `/api/v1`**: 404 `not_found` or 405 `method_not_allowed` in the standard error shape.
- **Non-JSON body on a JSON endpoint**: 415 `unsupported_media_type`. Malformed JSON: 400 `invalid_json`.

## Requirements *(mandatory)*

### Functional Requirements

**API keys**

- **FR-001**: Owners and admins MUST be able to create API keys in a project's settings. A key has:
  - a name;
  - one or more of the permissions `read`, `write_posts`, `generate`, `auto_approve` and `manage_jobs`;
  - a rate limit (requests per minute, default 60, allowed 1 to 1,000);
  - an optional expiry (never, 30, 90 or 365 days).

  A project holds at most 25 active keys. Editors MUST NOT be able to list, create or revoke keys. The server enforces this in the data-access layer.
- **FR-002**: Every key MUST belong to exactly one project. A request is scoped to that project for every read and write, through the same scoped data-access layer as the UI. A resource in another project MUST be indistinguishable from one that does not exist (404).
- **FR-003**: Keys MUST be high-entropy random secrets with a recognisable Docket prefix. Only a one-way hash is stored. A key is presented as `Authorization: Bearer <key>`, or in an `X-API-Key` header.
- **FR-004**: Each permission MUST map to Docket's own rights. The mapping:
  - `read`: every `GET` endpoint;
  - `write_posts`: create posts, queue, schedule, and upload or register media;
  - `generate`: single-post generation;
  - `manage_jobs`: create jobs, add items, close, retry and cancel;
  - `auto_approve`: allows requesting `auto_approve` where the project default is not `auto_approve`.

  Each endpoint declares exactly one required permission (plus `auto_approve` when it is requested), and the declaration appears in the OpenAPI document. The mapping is checked on the server before the service runs, and the service's own role checks still apply.
- **FR-005**: Owners and admins MUST be able to revoke a key. Revocation is immediate: the next request with that key is refused with 401. A revoked key is kept in the list as "revoked" with who revoked it and when, and it can never be re-enabled.
- **FR-006**: The plaintext key MUST be returned only in the creation response, and shown in the UI only in the dialog that follows creation. No later list, detail, page, log, audit entry or error contains it. A test MUST prove that:
  - the creation response holds a key that authenticates;
  - every later read path returns only the prefix and last four characters;
  - no stored column holds the plaintext.
- **FR-007**: Each key MUST record its last-used time (updated at most once a minute) and show it in the list.
- **FR-008**: Creating and revoking keys MUST be written to the project's audit log with the actor, key name and permissions, never the key itself.

**Requests, errors and rate limits**

- **FR-009**: The API MUST live under `/api/v1`, accept and return JSON (multipart only for media upload), and accept API keys only, never browser sessions.
- **FR-010**: Every error MUST use one shape: `{ "error": { "code", "message", "details"?, "requestId" } }`.
  - `code` is a stable snake_case string from a documented list.
  - `message` is plain language and safe to show.
  - `details` holds field-level problems (`path`, `message`) or per-item problems where they apply.
  - Every response carries `X-Request-Id`.

  The documented codes include at least: `invalid_api_key` (401), `missing_permission` (403), `not_found` (404), `method_not_allowed` (405), `validation_failed` (400), `invalid_json` (400), `invalid_idempotency_key` (400), `confirmation_required` (400), `idempotency_in_progress` (409), `conflict` (409), `job_closed` (409), `media_reserved` (409), `payload_too_large` (413), `unsupported_media_type` (415), `idempotency_key_reused` (422), `rate_limited` (429), `generation_not_configured` (503), `storage_not_configured` (503) and `internal_error` (500). Errors MUST never contain stack traces, SQL, tokens or keys.
- **FR-011**: Each key MUST be rate-limited to its configured requests per minute. The limit holds across all web processes, with no new infrastructure. Exceeding it returns 429 `rate_limited` with `Retry-After`.
- **FR-012**: List endpoints MUST paginate with `limit` (default 50, maximum 100) and an opaque `cursor`, returning `{ data, nextCursor }`.

**Idempotency**

- **FR-013**: Every write (`POST`, `PATCH`, `DELETE`) MUST accept an optional `Idempotency-Key` header. The result is stored per API key, method and route, with a hash of the request body (the raw bytes for multipart uploads), the response status and the response body. It is kept for 7 days.
- **FR-014**: A repeat with the same API key, method, route, idempotency key and body hash MUST return the stored status and body with `Idempotent-Replayed: true`, without running again.
- **FR-015**: A repeat with the same API key, method, route and idempotency key but a different body hash MUST return 422 `idempotency_key_reused` without running.
- **FR-016**: Concurrent requests with the same API key, method, route and idempotency key MUST run at most once, backed by a database guarantee and not only application logic. While the first is in progress, the others get 409 `idempotency_in_progress` with `Retry-After`. The in-progress hold MUST outlast the longest a write can take (including a model call at its maximum configured timeout), and then expire so a dead request can be retried.
- **FR-017**: A write's database effect and its stored idempotency result MUST be committed together. If the effect commits, the result is stored. If it rolls back, nothing is stored and the key can be used again. Requests refused before the endpoint runs (401, 403, 429, 400 for malformed JSON or an invalid idempotency key, 413, 415) store nothing.

**Endpoints** (each calls an existing service, or one extended by this feature, and contains no business rules of its own)

- **FR-018**: `POST /media` MUST upload one image (multipart, the same limits and pipeline as the media library) with optional alt text and tags. `POST /media/from-url` MUST fetch an image from an `http(s)` URL and store it through the same pipeline. The fetch MUST:
  - refuse loopback, private and link-local destinations, including after redirects;
  - follow at most 3 redirects;
  - be capped at the upload size limit and 30 seconds;
  - accept only image types the library accepts.

  Both require `write_posts`.
- **FR-019**: `GET /media` MUST list media with the library's filters: `unused=true` (not used in any post and not reserved by an active job item), `tag` and `missingAlt`. `GET /media/{id}` returns one asset with its public URL, type, dimensions, size, alt text, tags, used state and job reservation.
- **FR-020**: `POST /posts` MUST create a post through the composer's service with:
  - base text;
  - target account ids;
  - optional per-account override text;
  - optional media ids.

  The post has origin `api` and is attributed to the key. The response includes the post and each target's validation result.
- **FR-021**: `POST /generate` MUST run single-post generation through the existing generator service with:
  - a brief, optional source text, target accounts and optional media ids;
  - an optional voice profile (the project default otherwise) and one-off instructions;
  - optional approval and scheduling policies, with `confirmUnreviewedQueue` for `auto_approve` + `add_to_queue`.

  It returns the saved post, its review state, validation problems and, under `add_to_queue`, the scheduled times. Policy overrides follow FR-004 and 007's rules.
- **FR-022**: `POST /posts/{id}/queue` MUST add all or the named targets to the queue through the slot allocation service. The response gives each target's result: its UTC and local time, or a failure code and message. This uses the same per-target result codes as the UI.
- **FR-023**: `POST /posts/{id}/schedule` MUST schedule all or the named targets at an RFC 3339 instant with an offset, through the existing service, returning per-target results and near-queued warnings. Instants in the past are refused per target with `in_past`.
- **FR-024**: `GET /posts/{id}` MUST return the post's status, review state, origin, text, media, generation summary (when generated) and every target's account, status, schedule kind, scheduled time (UTC and local), external id and URL, attempt count and last error. `GET /posts/{id}/targets/{targetId}` returns one target. Tokens and attempt payloads are never included.
- **FR-025**: `GET /slots/upcoming` MUST list upcoming slot occurrences from the existing slot and calendar services, optionally for one account and a range (default 14 days, at most 60). Each occurrence has its account, UTC and local time, and whether it is free or which post holds it.
- **FR-026**: `GET /accounts` MUST list the project's social accounts with id, provider, display name, status (`active` or `needs_reauth`), last error and the provider's capabilities summary (text limit, media rules, post types). Credentials are never included.
- **FR-027**: `POST /jobs` MUST create a generation job through the existing job service with source `api` or source `media` (the media library selection, including `unused`), plus a voice profile, template, target accounts and policies (rules as FR-021). For source `api` the request declares the template fields, and may include initial items and `open: true`. A job created without `open: true` is closed at creation and must contain at least one item.
- **FR-028**: `POST /jobs/{id}/items` MUST append 1 to 100 items to an open job, keeping the 500-item job limit. Each item has field values for declared fields, an optional label and an optional media id. The request is all-or-nothing. A media id reserved by another active item, deleted, or from another project refuses the whole request, naming the items.
- **FR-029**: `POST /jobs/{id}/close`, `POST /jobs/{id}/cancel` and `POST /jobs/{id}/retry-failed` MUST call the job service's close, cancel and retry operations, with 008's rules for cancel and retry.
- **FR-030**: `GET /jobs`, `GET /jobs/{id}`, `GET /jobs/{id}/items` and `GET /jobs/{id}/items/{itemId}` MUST return what the job page shows: status, open or closed state, counts by status, policies, and per item its position, label, status, attempts, output post id and its review state, and last error.

**API-submitted item source and open jobs**

- **FR-031**: An `api` item source MUST be added through the 008 `ItemSource` interface and registry. It validates the declared fields (names usable as placeholders, at most 50) and the items (values are text, at most 50,000 characters per item in total, as for a CSV row). Its items offer exactly the declared fields to the template. An item's media is given to the model as image input, as for the media source. Reservations follow 008 FR-007.
- **FR-032**: Jobs MUST gain an open/closed state. An open job accepts appended items and is never derived as `completed` or `completed_with_failures` while open. Closing it lets the existing derivation apply. Cancelling closes it. The UI and the media and CSV sources keep creating closed jobs, unchanged. The job page shows "Open: accepting items" and offers "Close job".

**Webhooks**

- **FR-033**: Owners and admins MUST be able to add, edit, enable, disable and delete webhook endpoints per project (at most 10). Each endpoint has a URL (`http` or `https`, with a warning for `http`), a description and a set of events from `post.published`, `post.failed`, `job.finished` and `account.needs_reauth`. Changes are audit-logged.
- **FR-034**: Each endpoint MUST have a signing secret, generated by Docket, shown once at creation and at rotation, and stored encrypted at rest (it has to be read back to sign).
- **FR-035**: Events MUST be recorded in the same transaction as the change that causes them:
  - `post.published`: a post's derived status becomes `published`;
  - `post.failed`: a post's status becomes `failed` or `partially_failed`;
  - `job.finished`: a job becomes `completed`, `completed_with_failures` or `cancelled`;
  - `account.needs_reauth`: an account becomes `needs_reauth`.

  One delivery is created per subscribed, enabled endpoint. The hook-in points are the existing status-derivation and account-flagging functions, so every caller (UI, tick, API) emits events.
- **FR-036**: Each event body MUST be JSON with:
  - `id` (stable across retries and resends);
  - `type`;
  - `createdAt`;
  - `projectId`;
  - `data`, a summary of the post (with targets), job (with counts) or account, using the same shapes as the API's `GET` responses.

  Event bodies MUST never contain credentials or keys.
- **FR-037**: Each delivery MUST carry `Docket-Event-Id`, `Docket-Event-Type`, `Docket-Timestamp` (Unix seconds) and `Docket-Signature: v1=<hex>`. The signature is the HMAC-SHA256 of `<timestamp>.<raw body>`, keyed with the endpoint secret. During a rotation overlap the header carries one `v1=` value per valid secret, comma-separated. A "Verifying webhook signatures" section of `docs/n8n.md` gives the verification recipe, including the 5-minute timestamp tolerance and constant-time comparison.
- **FR-038**: Deliveries MUST be sent by a new, independent `runTick()` section with the existing claim, lease and outcome pattern:
  - bounded deliveries per tick;
  - a 10-second timeout per attempt;
  - no redirects followed;
  - no network call inside a held transaction;
  - a failure never fails other sections.

  A 2xx response is success. Anything else is retried with exponential backoff (1 minute doubling, capped at 6 hours) for up to 8 attempts, then marked failed. A 410 response disables the endpoint. 20 consecutive failed deliveries disable the endpoint.
- **FR-039**: Each attempt MUST be logged with its time, response status (or connection error kind), duration and the first 1,000 characters of the response body. Delivery logs are kept for 30 days. The settings page shows each endpoint's recent deliveries with status, attempts and "Resend", plus "Send test event" (`ping`).
- **FR-040**: Rotating a secret MUST create a new secret, show it once, and keep the old one valid for signing for 24 hours (the overlap). After that only the new secret signs. A second rotation during the overlap ends the earlier old secret immediately.

**Settings UI** (follows the `docket-ui` skill: keyboard usable, labelled fields, loading, empty, error and populated states, status as text plus colour, destructive actions confirmed in a dialog naming the thing)

- **FR-041**: Settings MUST gain **API keys** and **Webhooks** screens, offered to owners and admins only.
  - **API keys**: a table of keys (name, prefix and last four, permissions, rate limit, creator, created, last used, expiry, status); a creation form with the permission checkboxes (`read` preselected) and help text for each, including that `auto_approve` lets the key skip review; the show-once dialog with copy and "I have stored this key"; and revoke.
  - **Webhooks**: a table of endpoints; an add/edit form; the show-once secret dialog; rotate; enable and disable; delete; the delivery log with resend and send test.
  - Empty states say what goes there and offer the create action. Both screens link to `/api/v1/openapi.json` and the docs.

**OpenAPI**

- **FR-042**: The OpenAPI 3.x document MUST be generated with `zod-openapi` from the same Zod schemas the routes use to validate requests and shape responses. No document content is hand-maintained apart from titles and descriptions.
- **FR-043**: The document MUST be served at `GET /api/v1/openapi.json` without authentication. It includes every route, its parameters, its request and response bodies, the bearer and `X-API-Key` security schemes, each operation's required permission, the `Idempotency-Key` header on writes, the `Idempotent-Replayed` and `X-Request-Id` response headers, `Retry-After` on 429, and the shared error schema with its documented codes.

**Single service layer**

- **FR-044**: Route handlers under `/api/v1` MUST only authenticate, check the permission, handle idempotency, parse with the shared schema, call a service and map its result or error to the response. A test or lint rule MUST fail if a route handler imports the data-access layer or the database directly. Any rule the API needs that the UI lacks is added to the service for both.

**Docs**

- **FR-045**: `docs/n8n.md` MUST give a worked example reproducing the old flow. A loop over rows; for each row, register the image by URL, call `POST /generate` with that image, then `POST /posts/{id}/queue`. Each request sends an idempotency key built from a stable row identifier plus the step name, so a retried step or a re-run execution never duplicates media or posts. It also covers creating the key with the right permissions, the n8n credential, retry settings, handling 409, 422 and 429, and optionally a webhook trigger for `post.published`. It points to the OpenAPI document. The README links it. Judgement calls are appended to `docs/decisions.md`, including the key-plugin choice.

**Tests**

- **FR-046**: Tests MUST cover:
  - key permissions per endpoint;
  - revocation taking effect on the next request;
  - expiry;
  - show-once (FR-006);
  - rate limiting, including `Retry-After` and recovery after the window;
  - idempotency replay, body conflict (422), concurrent duplicates (exactly one effect across at least 20 parallel requests) and recovery of an expired in-progress hold;
  - API-submitted job items (create open, append, close, process, finish, reserved media refused, closed job refused, limits);
  - webhook signing and verification (good, wrong secret, changed body, stale timestamp, both signatures during rotation);
  - delivery retry with backoff, give-up, 410 disable and consecutive-failure disable;
  - event emission atomic with the state change;
  - OpenAPI document validity (FR-047);
  - the import rule of FR-044.
- **FR-047**: An OpenAPI test MUST check that:
  - the document is valid OpenAPI 3.x (with a validator if one is installed, otherwise `NEEDS DEPENDENCY`);
  - every `$ref` resolves;
  - operation ids are unique;
  - the set of documented operations equals the set of routes the router serves.
- **FR-048**: A scope-enforcement test MUST be driven by the list of operations, so a new endpoint cannot skip it. For **every** operation it checks:
  - no key → 401;
  - a key lacking the operation's permission → 403;
  - a key with it → not 401 or 403;
  - for operations taking a resource id, a key from another project → 404.

## Key Entities *(include if feature involves data)*

- **API key**: project-owned credential. It has a name, prefix and last four characters, a hash of the secret, permissions, a rate limit, an optional expiry, its creator, created, last used and revoked times, and who revoked it. It acts in its project only.
- **Idempotency record**: one per API key + method + route + idempotency key. It holds the request body hash, its state (in progress, until a hold expiry, or completed), the response status and body, and its expiry (7 days).
- **API-submitted item source**: a job item source whose items arrive in the request (declared fields, items with field values, an optional label and an optional media asset).
- **Generation job** (existing): gains an open/closed state.
- **Webhook endpoint**: project-owned. It has a URL, description, subscribed events, enabled state and reason when disabled, the current and previous (overlap) secrets encrypted, the overlap end, and a consecutive-failure count.
- **Webhook event**: project-owned, recorded with the change that caused it. It has an id, type, created time and JSON body.
- **Webhook delivery**: one per event per endpoint. It has a status (pending, delivering, succeeded, failed), attempt count, next attempt time, lease and attempts log (time, status or error kind, duration, response excerpt).
- **Post** (existing): API-created posts use origin `api`. Posts and jobs made with a key record the key as creator.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Running the documented n8n flow twice over the same rows produces exactly one media asset, one post and one queued slot per row and account. That is 0 duplicates.
- **SC-002**: Across at least 20 concurrent identical writes with one idempotency key, exactly 1 effect is produced, in every run of the test.
- **SC-003**: For 100% of API operations, a key without the required permission is refused and a key from another project cannot read or change the resource. This is checked by the operation-driven test.
- **SC-004**: A revoked key is refused on the very next request (0 requests accepted after revocation completes).
- **SC-005**: The plaintext of a key appears in exactly one response (creation) and in 0 stored values, logs or later responses.
- **SC-006**: A key over its limit receives 429 with a retry time, and requests succeed again once the window passes.
- **SC-007**: 100% of webhook deliveries verify with the documented recipe and the endpoint's secret, and 0 verify with a wrong secret or altered body.
- **SC-008**: A receiver that is down for up to 1 hour still receives every event once it recovers, without manual resends.
- **SC-009**: Every API endpoint appears in the served OpenAPI document, and the document passes validation. A route added without documentation fails the test suite.
- **SC-010**: An owner can create a key, copy it and make a first successful call in under 2 minutes using only the settings screen and `docs/n8n.md`.
- **SC-011**: Every error response uses the documented shape and code list (checked across all error paths the tests exercise).

## Assumptions

- The services from entries 001 to 008 behave as recorded in `docs/decisions.md`. Where the API needs a capability the UI lacks, it is added to the shared service and logged as a generic change. The known ones: job append, open/close, attribution to a key, and event emission in status derivation.
- A key's requests run with a project scope that carries the key's permissions in place of a member's role. Planning decides how the scoped data-access layer represents a key actor without weakening the membership check for people.
- Rate limits (60 per minute by default), the 25-key and 10-endpoint caps, the 7-day idempotency retention, the 100-item add batch, the delivery backoff (1 minute doubling to 6 hours, 8 attempts), the 10-second delivery timeout, the 24-hour rotation overlap and the 30-day delivery log are interim values. Each is one constant, logged in `docs/decisions.md`.
- "Publish now", post editing and deletion, slot management, voice profile management and account connection are not in the brief's minimum list and are not exposed over the API in this entry. "Schedule at a time" covers immediate needs.
- Webhook delivery is at least once. Receivers deduplicate by event id, and the docs say so.
- No new infrastructure. Idempotency, rate-limit state, events and deliveries live in Postgres. Delivery runs in `runTick()`.
- Verified with mocks only: deliveries go to a local test receiver, and n8n itself is not run. The n8n doc is checked by a scripted test of its exact requests.
- Out of scope (the `hardening` entry): the failures view, the limits audit, the security pass (including any tightening of webhook URL rules and request-size review), deployment docs and walkthroughs. Also out of scope: video, image generation, the CSV source over the API and API access through browser sessions.
