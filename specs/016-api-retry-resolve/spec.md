# Feature Specification: Public API to retry, bulk-retry and resolve failed and ambiguous targets

**Feature Branch**: `016-api-retry-resolve`

**Created**: 2026-10-07

**Status**: Draft

**Input**: User description: "Expose the final recovery service functions through the v1 API (src/app/api/v1/[[...path]], operations table in src/server/api/operations/) so an automation reacting to a `post.failed` webhook can act. Add operations, each calling exactly one existing service function and mapping its result: (1) retry one failed target — `POST /posts/{postId}/targets/{targetId}/retry` with body `{ mode: 'now' } | { mode: 'requeue', expected? } | { mode: 'at', at }`, calling `retryTarget` from `retry-reschedule-modes`; (2) bulk retry — e.g. `POST /targets/retry-failed` (name it to fit the existing paths) with `{ accountId?, mode: 'now' | 'requeue' }`, calling the bulk service from `bulk-retry-failures` and returning the retried/skipped counts; (3) resolve an ambiguous target — `POST /posts/{postId}/targets/{targetId}/resolve` with `{ outcome: 'published', url? } | { outcome: 'not_published', requeue: true | false, expected? }`, calling `resolveAmbiguous` unchanged in behaviour. Each verifies that the target belongs to the named post (404 otherwise), declares `resourceParams` for the cross-project scope test, is `idempotent: true` (Idempotency-Key, research D8 pipeline), and maps service errors to the existing API error shapes (ConflictError → 409 with the user-facing message, validation → 400/422 as other operations do, no_free_slot / blocked results as structured bodies, not 500s). Permission: use the existing `write_posts` key permission (it already grants `post: ['schedule']`); add a new `api_key_permission` value only if the spec finds a concrete reason, and record the choice in docs/decisions.md. Response and request schemas go in src/lib/api/schemas so the generated OpenAPI document (src/server/api/openapi.ts, operations/openapi.ts) describes them, with examples. Audit and attempt logging must match the UI actions exactly, and must attribute API actions to the API key: today `publish_attempts.actor_user_id` and `post_targets.resolved_by_user_id` are user-only and an API-key scope's `membership.userId` is the key creator or an empty string, so add `actor_api_key_id` (and `resolved_by_api_key_id`) columns via a committed SQL migration, write them through `actorColumns`-style helpers, and show 'API key <name>' (or 'Removed API key') as the actor in the Failures page attempt log via `toAttemptViews`. Webhooks emitted by the resulting status changes (`post.published`, `post.failed` via `applyDerivedStatus`) behave as for UI actions. Never leak tokens or secrets in responses or attempt summaries. Tests: API integration tests per operation — happy paths for every mode and outcome, wrong post/target pairing, cross-project key, missing permission, idempotent replay, no_free_slot and blocked-account responses, ambiguous-vs-failed status conflicts — plus the OpenAPI document test and the secret-scan test. Update docs/n8n.md (or the API docs) with a recipe: post.failed webhook → GET post → retry/requeue, and log decisions in docs/decisions.md. This entry does NOT change retry, bulk-retry or resolve semantics (those were settled by `retry-reschedule-modes` and `bulk-retry-failures`; fix a bug found here only if it blocks the API), does NOT add a failures-list or requeue-preview endpoint (automations read target state via the existing getPost/getPostTarget), and does NOT add new webhook event types."

## Context and sources

