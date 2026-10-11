# Contract: session endpoints for the bell

The two internal GET route handlers from 022 (`contracts/http.md` there) keep every rule they have; this
entry adds one field to each payload. They are still **not** part of the public API: not under `/api/v1`, not
in the OpenAPI document, and API keys are not accepted (R11, FR-021, FR-023).

## Unchanged rules (both routes)

- **Auth**: the Better Auth session cookie through `getSession()`. No session, expired or revoked ⇒ **401**.
  An `Authorization: Bearer <api key>` header is ignored, so a key-only request gets 401 (US7-AS4).
- **Input**: none. The query string and the body are never read, so a parameter naming another user, project
  or event has no effect.
- **Scope**: `forMyProjects(session)`, resolved on this request, never cached. Statements re-check membership
  and the mute themselves.
- **Headers on every response**: `Cache-Control: private, no-store`, `Vary: Cookie`,
  `Content-Type: application/json`.
- **Proxy**: `/api/me/` is in `PUBLIC_PREFIXES`, so a cookie-less call gets 401 rather than a login redirect.
- **Errors**: `500 { "error": "unavailable" }` with the same headers and no detail; the browser keeps its last
  value.
- `export const dynamic = "force-dynamic"`; the handlers call services only.

## `GET /api/me/notifications` — the refresh (FR-021)

**200**

```json
{ "count": 3, "display": "3", "label": "3 unread problems", "nextChangeAt": "2026-10-12T13:00:00.000Z" }
```

| Field | Type | Meaning |
|---|---|---|
| `count` | integer 0–100 | Attention events above the floor, in the caller's notifications-on projects, with no mark whose instant is still in the future. Capped at 100. Same function the header bell uses. |
| `display` | string | `""`, `"1"` … `"99"`, or `"99+"`. Unchanged (N9). |
| `label` | string | "No unread problems", "1 unread problem", "N unread problems", "More than 99 unread problems". Unchanged. |
| `nextChangeAt` | string \| null | **New.** ISO 8601 UTC with whole milliseconds: the soonest instant at which one of the caller's snoozes runs out, over notifications-on projects. `null` when there is none (N22, M17). |

- A caller with no live snooze gets `"nextChangeAt": null`, and the browser behaves exactly as it does today
  (US5-AS6).
- A caller whose soonest snooze runs out in two minutes gets that instant, and the bell refreshes then rather
  than up to 60 seconds later (US5-AS5, FR-022).
- A caller in no projects gets
  `{ "count": 0, "display": "", "label": "No unread problems", "nextChangeAt": null }`.
- A snooze in a muted project is never reported: a muted project contributes nothing to count, so there is
  no moment worth waking for (US5-AS4).
- No event id, no `seq`, no other person's instant and no message text is in this payload.

**401**

```json
{ "error": "unauthenticated" }
```

## `GET /api/me/notifications/recent` — the panel (FR-023)

**200**: a `NotificationPanel` ([data-model §6](../data-model.md#6-shapes-the-browser-sees)):

```json
{
  "state": "ok",
  "unread": { "count": 2, "display": "2", "label": "2 unread problems", "nextChangeAt": null },
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
      "actionsAvailable": true,
      "link": { "href": "/p/acme/failures?target=…#target-…", "label": "Open in Failures" }
    }
  ]
}
```

Changes from 022:

| Field | Change |
|---|---|
| `items` | **Currently snoozed events are excluded** (FR-010, N20), in SQL, so the list is still up to 10 rows after the exclusion (FR-018, M16). Individually-read events stay in the list. |
| `items[].isNew` | Now also false for an individually-read event; true again once a snooze has run out (FR-011, N20). |
| `items[].actionsAvailable` | **New.** `false` for every row of a project that has reached 200 marks for this person, so the row can say the per-row actions are unavailable and offer "Mark all as read" (FR-020, FR-023, US4-AS3). It is per project, so another project's rows stay `true` (US4-AS5). |
| `unread` | Gains `nextChangeAt`, the same value and meaning as the count route (M17). |

Unchanged: `state` (`"no_projects"`, `"all_muted"`, otherwise `"ok"`; `items` is `[]` unless `"ok"`), the
newest-first ordering, notifications-on projects only, and "no secrets" — messages are the stored, scrubbed
text, with no `details`, actor ids, API key names or post text.

**401**: as above.

## Not provided

- **No POST, PUT or DELETE on these routes.** The row actions are server actions
  ([ui.md](./ui.md) §2), and `src/proxy.ts`'s same-origin check refuses a forged POST before anything is
  written (FR-024, US7-AS5).
- **No public-API operation.** `/api/v1` and the OpenAPI document are untouched; an API key is refused
  everywhere in this feature, including the row actions (FR-025, US7-AS4). Webhooks remain the way to deliver
  problems outside Docket.
- **No route that lists, exposes or cancels snoozes.** Un-snoozing and a snoozed view are out of scope;
  "Mark read" and "Mark all as read" are the ways out.
