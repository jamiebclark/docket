# Contract: HTTP API — retry, resolve, bulk retry

Base `/api/v1`. Authentication, rate limiting, error envelope and idempotency are as in `specs/009-public-api/contracts/http-api.md`. All three operations:

- need the **`write_posts`** permission;
- are `idempotent: true`, taking an optional `Idempotency-Key` header;
- take `application/json` bodies;
- carry the tag `Recovery`.

The error envelope is `{"error":{"code","message","details"?,"requestId"}}`.

## Common answers

| Status | Code | When |
|---|---|---|
| 400 | `validation_failed` | Body fails the schema. `details` is `[{ path, message }]` |
| 400 | `invalid_json` / `invalid_idempotency_key` | As for every JSON write |
| 401 | `invalid_api_key` | Missing, unknown, revoked or expired key |
| 403 | `missing_permission` | Key lacks `write_posts`. `details: { permission: "write_posts" }` |
| 404 | `not_found` | Unknown or foreign post/target id, deleted post, or target not on that post. Same body for all of them |
| 409 | `conflict` | Service refusal. `details: { reason }` (see each operation) |
| 409 | `idempotency_in_progress` | Same key still running. Has a `Retry-After` header |
| 415 | `unsupported_media_type` | Non-JSON content type |
| 422 | `idempotency_key_reused` | Same key, different body |
| 429 | `rate_limited` | Has a `Retry-After` header. Answered before any effect |
| 500 | `internal_error` | Unexpected only. Generic message, never stored under the key |

A replay returns the stored status and body with `Idempotent-Replayed: true`. That includes a stored `400`, `404` or `409`.

---

## `POST /posts/{postId}/targets/{targetId}/retry` — `retryPostTarget`

`resourceParams: ["postId", "targetId"]`. Calls `retryTarget(scope, targetId, body, { postId })`.

### Request (`RetryTargetRequest`, one of)

```json
{ "mode": "now" }
{ "mode": "requeue", "expected": "2026-10-08T09:00:00+02:00" }
{ "mode": "at", "at": "2026-10-08T15:30:00+02:00" }
```

- `expected` is optional. It only sets `changedFromPreview` and never changes which slot is taken.
- `at` is required for `mode: "at"`.
- Any other key, or a missing `mode`, is `400`.

### 200 (`RetryTargetResult`, one of)

Scheduled:

```json
{
  "postId": "…", "targetId": "…",
  "status": "scheduled",
  "mode": "requeue",
  "scheduledAt": "2026-10-08T07:00:00.000Z",
  "scheduledAtLocal": "Thu 8 Oct, 09:00",
  "slotId": "…",
  "changedFromPreview": false,
  "warnings": []
}
```

- `mode: "now"`: `scheduledAt` is the current instant, `slotId` is null, and `warnings` is empty.
- `mode: "at"`: `slotId` is null, and `warnings` may hold `{ "severity": "warning", "code": "near_queued", "message": "…" }` items, using the codes the service already produces.

Not scheduled, which the service returns as a typed outcome:

```json
{
  "postId": "…", "targetId": "…",
  "status": "failed",
  "reason": "no_free_occurrence",
  "message": "Not retried — Acme Bluesky has no free posting slot. Retry now or pick a time."
}
```

`reason` takes one of these values:

| `reason` | Modes | Effect |
|---|---|---|
| `no_active_slots` | requeue | `last_error` set, one `retry_requested` entry |
| `no_free_occurrence` | requeue | `last_error` set, one `retry_requested` entry |
| `in_past` | at | none. Message "That time has passed. Use Retry now instead." |
| `validation` | requeue, at | none. `issues: [{ severity, code, message, field? }]` |
| `account_unavailable` | requeue, at | none |

### 409 `conflict` `details.reason`

`publishing` · `not_failed` (also for `ambiguous`, `scheduled`, `published`, `cancelled`) · `account_removed` · `needs_reconnecting` · `provider_unavailable`. Nothing is written.

---

## `POST /posts/{postId}/targets/{targetId}/resolve` — `resolvePostTarget`

