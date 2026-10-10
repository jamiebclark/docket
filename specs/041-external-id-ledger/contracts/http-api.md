# Contract — Public API: tagging submissions with a source record id

**Feature**: 041-external-id-ledger | **Date**: 2026-10-10

No new endpoint, no new permission, no new error code. Three existing operations gain optional request
fields and additive response fields; two existing response shapes gain a field. Everything below is
additive: a caller that sends nothing new sees exactly today's behaviour (FR-005).

## Shared request schemas

Defined once in `src/lib/validation/api.ts` (see data-model.md § Validation rules).

```text
externalId  string   trimmed, 1–200 characters            optional everywhere
sourceKey   string   trimmed, 1–64 chars, ^[a-z0-9][a-z0-9._:-]*$   optional; default "default"
```

`sourceKey` without an `externalId` is a `400 validation_failed` naming `sourceKey`.

## 1. `POST /api/v1/generate` (`generatePost`, permission `generate`)

### Request (additions)

| Field | Type | Notes |
|---|---|---|
| `externalId` | string? | The id of the record in the caller's own system (FR-001). |
| `sourceKey` | string? | Which source system the id belongs to (FR-003). Defaults to `"default"`. |

```http
POST {{base}}/api/v1/generate
Authorization: Bearer {{key}}
Content-Type: application/json
Idempotency-Key: 7f1c…

{
  "brief": "Announce the new opening hours",
  "accountIds": ["…"],
  "externalId": "glen-42",
  "sourceKey": "weird-glens"
}
```

### Response (addition)

`GeneratedSchema` (both the `201` and the `200`) gains:

| Field | Type | Notes |
|---|---|---|
| `alreadyPosted` | boolean | `true` when the answer is a post that existed before this request — a ledger hit (FR-013) or a request-id replay. `false` for a post this request generated. |

### Status matrix

| Situation | Status | Body |
|---|---|---|
| Untagged request, generated | `201` | post, `alreadyPosted: false` — unchanged from today |
| Tagged, id unclaimed, generated | `201` | post, `alreadyPosted: false`, and the post reports its `source` |
| Tagged, id already claimed, post live | `200` | the existing post, `alreadyPosted: true`, `queued: []`, no model call (FR-013, FR-014) |
| Tagged, id already claimed, post deleted | `409 conflict` | `details.reason: "already_posted_post_deleted"`; message names the id (FR-010, D5) |
| Two tagged requests race, loser | `200` | the winner's post, `alreadyPosted: true` (FR-015) |
| `externalId` blank / too long | `400 validation_failed` | `details: [{ path: "externalId", … }]` (FR-004) |
| `sourceKey` malformed, or sent alone | `400 validation_failed` | `details` names `sourceKey` |
| Same `Idempotency-Key`, same body | `200` + `Idempotent-Replayed: true` | the stored answer — unchanged (F16) |

A generation that fails (unusable output, no model, cancelled run) claims nothing: the same request may
be sent again and will be generated (FR-009).

## 2. `POST /api/v1/jobs` (`createJob`, permission `manage_jobs`)

### Request (additions, `source.kind: "api"` only)

| Field | Type | Notes |
|---|---|---|
| `source.sourceKey` | string? | Declared once for the whole job and inherited by appended items (FR-003, D12). Defaults to `"default"`. |
| `source.items[].externalId` | string? | The item's source record id (FR-002). |

### Response (addition)

The `201` body becomes `CreatedJob` = `Job` plus:

| Field | Type | Notes |
|---|---|---|
| `skippedAlreadyPosted` | integer | How many submitted items were dropped because their id was already in the ledger, including later duplicates of an id within this call (FR-016, FR-017). |

`Job` itself is unchanged apart from `counts` (below), so `GET /jobs/{id}` is untouched.

### Status matrix

| Situation | Status | Body |
|---|---|---|
| 10 untagged or unclaimed items | `201` | the job, `skippedAlreadyPosted: 0`, `itemCount: 10` |
| 15 items, 10 already posted, `open: false` | `201` | the job, `skippedAlreadyPosted: 10`, `itemCount: 5` |
| Every item already posted, `open: false` | `400 validation_failed` | `details: [{ code: "already_posted", field: "source.items", message: "All 10 items were already posted." }]` (FR-020) |
| Every item already posted, `open: true` | `201` | the job, `skippedAlreadyPosted: 10`, `itemCount: 0`, `open: true` (spec edge case) |
| One item's `externalId` invalid | `400 validation_failed` | names `source.items.<i>.externalId`; **no** job is created (FR-019) |
| A skipped item named an image | `201` | the image is not reserved and stays available to another job (FR-018) |

