# Contract: session endpoints for the bell

These are two internal GET route handlers for the signed-in browser. They are **not** part of the public API: they are not in `/api/v1`, not in the OpenAPI document, and API keys are not accepted (R11). Both are `export const dynamic = "force-dynamic"` and call services only.

## Common rules (both routes)

- **Auth**: the Better Auth session cookie, read through `getSession()`. No session, or an expired or revoked one, gets **401**. An `Authorization: Bearer <api key>` header is ignored, so a request carrying only a key gets 401.
- **Input**: none. The query string and body are never read, so a parameter naming another user or project has no effect (FR-015, US7-AS3).
- **Scope**: the caller's memberships, resolved on this request through `forMyProjects(session)`. The statements re-check membership and mute themselves (R5).
- **Headers on every response, 200 and 401**: `Cache-Control: private, no-store`, `Vary: Cookie`, `Content-Type: application/json`.
- **Proxy**: `/api/me/` is in `PUBLIC_PREFIXES` (`src/lib/auth-gate.ts`), so a cookie-less call reaches the route and gets 401 rather than a redirect to `/login`. Both routes are GET, so the same-origin rule does not apply to them; nothing changes state.
- **Errors**: an unexpected failure gets `500 { "error": "unavailable" }`, with the same headers and no detail. The browser keeps its last value (FR-016).

## `GET /api/me/notifications`: the refresh (FR-015)

**200**

```json
{ "count": 3, "display": "3", "label": "3 unread problems" }
```

| Field | Type | Meaning |
|---|---|---|
| `count` | integer 0–100 | Unread attention events, capped at 100 (R5). This is the same function the header uses, `unreadSummary`. |
| `display` | string | `""`, `"1"` to `"99"`, or `"99+"`. |
| `label` | string | "No unread problems", "1 unread problem", "N unread problems" or "More than 99 unread problems". |

A user in no projects gets `{ "count": 0, "display": "", "label": "No unread problems" }`.

**401**

```json
{ "error": "unauthenticated" }
```

## `GET /api/me/notifications/recent`: the panel (FR-011, FR-012)

**200**: a `NotificationPanel` ([data-model §4](../data-model.md#panel-item-fr-011)):

```json
{
  "state": "ok",
  "unread": { "count": 2, "display": "2", "label": "2 unread problems" },
  "items": [
    {
      "id": "6d1c…",
      "outcome": "failed",
      "outcomeLabel": "Failed",
      "occurredAt": "2026-10-08T14:03:21.512Z",
      "project": { "slug": "acme", "name": "Acme", "timeZone": "America/New_York" },
      "platforms": [{ "key": "bluesky", "name": "Bluesky" }],
      "accountName": "@acme.bsky.social",
      "postDeleted": false,
      "message": "The post is longer than Bluesky allows.",
      "isNew": true,
      "link": { "href": "/p/acme/failures?target=…#target-…", "label": "Open in Failures" }
    }
  ]
}
```

- **`state`**:
  - `"no_projects"`: the caller belongs to none;
  - `"all_muted"`: every membership is muted;
  - otherwise `"ok"`.

  `items` is `[]` unless the state is `"ok"`.
- **`items`**: up to 10, newest first, from unmuted projects only, read and unread alike.
- **No secrets**: messages are the stored, scrubbed text (020 P9). No `details`, actor ids, API key names or post text are included.

**401**: as above.

## Not provided

- No POST, PUT or DELETE. Marking read and muting are server actions ([ui.md](./ui.md) §5), refused cross-site by the proxy.
- No public-API operation (`/api/v1`). Webhooks are unchanged, and they remain the way to deliver problems outside Docket (`docs/n8n.md`).