`resourceParams: ["postId", "targetId"]`. Calls `resolveAmbiguous(scope, targetId, body', { postId })`, where `body'` has `expected` normalised to UTC.

### Request (`ResolveTargetRequest`, one of)

```json
{ "outcome": "published", "url": "https://bsky.app/profile/acme/post/3k…" }
{ "outcome": "not_published", "requeue": true, "expected": "2026-10-08T09:00:00+02:00" }
{ "outcome": "not_published", "requeue": false }
```

- `url` is optional. It must be an external `http(s)` URL of at most 2048 characters, and a bad one is a `400` with `path: "url"`.
- `{ "outcome": "failed" }` is a `400`, because the legacy alias is not public.
- `requeue` is required with `not_published`.

### 200 (`ResolveTargetResult`, one of)

```json
{ "postId": "…", "targetId": "…", "status": "published" }
{ "postId": "…", "targetId": "…", "status": "scheduled", "scheduledAt": "…Z", "scheduledAtLocal": "…", "slotId": "…", "changedFromPreview": true }
{ "postId": "…", "targetId": "…", "status": "failed", "reason": "not_requeued", "message": "Marked not published by a team member. Retry or schedule it." }
{ "postId": "…", "targetId": "…", "status": "failed", "reason": "no_free_slot", "message": "Not published — no free posting slot. Retry or schedule it." }
```

### 409 `conflict` `details.reason`

- `already_resolved`: the target is not `ambiguous`, including `failed`.
- `cannot_publish`: the requeue was refused by the content/account check. The message is the check's sentence, and the target stays `ambiguous`.

---

## `POST /targets/retry-failed` — `retryFailedTargets`

No path params, so no `resourceParams`. Calls `retryAllFailed(scope, { account: accountId, mode })`. Idempotency mode is `self_commit`: each target commits in its own transaction, and the answer is stored afterwards.

### Request (`RetryFailedTargetsRequest`)

```json
{ "mode": "now" }
{ "mode": "requeue", "accountId": "…" }
```

`mode` is required (`now` | `requeue`). `accountId` is optional. Any other key, for example `targetIds`, is `400`.

### 200 (`RetryFailedTargetsResult`)

```json
{
  "mode": "requeue",
  "retried": 3,
  "inScope": 6,
  "skipped": {
    "account_removed": 0, "needs_reconnecting": 1, "provider_unavailable": 0,
    "no_longer_failed": 0, "cannot_publish": 0, "no_free_slot": 2
  },
  "remaining": 0,
  "accounts": [
    { "accountId": "…", "name": "Acme Bluesky", "retried": 3, "skipped": { "…": 0, "no_free_slot": 2 }, "remaining": 0 },
    { "accountId": "…", "name": "Acme Threads", "retried": 0, "skipped": { "needs_reconnecting": 1, "…": 0 }, "remaining": 0 }
  ],
  "message": "Retried 3 failed posts. Skipped 3: 1 need reconnecting, 2 no free slot."
}
```

- `skipped` always has all six keys, at the top level and in each account row.
- `retried + Σ skipped + remaining = inScope`.
- A removed account's row has the name `"Removed account"`.
- An unknown or foreign `accountId` returns `inScope: 0` and the service's "nothing to retry" message, the same as an account with nothing failed.
- When `remaining > 0`, the message says how many were not retried. To continue, call again with a **new** `Idempotency-Key`: the same key replays this answer.

`message` is built by the same pure `retryAllMessage` from the service result, with `{ continueWith: "call" }` (research P15). It is identical to the Failures page message, except that the last sentence, "Press Retry all failed again to continue.", becomes "Call again with a new Idempotency-Key to continue." Example: "100 posts will be retried. 20 more failed posts were not retried yet. Call again with a new Idempotency-Key to continue."

---

## OpenAPI

Each operation declares these response statuses, each with at least one `examples` entry: `200`, `400`, `401`, `403`, `404`, `409`, `422` and `429`. The request body also has examples for each alternative (FR-027, research P11). Examples use fake UUIDs and fake names, and no key-like strings.
