# Contract: `GET /api/v1/activity` (`listActivity`)

The operation is defined in `src/server/api/operations/activity.ts` and registered in `operations/index.ts`. It has these properties:

- tag: `Activity`;
- permission: `read`. This is the existing key permission, and it grants `post: ["view"]` (D5);
- idempotent: `false`;
- `resourceParams`: none.

It calls exactly one service, `listActivityForApi`.

## Request

`GET /api/v1/activity?outcome=problems&platform=instagram&account=<uuid>&from=2026-10-01&to=2026-10-07&limit=50&cursor=<opaque>`

| Param | Type | Rules |
|---|---|---|
| `outcome` | string, repeatable, comma-separated | Each value is one of `published`, `failed`, `ambiguous`, `retrying`, `resolved`, `needs_reauth`, `connect_failed`, or a preset (`successes`, `problems`). Values combine by union. Unknown → 400. |
| `platform` | string | A registered provider key (`facebook`, `instagram`, `threads`, `bluesky`, `x`, and `mock` when enabled). Unknown → 400. Matches events whose `platforms` include it, so group connect failures match each of their platforms. |
| `account` | uuid | Malformed → 400. Another project's account, or an unknown one, matches nothing (200 with empty `data`). |
| `from`, `to` | `YYYY-MM-DD` | Calendar days in the **project time zone**, both inclusive, so DST days are 23 or 25 hours long. `from > to` → 400 on `from`. |
| `range` | `today` \| `7d` \| `30d` | Overrides `from`/`to`. "Today" is from local midnight. `7d`/`30d` include today. |
| `limit` | int 1–100 | Default 50 (`pageQuerySchema`). |
| `cursor` | opaque base64url | From a previous `nextCursor`. Malformed, or built for another project → 400 `The cursor is not valid.` |

The query schema is a `z.strictObject`, so an unknown parameter → 400 with per-field `details`, matching the other list operations.

## 200 response

```json
{
  "data": [
    {
      "id": "6f1c…",
      "kind": "target_failed",
      "outcome": "failed",
      "occurredAt": "2026-10-06T13:02:11.512Z",
      "occurredAtLocal": "2026-10-06T09:02:11.512-04:00[America/New_York]",
      "platform": "instagram",
      "platforms": ["instagram"],
      "account": { "id": "1d0e…", "name": "Shop IG", "removed": false },
      "post": { "id": "9a2b…", "targetId": "c3d4…", "excerpt": "New autumn range is in…", "deleted": false },
      "message": "Gave up after 5 attempts: The media could not be fetched.",
      "actor": { "type": "scheduler", "name": "Scheduler" },
      "details": { "attempt": 5, "gaveUp": true }
    }
  ],
  "nextCursor": "eyJ2IjoyLCJ0Ijoi…"
}
```

- Events come newest first, by `occurredAt` and then a stable tie-breaker. `nextCursor` is `null` on the last page.
- **The cursor is stable under new events** (D6). It encodes the last row's position, not an offset. Events committed after the walk began may be absent from it. To catch up, poll again from your last `occurredAt` with `from=` and drop ids you have already seen ([research P5](../research.md)).
- `actor.type` is `scheduler`, `member` or `api_key`. `actor.name` is "Scheduler", the member's name, "Former member", "API key {name}" or "Removed API key".
- `account` is `null` for connect failures that were not reconnecting an account. `post` is `null` for account events.
- `details` uses the per-kind shapes in [data-model §3](../data-model.md). Only documented keys appear.
- There are no secrets and no post content beyond `excerpt` (140 graphemes). The secret-scan test covers this response.

## Errors (existing shapes)

| Status | Code | When |
|---|---|---|
| 400 | `validation_failed` | Bad `outcome`/`platform`/`account`/`from`/`to`/`range`/`limit`, an unknown parameter, `from > to`, or a bad cursor. `details` lists each field. |
| 401 | `invalid_api_key` | Missing, malformed, unknown, revoked or expired key. |
| 403 | `missing_permission` | The key lacks `read`. |
| 429 | `rate_limited` (existing) | As for every operation. |

## OpenAPI

- The response schema is `ApiActivityEventSchema` / `ApiActivityPageSchema` in `src/lib/api/schemas.ts`, with `kind` and `outcome` as enums from `src/lib/activity/outcomes.ts`.
- The query parameters carry descriptions, including the time-zone rule.
- The response examples are:
  - **200**: `problems`, a page with failed, ambiguous and needs-reauth events, and `published`;
  - **400**: a bad `outcome` value, and `from` after `to`;
  - **401**;
  - **403**.
- `tests/integration/api/openapi.test.ts` asserts the operation and its examples.