## 3. `POST /api/v1/jobs/{jobId}/items` (`addJobItems`, permission `manage_jobs`)

### Request (addition)

| Field | Type | Notes |
|---|---|---|
| `items[].externalId` | string? | As above. The namespace comes from the job (FR-003). |

### Response (addition)

| Field | Type | Notes |
|---|---|---|
| `skippedAlreadyPosted` | integer | Dropped for this call (FR-016). |

```json
{ "added": 5, "skippedAlreadyPosted": 10, "itemCount": 15, "items": [{ "id": "…", "position": 10 }, …] }
```

### Status matrix

| Situation | Status | Body |
|---|---|---|
| 15 appended, 10 already posted | `201` | `added: 5`, `skippedAlreadyPosted: 10` (US2 independent test) |
| Every appended id already posted | `201` | `added: 0`, `skippedAlreadyPosted: N`, `items: []`, the job unchanged (FR-016, AS 2.4) |
| 500 already-posted plus 3 new, job at 0 items | `201` | `added: 3` — skipped items do not count against the 500-item maximum (FR-018) |
| Kept items would exceed 500 | `400 job_item_limit` | unchanged message, counted **after** skipping |
| One item's `externalId` invalid | `400 validation_failed` | nothing is appended (FR-019) |
| Job closed or cancelled | `409 job_closed` | unchanged |

## 4. Read shapes

### `Post` (`PostSchema`) — used by `GET /posts`, `GET /posts/{id}`, `POST /generate`, and `post.*` webhooks

| Field | Type | Notes |
|---|---|---|
| `source` | `{ key: string, externalId: string } \| null` | The source record this post came from (FR-023). `null` for every untagged post and every post composed in the app (US3.3, D11). |

```json
"source": { "key": "weird-glens", "externalId": "glen-42" }
```

### `JobItem` (`JobItemSchema`) — `GET /jobs/{id}/items`, `GET /jobs/{id}/items/{itemId}`

| Field | Type | Notes |
|---|---|---|
| `externalId` | `string \| null` | The item's source record id (FR-024). |
| `skipped` | `{ externalId: string, reason: string, postId: string \| null } \| null` | Set only when `status === "skipped"`. `reason` is a plain-language sentence; `postId` is the post that had already been made for that id, or `null` if that post has since been deleted (FR-024). |

`status` may now be `"skipped"`. `error` stays `null` for a skipped item: a skip is not a failure
(FR-025). A skipped item's `post` is `null` — it created none; the post that claimed the id is under
`skipped.postId`.

```json
{
  "id": "…", "position": 3, "label": "Item 4", "status": "skipped", "attempts": 0,
  "externalId": "glen-42", "mediaId": null, "post": null, "error": null,
  "skipped": { "externalId": "glen-42", "reason": "Already posted: glen-42 became a post earlier.", "postId": "…" },
  "finishedAt": "2026-10-10T10:00:00.000Z"
}
```

### `JobCounts` (inside `Job`, `JobSummary` and the `job.finished` webhook)

Gains `skipped: integer` (FR-021, D10). Additive; the five existing counters keep their meaning.

### `GET /jobs/{jobId}/items?status=…`

The `status` filter accepts `skipped` alongside `queued`, `running`, `done`, `failed`, `cancelled`.

## 5. OpenAPI

`GET /api/v1/openapi.json` picks the changes up from the Zod schemas automatically. The implement phase
must also:

- describe `externalId` and `sourceKey` with `.meta({ description, example })` so the generated
  reference explains them (FR-026);
- extend the `generatePost` operation `description` with the already-posted answer and the `409`;
- extend `createJob` and `addJobItems` descriptions with the silent-skip rule and its counter;
- add a `409` response entry to `generatePost` (`"The external id was already posted and that post was
  deleted"`).

## 6. What does not change

- No new API error code (`API_ERROR_CODES` is untouched) and no new status code anywhere (F17).
- No new API-key permission: tagging is part of `generate` and `manage_jobs`.
- `Idempotency-Key` semantics, retention and `Idempotent-Replayed` are untouched (F16).
- Rate limiting, pagination and cursors are untouched.
- No endpoint reports *which* ids were skipped, and none answers "have you posted this id?" (D13).
