# Contracts — HTTP

This entry adds **no route, no route parameter and no public-API operation** (FR-011, FR-021). Both
session routes keep their payload shapes exactly; only which events they count changes.

---

## `GET /api/me/notifications` — the 60-second count poll (N12, R11)

Unchanged: session cookie only, reads no input, `401 { "error": "unauthenticated" }` for an API key or
no cookie, `Cache-Control: private, no-store`, `Vary: Cookie`, never cached.

```json
{ "count": 3, "display": "3", "label": "3 unread problems", "nextChangeAt": "2026-10-12T13:00:00.000Z" }
```

| Field | Change |
|---|---|
| `count` | Counts **eligible** events only (FR-003): a kind or platform the caller has switched off contributes nothing, and a project with no kind on contributes nothing. The 100 cap is unchanged. |
| `display`, `label` | Unchanged, including "99+" and "More than 99 unread problems" (N9). |
| `nextChangeAt` | Now the soonest live snooze **on an eligible event** (Q13). A snooze whose kind or platform has since been switched off is skipped, so the poller is never armed for a change nobody would see. |

No new status code and no new field. A request naming a project or a person still has no effect,
because the route reads nothing.

## `GET /api/me/notifications/recent` — the panel model (R11)

Unchanged in shape; `NotificationPanel` keeps all three `state` values.

| Field | Change |
|---|---|
| `state` | `"ok"` · `"no_projects"` · `"all_muted"`. The wire name `all_muted` is kept deliberately (Q15, FR-011); it now means **no project of yours has any kind on** (FR-012). |
| `items[]` | Eligible events only, newest first, up to 10. Read and snoozed rows are still included/excluded exactly as 056 defined; `isNew`, `actionsAvailable`, `platforms`, `accountName`, `link` and `message` are unchanged. |
| `unread` | As the count route above. |

The panel's footer still links to `/notifications` and to the problems view ("View all"), in both the
`ok` and `all_muted` states (FR-012).

## Pages

| Route | Change |
|---|---|
| `GET /notifications` | Same route, same no-JavaScript target for the bell. Its "Projects" card becomes the per-project grid (FR-015). New, optional query parameters, all confirmations or errors and all ignorable: `changed=<slug>`, `axis=kind\|platform\|project`, `key=<switch>`, `on=0\|1`, plus the existing `notifications=<code>`, `marked`, `busy`, `snoozes`, `read`, `snoozed`, `until`, `rowError`. An unparseable combination renders a generic confirmation, never an error page (Q20). |
| `GET /p/[projectSlug]/settings` | Same route. The "Your notifications" card carries the same per-project control for every member role (FR-016). Existing `notifications=<on\|off\|code>` is replaced by `changed=1&axis=…&key=…&on=…` for confirmations, keeping `notifications=<code>` for failures. |

## Not touched

`/api/v1/*` (the public API), webhooks and their payloads, the activity routes and screens, their
filters and their links — none change (FR-013). There is no API operation to read or write anyone's
preferences, including one's own: API keys belong to projects, not people (FR-021, N41).