- Roadmap (`.specify/roadmaps/failure-recovery-completeness-roadmap-th.json`, entry `api-retry-resolve`): the last of three entries. It builds on `retry-reschedule-modes` (shipped as `specs/012-retry-modes`, PR #32) and `bulk-retry-failures` (shipped as `specs/015-bulk-retry-failed`, PR #34). Both are merged on `main`. This entry is a thin adapter over their final service functions and publishes their behaviour as a public contract.
- Behaviour on `main` that this feature exposes (read from the current code, `docs/failures.md` and `docs/decisions.md` 012/015):
  - **Single retry** of a `failed` target has three modes: **now** (back to `scheduled`, next attempt now, keeps its old schedule), **requeue** (runs the content/account check, then takes the account's next free slot after now; may report that the slot differs from a previewed `expected` instant) and **at** (an explicit future instant; a time not after now is refused as `in_past`; may return "near another queued post" warnings). Its typed outcomes are *scheduled* (with the instant, local time, slot or none, changed-from-preview, warnings) or *not scheduled* with a reason: `no_active_slots`, `no_free_occurrence`, `in_past`, `validation` (with the content issues) or `account_unavailable`. It refuses, as a conflict with a user-facing sentence and no writes, a target that is `publishing` ("Publishing in progress. Try again in a moment."), not `failed` ("This post is no longer failed."), or on a blocked account (removed / needs reconnecting / provider gone, with the sentences from 012 D8).
  - **Requeue with no free slot** leaves the target `failed`, sets its last error to the "Not retried — … Retry now or pick a time." sentence and writes one `retry_requested` attempt entry with `error: no_free_slot`.
  - **Bulk retry** (015) takes `{ account?, mode: now | requeue }`, re-reads the matching `failed` targets server-side, retries each in its own short transaction in "meant to go out" order (015 D1, D2), attempts at most 100 per call (015 D6) and reports: retried count, in-scope count, skipped counts under six fixed reasons (`account_removed`, `needs_reconnecting`, `provider_unavailable`, `no_longer_failed`, `cannot_publish`, `no_free_slot`), `remaining` (not attempted because of the cap), a per-account breakdown and a human-readable message. `retried + Σ skipped + remaining = inScope` (015 P7). A foreign or unknown account matches nothing (015 D8). A second call is safe by construction (015 D7).
  - **Resolve an ambiguous target**: *published* (optionally with the post's link, which must be an external http(s) URL) marks it published; *not published, don't requeue* marks it `failed` with "Marked not published by a team member. Retry or schedule it."; *not published, requeue* runs the content/account check and takes the next free slot, or, with no free slot, marks it `failed` with "Not published — no free posting slot. Retry or schedule it.". A target that is not `ambiguous` is refused with "This post was already resolved.". A requeue refused by the content/account check is a conflict carrying the check's sentence. It writes `resolved_published`, `resolved_failed` or `resolved_not_published` (+ `requeued`) attempt entries and records who resolved it and when on the target.
  - **Permission**: every one of these checks the "schedule posts" permission on the server. The `write_posts` key permission already grants view, edit and schedule on posts (`docs/decisions.md`, 009 API key grants).
  - **Public API pipeline** (009): one operations table drives the router, the OpenAPI document and the scope test. Operations with an `Idempotency-Key` header run through the research D8 protocol: claim the key, run, store the answer; a replay with the same key and body returns the stored answer with `Idempotent-Replayed: true`; a different body is `422 idempotency_key_reused`; a concurrent request with the same key is `409 idempotency_in_progress`. In the default mode the operation's effect and the stored answer commit **in one transaction**. The header is optional; without it the operation just runs. Errors use `{"error":{"code","message","details","requestId"}}`; bad input is `400 validation_failed` with per-field details, a conflict is `409 conflict`, an unknown or foreign id is `404 not_found`, a missing key permission is `403 missing_permission`.
  - **Webhooks**: a post's derived status change emits `post.published` or `post.failed` (the latter also for `partially_failed`) inside the same transaction. The event body is `{ id, type, createdAt, projectId, data }` where `data` is the post as `GET /posts/{postId}` returns it, including its targets.
  - **Attempt log**: the Failures page and the post page show attempt entries through one view builder. Today an entry's actor is either a member (by name, or "Former member") or the system.
- **Defects found while specifying that block the API** (the description allows fixing these):
  - An API-key scope's acting user is the key's creator, or an **empty string** when the creator's account no longer exists. Retry and resolve write that value straight into the user-reference columns of the attempt log and the target. With the creator gone, every retry/resolve through the API would fail with a server error; with the creator present, it would be credited to that person, not the key. This entry fixes both through the new attribution (FR-020–FR-024).
  - The D8 pipeline's default mode wraps the operation in one transaction. Bulk retry deliberately commits each target in its own short transaction (015 D1). Run inside one wrapper transaction it would hold up to 100 posts' locks for the whole call and could deadlock against queueing or a single retry. The bulk operation must therefore keep per-target commits (FR-014).
- No external platform facts are involved and nothing here needs `docs/research/`. No new runtime dependency is expected. One schema change (two nullable columns) is expected.

## Decisions made while specifying

These are judgement calls. Planning records each one in `docs/decisions.md`.

- **D1 — Paths.** `POST /posts/{postId}/targets/{targetId}/retry`, `POST /posts/{postId}/targets/{targetId}/resolve` and `POST /targets/retry-failed`. *Why:* the single-target actions sit under the existing `GET /posts/{postId}/targets/{targetId}`. The bulk action mirrors the existing `POST /jobs/{jobId}/retry-failed` in naming. It lives under `/targets` rather than `/posts/retry-failed` so it can never be confused with `/posts/{postId}`, and because the things retried are targets, across many posts. Operation ids: `retryPostTarget`, `resolvePostTarget`, `retryFailedTargets`.
- **D2 — No new key permission; all three need `write_posts`.** *Why:* `write_posts` already lets a key queue and schedule the same posts (`queuePost`, `schedulePost`), which is the same weight of action. In the UI, retry and resolve are gated by the same "schedule posts" permission as queueing. No concrete reason for a narrower permission was found. Marking an ambiguous target published (records a publish that Docket did not observe) is the most sensitive of the three, but an editor can do exactly that in the UI with the same permission, and the action is attributed to the key (D7) and visible in the attempt log. *Reverse:* adding an enum value later is backwards-compatible for existing keys.
- **D3 — Typed outcomes are `200` bodies, refusals are `409`.** *What:* every typed outcome the service *returns* is a `200` response whose body carries a `status` field: `scheduled`, `published` or `failed` (with a machine-readable `reason`, the user-facing `message`, and content `issues` where the service gives them). This includes `no_active_slots`, `no_free_occurrence`, `in_past`, `validation` and `account_unavailable` for retry, and `not_requeued` and `no_free_slot` for resolve. Every refusal the service *throws* as a conflict is `409 conflict` with the service's user-facing sentence as `message`. *Why:* it matches how `queuePost` and `schedulePost` already report per-target outcomes such as `in_past` and `no_active_slots` in a `200`, and the service already makes the same split: a returned outcome may have written something (for example the no-free-slot last error and attempt entry), while a thrown conflict wrote nothing.
- **D4 — 409 bodies carry a machine-readable reason.** *What:* each `409 conflict` from these operations includes `details.reason`, one of `publishing`, `not_failed`, `account_removed`, `needs_reconnecting`, `provider_unavailable` (retry) and `already_resolved`, `cannot_publish` (resolve). *Why:* an automation must tell "try again in a moment" (`publishing`) from "stop and alert a person" (blocked account) from "nothing to do" (`not_failed`, `already_resolved`) without parsing English. The reasons come from the same predicates the service already uses. Exposing them does not change any service behaviour, sentence or write. This is the "blocked results as structured bodies" the description asks for.
- **D5 — Request bodies document exactly the shapes listed in the description.** *What:* retry accepts `{ mode: "now" }`, `{ mode: "requeue", expected? }`, `{ mode: "at", at }`. Resolve accepts `{ outcome: "published", url? }` and `{ outcome: "not_published", requeue: true, expected? }` / `{ outcome: "not_published", requeue: false }`. Bulk accepts `{ accountId?, mode }` with no other keys and no default `mode` (as 015 P2). The service's legacy `{ outcome: "failed" }` alias is not part of the public contract and is refused as bad input. `at` is RFC 3339 with an offset, as for `schedulePost`. A missing body or missing `mode`/`outcome` is `400 validation_failed`. *Why:* a public contract should document one way to say each thing.
- **D6 — Responses carry the outcome, not the whole post.** *What:* single-target responses return the outcome (`status`, `scheduledAt`, `scheduledAtLocal`, `slotId`, `changedFromPreview`, `warnings` / `reason`, `message`, `issues`) plus `postId` and `targetId`. The bulk response returns `retried`, `inScope`, `skipped` (all six keys always present), `remaining`, `accounts[]` (id, name, retried, skipped, remaining), `mode` and `message`. *Why:* an idempotent replay returns the stored answer, so embedding the full post would replay a stale snapshot. Automations that need the current state call `GET /posts/{postId}` or `GET /posts/{postId}/targets/{targetId}`.
- **D7 — API actions are attributed to the key, and to its creator only as a secondary record.** *What:* the attempt log and the target's "resolved by" each gain a nullable reference to the project's API key. An action through the API writes the key there, and writes the key's creator in the existing user column only if that user still exists (never an empty string). UI actions write no key. A shared helper produces these column values, like the existing "created by" helper. The attempt log shows an entry with a key as **"API key {name}"**, whatever the user column holds. It keeps the key's name after the key is revoked or expires (keys are revoked, not deleted). It shows **"Removed API key"** if the key record can no longer be found. *Why:* this follows the existing "created by" convention for posts, media and jobs, where both are recorded and the key is what is shown. *Out of scope:* the existing "Deleted key" wording for a post's `createdBy` is not changed.
- **D8 — Bulk retry keeps 015's per-target commits under the idempotency protocol.** *What:* the bulk operation claims the key, runs bulk retry with its own per-target transactions, then stores the answer. This is the same arrangement the existing `generate` mode uses for effects that commit on their own. If the process dies after some targets were retried but before the answer is stored, the claim expires and a retry with the same key runs bulk retry again. That is safe, because a second run is safe by construction (015 D7). Single retry and resolve keep the default mode (effect and stored answer in one transaction). *Why:* see "Defects found while specifying".
- **D9 — The cap is visible, and continuing needs a new key.** *What:* when `remaining > 0`, the response message says so (015 D6 wording adapted to "call again"). The docs tell automations to call again with a **new** `Idempotency-Key` to continue, because the same key replays the first answer. *Why:* replay semantics are fixed by research D8.
- **D10 — Post/target pairing is checked before anything is written.** *What:* a target id that does not belong to the named post, a post or target that does not exist, belongs to another project, or whose post was deleted, all produce the same `404 not_found`. No business effect happens: no state change, no attempt entry, no webhook. Only the idempotency protocol may store the `404` answer. *Why:* identical answers for "elsewhere" and "nowhere" are the scope rule of 009 (FR-048), and a mismatched pair is most likely a bug in the caller that must not act on the wrong post.

## User Scenarios & Testing *(mandatory)*

The "user" here is a person who builds an automation (for example an n8n workflow) holding a project API key, and the project members who later read the attempt log.

### User Story 1 - An automation retries a failed post when it is told it failed (Priority: P1)

An automation subscribed to `post.failed` receives an event, reads the post's current state, picks the failed target(s) and retries each one: immediately, into the account's next free slot, or at a chosen time. It learns from the response whether the target is now scheduled, and when, or why it was not.

**Why this priority**: this is the reason for the entry. Without it, every failure needs a person to open the Failures page.

**Independent Test**: create a failed target, call `POST /posts/{postId}/targets/{targetId}/retry` with a `write_posts` key in each mode, and check the response, the target's new state (via `GET /posts/{postId}/targets/{targetId}`) and the attempt log entry.

**Acceptance Scenarios**:

1. **Given** a failed target on an active account, **When** the automation retries it with `{ "mode": "now" }`, **Then** the response is `200` with `status: "scheduled"`, `mode: "now"` and a `scheduledAt` of the current instant, and the target is `scheduled` with its attempt count and last error cleared, exactly as a UI "Retry now" leaves it.
2. **Given** a failed target whose account has a free slot, **When** the automation retries it with `{ "mode": "requeue" }`, **Then** the response is `200` with `status: "scheduled"`, the slot's instant, its local time in the project time zone and the slot id, and the target holds that slot occurrence.
3. **Given** the same, **When** the request also carries an `expected` instant that differs from the slot actually taken, **Then** `changedFromPreview` is `true`. It is `false` when they match.
4. **Given** a failed target, **When** the automation retries it with `{ "mode": "at", "at": "<future RFC 3339 instant>" }`, **Then** the response is `200` with `status: "scheduled"`, `slotId: null`, the instant and local time, and any "near another queued post" warnings.
5. **Given** a failed target, **When** the automation retries it with `{ "mode": "at" }` and an instant that is not in the future, **Then** the response is `200` with `status: "failed"`, `reason: "in_past"` and the message "That time has passed. Use Retry now instead.", and the target is unchanged.
6. **Given** a failed target whose account has no free slot (or no active slots), **When** the automation retries it with `{ "mode": "requeue" }`, **Then** the response is `200` with `status: "failed"`, `reason: "no_free_occurrence"` (or `"no_active_slots"`) and the "Not retried — …" message, the target stays `failed` with that message as its last error, and the attempt log has the same single `retry_requested` entry a UI requeue would write.
7. **Given** a failed target whose content no longer passes the content/account check, **When** the automation retries it with `requeue` or `at`, **Then** the response is `200` with `status: "failed"`, `reason: "validation"` (or `"account_unavailable"`), the message and the content issues, and nothing changes.

---

### User Story 2 - An automation is told clearly when a retry cannot happen (Priority: P1)

An automation retries a target that cannot be retried right now: it is publishing, it is no longer failed (someone else already retried it), or its account was removed, needs reconnecting or lost its provider. It receives a `409` with a reason it can branch on, and nothing is changed.

**Why this priority**: an automation that cannot tell "wait" from "give up" from "already done" either loops or gives up wrongly. Webhook re-deliveries and races with people using the UI make these cases common.

**Independent Test**: put targets into each refused state and call retry. Check the status code, `details.reason`, the message and that no attempt entry or state change occurred.

**Acceptance Scenarios**:

1. **Given** a target that is `publishing`, **When** it is retried, **Then** the response is `409 conflict` with `details.reason: "publishing"` and "Publishing in progress. Try again in a moment.".
2. **Given** a target that is `scheduled`, `published`, `ambiguous` or cancelled, **When** it is retried, **Then** the response is `409 conflict` with `details.reason: "not_failed"` and "This post is no longer failed.".
3. **Given** a failed target whose account needs reconnecting / was removed / has no registered provider, **When** it is retried in any mode, **Then** the response is `409 conflict` with `details.reason` `needs_reconnecting` / `account_removed` / `provider_unavailable` and the matching user-facing sentence, and nothing is written.
4. **Given** an `ambiguous` target, **When** the automation calls *retry* on it, **Then** it gets `409` `not_failed` (ambiguous targets are resolved, never retried). **Given** a `failed` target, **When** it calls *resolve* on it, **Then** it gets `409` `already_resolved`.

---

### User Story 3 - An automation resolves an ambiguous publish (Priority: P2)

An automation (or a person working through one) learns out-of-band whether an ambiguous publish actually went out. It tells Docket it was published, with the link if known, or that it was not published, and whether to requeue it into the next free slot.

**Why this priority**: ambiguous targets are rarer than failures and Docket never retries them on its own. Without this, they stay in "Needs your decision" until a person acts, but they don't block other work.

**Independent Test**: create ambiguous targets, call `POST /posts/{postId}/targets/{targetId}/resolve` with each outcome, and check the response, target state, resolver attribution, attempt entries and emitted webhook.

**Acceptance Scenarios**:

1. **Given** an ambiguous target, **When** it is resolved with `{ "outcome": "published", "url": "https://…" }`, **Then** the response is `200` with `status: "published"`, the target is `published` with that link, it is recorded as resolved by the key, and if the post's derived status becomes published, a `post.published` webhook is emitted exactly as for the UI action.
2. **Given** an ambiguous target, **When** it is resolved with `{ "outcome": "not_published", "requeue": false }`, **Then** the response is `200` with `status: "failed"`, `reason: "not_requeued"` and "Marked not published by a team member. Retry or schedule it.", and the target is `failed`.
3. **Given** an ambiguous target whose account has a free slot, **When** it is resolved with `{ "outcome": "not_published", "requeue": true }`, **Then** the response is `200` with `status: "scheduled"`, the slot's instant, local time, slot id and `changedFromPreview` (against `expected` if given), and the attempt log has `resolved_not_published` then `requeued` entries, as for the UI action.
4. **Given** an ambiguous target with no free slot, **When** it is resolved with requeue, **Then** the response is `200` with `status: "failed"`, `reason: "no_free_slot"` and "Not published — no free posting slot. Retry or schedule it.".
5. **Given** an ambiguous target whose content or account fails the check, **When** it is resolved with requeue, **Then** the response is `409 conflict` with `details.reason: "cannot_publish"` and the check's sentence, and the target stays `ambiguous`.
6. **Given** a `published` link that is not an external http(s) URL, **When** it is sent, **Then** the response is `400 validation_failed` with a detail naming `url`, and nothing changes.

---

### User Story 4 - An automation retries everything that failed, optionally for one account (Priority: P2)

After fixing a cause (for example reconnecting an account), an automation retries every failed target in the project, or only one account's, either now or into next free slots, and gets back how many were retried and how many were skipped, and why.

**Why this priority**: valuable for recovering from outages, but a per-target loop over `GET /posts` + single retry can approximate it.

**Independent Test**: create failed targets across two accounts with a mix of blocked, publishing and normal states, call `POST /targets/retry-failed` with and without `accountId` in both modes, and compare the response counts and per-account rows with the database.

**Acceptance Scenarios**:

1. **Given** failed targets on two accounts, **When** the automation calls `{ "mode": "now" }`, **Then** the response is `200` with `retried`, `inScope`, all six `skipped` keys, `remaining`, `accounts[]` and `message`, and the counts add up (`retried + Σ skipped + remaining = inScope`).
2. **Given** the same, **When** it passes `accountId` of one account, **Then** only that account's failed targets are considered.
3. **Given** an `accountId` that is unknown or belongs to another project, **When** it is called, **Then** the response is `200` with `inScope: 0` and the "nothing to retry" message, the same answer for both.
4. **Given** `{ "mode": "requeue" }` and an account that runs out of free slots part-way, **Then** that account's remaining targets are counted under `no_free_slot` exactly as 015 does, and earlier failures got earlier slots.
5. **Given** more than 100 retryable failed targets, **When** it is called, **Then** at most 100 are attempted, `remaining` reports the rest and the message tells the caller to call again.
6. **Given** a request body with extra keys (for example a list of target ids) or no `mode`, **When** it is sent, **Then** the response is `400 validation_failed`.

---

### User Story 5 - Repeated or re-delivered requests never act twice (Priority: P1)

Webhook deliveries can be re-sent and HTTP clients retry on timeouts. An automation that sends the same request with the same `Idempotency-Key` must get the first answer back, with no second retry, no second attempt entry and no second webhook.

**Why this priority**: a double retry can mean a duplicate post, which the product treats as worse than a missed one.

**Independent Test**: send each operation twice with the same key and body, compare responses and count attempt entries, state changes and webhook events.

**Acceptance Scenarios**:

1. **Given** a completed request with key K, **When** the same request is sent with K, **Then** the stored status and body are returned with `Idempotent-Replayed: true` and nothing else happens. This holds for `200` outcomes and for stored `4xx` answers (for example a `409`).
2. **Given** key K was used, **When** a different body is sent with K, **Then** the response is `422 idempotency_key_reused`.
3. **Given** a request with key K still running, **When** the same request with K arrives, **Then** the response is `409 idempotency_in_progress` with `Retry-After`.
4. **Given** no `Idempotency-Key`, **When** a retry is sent twice, **Then** the second call is refused by the service's own state checks (`409 not_failed`) rather than retrying again.

---

### User Story 6 - Members see who acted, and keys only reach their own project (Priority: P1)

Project members reading a target's attempt log see "API key {name}" for actions taken through the API, not the key's creator and not "System". A key from another project, or one without `write_posts`, cannot act at all.

**Why this priority**: attribution and isolation are non-negotiable for a public write API (constitution III and the build brief's audit expectations).

**Independent Test**: act through the API, then load the Failures page / post page attempt views. Repeat after revoking the key, and with a key whose creator was removed. Call each operation with a foreign project's key and with a `read`-only key.

**Acceptance Scenarios**:

1. **Given** a retry or resolve done through key "n8n recovery", **When** a member views that target's attempt log, **Then** the entry's actor reads "API key n8n recovery". It still reads so after the key is revoked or expires.
2. **Given** the key's creator has left the project or their user account was deleted, **When** the key retries or resolves a target, **Then** the action succeeds (no server error), and the attempt log still reads "API key {name}".
3. **Given** an attempt entry whose key record can no longer be found, **Then** the actor reads "Removed API key".
4. **Given** the same action done in the UI by a member, **Then** the entry's actor is that member, exactly as today, and no key is recorded.
5. **Given** a key from project B, **When** it names project A's post or target ids in any of the three operations, **Then** the response is `404 not_found`, identical to an unknown id, and nothing changes.
6. **Given** a key without `write_posts`, **When** it calls any of the three operations, **Then** the response is `403 missing_permission` naming `write_posts`, and nothing changes.
7. **Given** a target id from a different post of the same project, **When** it is used with the wrong `postId`, **Then** the response is `404 not_found` and nothing changes.

---

### User Story 7 - An automation builder can follow a documented recipe (Priority: P3)

A person setting up n8n follows `docs/n8n.md` to wire `post.failed` → read the post → retry or requeue its failed targets, with idempotency keys and a retry limit so a permanently failing post doesn't loop.

**Why this priority**: the endpoints are usable without it, but the loop and key-reuse pitfalls are not obvious.

**Independent Test**: read the recipe and check that every request, header and field it names exists in the OpenAPI document, and that it covers re-delivery, the retry-loop limit, `409` reasons and `remaining`.

**Acceptance Scenarios**:

1. **Given** the recipe, **When** a builder follows it, **Then** it shows the three requests (receive `post.failed`, `GET /posts/{postId}`, `POST …/retry`), derives the `Idempotency-Key` from the webhook event id and target id, and limits how many times the automation retries the same target.
2. **Given** the OpenAPI document, **When** a builder opens any of the three operations, **Then** the request and every response have a schema and at least one example.

---

### Edge Cases

- **Retry loop**: retry → publish fails again → another `post.failed` → automation retries again. Docket's attempt count resets on every retry, so the automation cannot rely on it. The recipe must make the automation keep its own limit (D9, US7).
- **Webhook payload is stale**: the event's `data` is the post at emission time. A person may already have retried or resolved it. The recipe reads the post first; the endpoints answer `409 not_failed` / `already_resolved` if it was acted on in between.
- **A post with several targets, some failed**: `post.failed` covers `partially_failed` too. The automation retries only targets whose status is `failed`; published targets are never touched.
- **Ambiguous targets in a `post.failed` post**: they are reported as `ambiguous`. The recipe must not retry them, because ambiguous outcomes are never retried automatically (constitution V). It may alert a person or call resolve only when it actually knows the outcome.
- **Race with the scheduler or a person**: a retry arriving while the target is being claimed waits for the claim's lock, then sees `publishing` (`409`). Two automations retrying the same target with different keys: one succeeds, the other gets `409 not_failed`. Concurrency is as settled by 012/015; this entry adds no new locking.
- **Bulk call with `remaining > 0` repeated with the same key** replays the first answer and retries nothing more. The docs say to use a new key to continue (D9).
- **Process dies mid-bulk-run**: finished targets stay retried. A retry with the same key, after the claim's hold expires, runs again and is safe (D8).
- **Rate limit**: each call counts once against the key's per-minute limit, whatever the number of targets a bulk call touches. `429 rate_limited` is answered before any effect.
- **`expected` without an effect**: `expected` only affects `changedFromPreview`; it never changes which slot is taken.
- **Picked time across a DST change**: `at` carries an explicit offset, so there is no wall-time ambiguity. `scheduledAtLocal` is rendered in the project time zone as everywhere else.
- **Key revoked between requests**: later calls get `401 invalid_api_key`. Earlier attempt entries keep the key's name.
- **Deleted post**: its targets are `404 not_found` for all three operations.
- **Body not JSON / wrong content type**: answered as for other JSON operations (`400 invalid_json` / `415`).

## Requirements *(mandatory)*

### Functional Requirements

**Operations and contract**

- **FR-001**: The public API MUST offer `POST /posts/{postId}/targets/{targetId}/retry` (`retryPostTarget`), `POST /posts/{postId}/targets/{targetId}/resolve` (`resolvePostTarget`) and `POST /targets/retry-failed` (`retryFailedTargets`), registered in the single operations table so the router, OpenAPI document and scope test all see them (D1).
- **FR-002**: Each operation MUST call exactly one existing recovery service function: single retry, resolve-ambiguous, or bulk retry. It MUST NOT re-implement any retry, resolve, slot, gate, locking or status logic (constitution IV).
- **FR-003**: The three operations MUST NOT change the observable behaviour of single retry, bulk retry or resolve-ambiguous for UI callers. That covers states, sentences, attempt entries (other than the added key attribution of FR-020), webhooks, locking and caps. Changes to those services are limited to attribution (FR-020–FR-024), exposing refusal reasons (FR-011) and fixes for defects that block the API.
- **FR-004**: Each operation MUST require the existing `write_posts` key permission; a key without it MUST get `403 missing_permission` naming `write_posts`, with nothing written. No new key permission value is added (D2).
- **FR-005**: Each operation MUST be idempotent under the research D8 protocol: replay with the same key and body returns the stored answer with `Idempotent-Replayed: true` and has no further effect; a different body with the same key is `422 idempotency_key_reused`; a concurrent same-key request is `409 idempotency_in_progress`.

**Single retry**

- **FR-006**: The retry body MUST be one of `{ mode: "now" }`, `{ mode: "requeue", expected? }` (`expected` an RFC 3339 instant) or `{ mode: "at", at }` (`at` RFC 3339 with an offset). Anything else, including a missing body or mode, MUST be `400 validation_failed` with per-field details (D5).
- **FR-007**: A scheduled outcome MUST be `200` with `postId`, `targetId`, `status: "scheduled"`, `mode`, `scheduledAt` (UTC), `scheduledAtLocal` (project time zone), `slotId` (or null), `changedFromPreview` and `warnings` (D3, D6).
- **FR-008**: A not-scheduled outcome returned by the service MUST be `200` with `postId`, `targetId`, `status: "failed"`, `reason` (one of `no_active_slots`, `no_free_occurrence`, `in_past`, `validation`, `account_unavailable`), the service's `message`, and `issues` when the service gives them (D3).

**Resolve**

- **FR-009**: The resolve body MUST be `{ outcome: "published", url? }` (`url` an external http(s) URL) or `{ outcome: "not_published", requeue: true, expected? }` or `{ outcome: "not_published", requeue: false }`. Anything else, including the service's legacy `{ outcome: "failed" }`, MUST be `400 validation_failed`; a bad `url` MUST be reported against `url` (D5).
- **FR-010**: Resolve outcomes MUST be `200` with `postId`, `targetId` and `status: "published"`; or `status: "scheduled"` with `scheduledAt`, `scheduledAtLocal`, `slotId` and `changedFromPreview`; or `status: "failed"` with `reason` `not_requeued` or `no_free_slot` and the service's message (D3).

**Refusals and errors**

- **FR-011**: A refusal thrown by the service as a conflict MUST be `409 conflict` with the service's user-facing sentence as `message` and `details.reason` set to one of `publishing`, `not_failed`, `account_removed`, `needs_reconnecting`, `provider_unavailable` (retry) or `already_resolved`, `cannot_publish` (resolve). Nothing MUST be written in these cases (D4).
- **FR-012**: The outcomes and refusals described in this spec MUST NOT produce a `5xx`. Only an unexpected error may, and it MUST use the existing generic internal error body with no internal detail.
- **FR-013**: A target that does not belong to the named post, an unknown or foreign post or target id, or a deleted post MUST give the same `404 not_found` with no business effect: no state change, attempt entry or webhook. Storing that answer under the idempotency key is allowed (D10). Both path ids MUST be declared as project resource parameters so the cross-project scope test covers them.

**Bulk retry**

- **FR-014**: The bulk body MUST be exactly `{ accountId?, mode }` with `mode` `now` or `requeue` and no default. Extra keys or a missing/invalid mode MUST be `400 validation_failed`. The operation MUST keep bulk retry's per-target transactions and must not run it inside one long transaction (D8).
- **FR-015**: The bulk response MUST be `200` with `mode`, `retried`, `inScope`, `skipped` (all six reason keys, zeros included), `remaining`, `accounts[]` (account id, name or "Removed account", retried, skipped by reason, remaining) and `message`. It MUST satisfy `retried + Σ skipped + remaining = inScope` (D6).
- **FR-016**: An unknown or foreign `accountId` MUST produce the same `200` "nothing to retry" answer as an account with no failures (015 D8). It MUST NOT reveal whether the account exists elsewhere.
- **FR-017**: When the cap leaves targets unattempted, the `message` MUST say how many and that calling again continues. The docs MUST say to use a new `Idempotency-Key` to continue (D9).

**Attempt log, attribution and audit**

- **FR-018**: Every state change, attempt entry and last-error write caused through the API MUST be identical to the same action in the UI: same outcome values, step, request summary, error, timestamps and ordering. The only differences are the actor attribution fields of FR-020.
- **FR-019**: Requests refused before the service runs (validation, permission, pairing, rate limit, idempotency) MUST write no attempt entry.
- **FR-020**: The attempt log and the target's "resolved by" record MUST each gain a nullable reference to an API key of the same project. They MUST be added by a committed SQL migration that keeps the migration check green. Existing rows keep null.
- **FR-021**: An action through an API key MUST record the key in those references, and MUST record the key's creator in the existing user reference only when that user exists, otherwise null. An empty or invalid user id MUST never be written. One shared helper MUST produce these values for both places (D7).
- **FR-022**: Actions by members (UI) and by the engine MUST record no key, exactly as today.
- **FR-023**: Wherever attempt entries are shown (the Failures page attempt log and the post page), an entry with a key MUST show its actor as "API key {name}", using the key's current name even if revoked or expired, or "Removed API key" if the key cannot be found. Member and system entries MUST show as today.
- **FR-024**: Retrying or resolving through a key whose creator left the project or whose creator's user account was deleted MUST succeed.

**Webhooks**

- **FR-025**: Status changes caused through the API MUST emit `post.published` / `post.failed` events exactly as the same UI action would, in the same transaction, with the same payload. No new event type is added.

**Secrets**

- **FR-026**: Responses, `409`/`4xx` details, attempt request/response summaries and logs produced by these operations MUST contain no API key secret or hash, no `Idempotency-Key` value, no provider token and no webhook secret. Only ids, statuses, instants, reasons and user-facing sentences appear. The key's name may appear in the attempt log view; its last four characters MUST NOT appear there.

**Documentation and OpenAPI**

- **FR-027**: Request and response schemas for all three operations MUST be shared API schemas, so that the generated OpenAPI document describes each request body (with its alternatives), each `200` body (with its alternatives), and the `400`, `401`, `403`, `404`, `409`, `422` and `429` answers. Each MUST have at least one example: every retry mode, every resolve outcome, a no-free-slot outcome and a `409` with a reason.
- **FR-028**: `docs/n8n.md` MUST gain a recipe: subscribe to `post.failed`, verify the signature, `GET /posts/{postId}`, then for each target with status `failed` call retry (now or requeue). The `Idempotency-Key` is derived from the event id and target id. The recipe MUST include a per-target retry limit kept by the automation, MUST NOT retry `ambiguous` targets, and MUST say how to handle `409` reasons and bulk `remaining`. It MUST also add the new `409` reasons to the errors table.
- **FR-029**: `docs/decisions.md` MUST record D1–D10 and the plan's judgement calls. `docs/failures.md` MUST mention that the same actions are available through the API, and that API actions show as "API key {name}".

**Tests**

- **FR-030**: Integration tests MUST cover, per operation: every mode/outcome happy path; wrong post/target pairing; cross-project key; missing permission; idempotent replay (including a replayed `409`) and key reuse with a different body; no-free-slot and blocked-account responses; ambiguous-vs-failed status conflicts (retry on ambiguous, resolve on failed); `publishing`; attribution (key, creator gone, revoked key, removed key, UI unchanged); webhook emission parity; and bulk counts, account filter, foreign account and cap. The OpenAPI document test and the secret-scan test MUST cover the new operations.

### Key Entities

- **Retry request / outcome**: the chosen mode (now, requeue with optional previewed instant, at with an instant) and the result: scheduled (instant, local time, slot or none, changed-from-preview, warnings) or not scheduled (reason, message, content issues).
- **Resolve request / outcome**: the outcome (published with optional link; not published with or without requeue and optional previewed instant) and the result: published, scheduled (instant, local time, slot, changed-from-preview) or failed (not requeued / no free slot, message).
- **Bulk retry request / outcome**: optional account and mode; retried, in-scope, skipped by six reasons, remaining, per-account rows, message.
- **Refusal**: a conflict with a machine-readable reason and the user-facing sentence.
- **Attempt entry (extended)**: who acted: a member, the system, or an API key of the project (with the key creator kept as a secondary record when they still exist).
- **Target resolution record (extended)**: who resolved an ambiguous target: a member or an API key, and when.
- **API key** (existing): its name is what the attempt log shows. Keys are revoked, not deleted.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An automation can go from receiving a `post.failed` event to having every failed target of that post scheduled again using only documented requests: one read plus one retry per target, with no human step.
- **SC-002**: 100% of the outcomes and refusals listed in this spec answer with a documented non-5xx status and a body an automation can branch on without parsing English (`status` / `reason` / `details.reason`).
- **SC-003**: Sending any of the three requests twice with the same `Idempotency-Key` produces exactly one effect: one state change, one set of attempt entries, at most one webhook event. Tests check this for every operation.
- **SC-004**: For every action taken through the API, a project member viewing the attempt log can identify the key by name. Zero entries show the key's creator or "System" instead.
- **SC-005**: For each retry mode and resolve outcome, the target state, attempt entries (ignoring the key attribution) and webhooks after an API call match those after the equivalent UI action, verified side by side in tests.
- **SC-006**: A key can never affect another project's targets or act without `write_posts`. Every operation is covered by the cross-project and missing-permission tests.
- **SC-007**: Every request, response and error of the three operations appears in the OpenAPI document with a schema and an example, and the secret-scan test finds no secret in any of their responses or attempt summaries.
- **SC-008**: A bulk call over more than 100 retryable targets answers in about the same time as the same press on the Failures page (015 measured about 3 seconds for 100 requeues, and allows at most 10). It also tells the caller how many targets remain.

## Assumptions

- The automation builder holds a project API key with `write_posts` and has set up a webhook endpoint subscribed to `post.failed`. Both features exist (009, webhooks).
- The single retry, bulk retry and resolve-ambiguous service functions on `main` after PR #34 are final. Their states, sentences, caps and locking are the contract this entry publishes.
- "Validation → 400/422 as other operations do" means: malformed requests are `400 validation_failed` (as every existing operation does); `422` is used only by the idempotency protocol (`idempotency_key_reused`). Content problems found by the content/account check during retry are typed `200` outcomes (as `queuePost`/`schedulePost` report them), not `422`.
- The machine-readable refusal reasons (D4) can be exposed with an additive change to how the services raise conflicts, without changing any sentence or behaviour.
- Attributing to both the key and (when present) the creator matches the existing "created by" convention; showing the key wins in every attempt-log view.
- No backfill is needed for existing attempt entries: no API operation could retry or resolve before this entry.
- The Failures page and post page attempt views are the only places attempt actors are shown; the public API does not expose attempt entries.

## Out of Scope

- Any change to retry, bulk-retry or resolve semantics, wording, caps or locking beyond FR-003's allowances.
- A failures-list endpoint or a requeue/next-free-slot preview endpoint. Automations read state via `GET /posts/{postId}` and `GET /posts/{postId}/targets/{targetId}`.
- New webhook event types or payload changes.
- Bulk "pick a time", bulk resolve of ambiguous targets, or retrying a caller-supplied list of target ids.
- A new API key permission (D2).
- Changing the "Deleted key" wording of a post's `createdBy`, or exposing attempt entries through the API.
