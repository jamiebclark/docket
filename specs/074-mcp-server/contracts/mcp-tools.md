# Contract: the MCP tool surface

**Feature**: `074-mcp-server`. Derived from `src/server/api/operations/` — this file
documents the derivation and the frozen names, not a second source of truth.

## Endpoint

One endpoint: `POST /api/mcp` on the Docket origin. `GET` and `DELETE` answer 405.
Credential: an existing project-scoped API key, as `Authorization: Bearer dkt_…` or
`X-API-Key: dkt_…`, on **every** request including `tools/list`. No cookie is read.

## Name derivation (frozen)

`docket_` + the operation id converted from camelCase to snake_case. The nineteen published
names are listed in `src/server/mcp/naming.ts` and asserted by test; see
[data-model.md §2](../data-model.md) for the table.

## Per-tool argument contract

For each exposed operation, the tool accepts exactly:

- every field of `op.params` (required),
- every field of `op.query`,
- every top-level field of `op.body.schema` (JSON bodies only),
- `confirm: true` where the disposition demands it,
- `idempotencyKey: string` where `op.idempotent` is true.

Any other argument: `validation_failed`, naming the field. Types, bounds, enums, defaults
and nested shapes are the operation's own Zod schemas, rendered to JSON Schema with
`io: "input"` and inlined (no `$ref`, no `$defs`).

### Worked examples

`docket_get_post`

```json
{ "postId": "9a2b4c6d-8e0f-4a1b-b3c5-d7e9f1a3b5c7" }
```
→ `GET /api/v1/posts/{postId}`

`docket_queue_post`

```json
{ "postId": "9a2b…", "confirm": true, "idempotencyKey": "queue-row-42" }
```
→ `POST /api/v1/posts/{postId}/queue` with `Idempotency-Key: queue-row-42` and body
`{}` (`targetIds` omitted). Without `confirm`, or with `"true"`, `1` or `false`: refused,
nothing sent.

`docket_add_week_slots`

```json
{ "accountId": "7c1e…", "localTime": "09:00", "idempotencyKey": "week-shop-ig" }
```
→ `POST /api/v1/slots/week`

`docket_list_media`

```json
{ "limit": 25, "unused": true }
```
→ `GET /api/v1/media?limit=25&unused=true`

## Tool results

**Success**: the HTTP status and the JSON body the same request would have returned,
serialised as the result's text content (and as `structuredContent` where the SDK carries
it). `Idempotent-Replayed: true` is reported alongside when the pipeline sets it.

**Failure**: `isError: true` with the API's error body unchanged —

```json
{ "error": { "code": "missing_permission", "message": "This key needs the generate permission.",
             "details": { "permission": "generate" }, "requestId": "…" } }
```

— plus the seconds to wait when the code is `rate_limited`. The codes are
`API_ERROR_CODES` from `src/server/api/errors.ts`; no code is added by this entry.
`invalid_api_key` on `initialize` or `tools/list` is a JSON-RPC error instead, because no
tool ran.

## Confirmations

| Tool | Effect confirmed | Demanded |
|---|---|---|
| `docket_queue_post` | the post goes into its accounts' next free slots and will publish | always |
| `docket_schedule_post` | the post publishes to live accounts at the time given | always |
| `docket_delete_slot` | the schedule row is destroyed, with no undo | always |
| `docket_create_project` | a globally unique slug is permanently consumed and no API call can remove the project | always |
| `docket_generate_post` | the generated post is queued to live accounts | unless `schedulingPolicy` is explicitly `leave_as_draft` (an absent policy may queue, via the project default) |

The argument is `confirm`, and only the JSON literal `true` proceeds. The refusal is
`confirmation_required`, names the effect in plain words, names `confirm`, and happens
before anything is sent to the API pipeline.

## Equivalence guarantee

For every exposed tool and every valid argument set, the tool call and the equivalent HTTP
request made with the same key produce the same status and the same body, because the tool
call *is* that HTTP request (`handleApiRequest`, see [research D6](../research.md)). The
equivalence test asserts it per tool from the shared fixture table.

## What is not here

No tool takes a project id or slug. No tool switches project. No tool exists for the
fifteen withheld operations ([data-model.md §2](../data-model.md)). There is no
list-posts tool, because the v1 API has no such operation (FR-027).
