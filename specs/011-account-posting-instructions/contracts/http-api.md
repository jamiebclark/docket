# Contract: public API changes

There are no new endpoints and no request-shape changes (FR-021, FR-022). The OpenAPI document keeps being generated from the operation table (`src/server/api/operations/*`, 009 D14).

## `GET /api/v1/accounts` (permission `read`)

`AccountSchema` (`src/lib/api/schemas.ts`, component id `Account`) gains one property:

```ts
postingInstructions: z.string().nullable().meta({
  description: "The account's posting instructions: owner-written rules for how posts for this account are written. Null when it has none. Read-only over the API.",
}),
```

Example item:

```json
{
  "id": "6f1c…",
  "provider": "bluesky",
  "displayName": "Acme Science",
  "status": "active",
  "lastError": null,
  "postingInstructions": "Put two or three hashtags at the very end, never inline.",
  "capabilities": { "textLimit": 300, "countingRule": "graphemes", "media": { "required": false, "maxImages": 4, "mimeTypes": ["image/jpeg", "image/png"] }, "postTypes": ["text", "image"] }
}
```

`account.*` webhook event bodies use the same shape (`toApiAccount`), so they include the field too.

## `POST /api/v1/generate` and `POST /api/v1/jobs`

The request shape is unchanged. The grouping, the group limit and the snapshots come from the shared services.

When the limit is exceeded, the response is **400**:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "These accounts need 17 different versions of the post; one generation can write at most 16. Choose fewer accounts, or give accounts on the same platform the same posting instructions.",
    "details": [{ "code": "too_many_groups", "field": "targetAccountIds", "message": "…same text…" }],
    "requestId": "…"
  }
}
```

The exact envelope follows `apiError("validation_failed", e.message, e.issues)` in `src/server/api/errors.ts`.

- **What is created**: no post, failure record or job, and no model call is made.
- **Idempotency**: the 400 is stored against the idempotency key like any 4xx after the claim (009 decision 7), so a retry with the same key replays it.

`problems[].message` in a 201/200 `/generate` response names the group: `bluesky: …` when the platform had one group, `bluesky_2 (Bluesky: Acme News): …` otherwise.

## OpenAPI validity

`tests/integration/api/openapi.test.ts` already validates the document. It adds an assertion that `components.schemas.Account.properties.postingInstructions` exists, has type `string`/`null` and appears in `required`.
