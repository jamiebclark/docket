# Activity

The **Activity** page is a history of what happened to publishing: which posts went out, which failed, which need your decision, and which accounts need reconnecting. It is a record, not a work queue. To act on a failure, use [Failures and retrying](failures.md).

## Where to find it

- **Per project.** *Activity* in the left navigation, after Failures. Every member of the project can read it (it needs the same access as viewing posts).
- **All projects.** *All activity* in the user menu, at `/activity`. It lists events from every project you belong to, and each row names its project. Filter by project to narrow it.

## What is recorded

One event is written each time a target or an account changes state:

| Outcome | Meaning | Counted as |
|---|---|---|
| Published | The post went out. | Success |
| Failed | The post failed, including "Gave up after N attempts". | Problem |
| Needs your decision (`ambiguous`) | Docket cannot tell whether it was published. | Problem |
| Retrying | A failed step will be tried again. | Neither |
| Resolved | A person retried or resolved a target. | Neither |
| Needs reconnecting (`needs_reauth`) | An account's credentials stopped working. | Problem |
| Connect failed | An attempt to connect or reconnect an account was refused. The message is the text the person saw. | Problem |

Nothing is written when nothing changed, for example a retry that found no free slot. The first time the feature runs, existing published, failed and ambiguous targets and accounts that need reconnecting are added once, at their real times.

History outlives what it describes. Deleting a post or removing an account keeps its events (labelled "Post deleted" or "Removed account"). Only deleting the project removes them.

## What is not recorded

- **No publish content.** An event keeps at most a short excerpt of the post's text, never the full text or media. The post itself is the source for content.
- **No secrets.** Messages are scrubbed of tokens, passwords and other credentials before they are stored, and the stored details are limited to a small set of fields (counts, times, a link to the published post).
- **No engagement metrics.** Likes, reach and the like are not part of Activity.

## Retention

Docket keeps every event until its project is deleted; there is no automatic expiry and nothing edits or removes an event. An event takes about 0.5 KB, so 100,000 events is roughly 50 MB. The date filters are index-backed, so they stay fast as the table grows.

## Filtering

Every filter is a URL parameter, so a view can be bookmarked or shared.

- **Outcome**: any combination of the seven outcomes, or the *Successes* and *Problems* presets.
- **Platform** and **Account** (the account filter is per project).
- **Dates**: *Today*, *7 days*, *30 days*, or a From and To day. Days are in the project's time zone. In All activity each project uses its own zone.
- **Project** (All activity only).

The summary above the list ("Last 7 days: 2 successes · 2 problems") ignores the outcome filter, and says so when one is set. Each count links to the matching preset.

Paging uses **Newer** and **Older** links. New events arriving while you read never repeat or skip a row.

## Rows and links

Each row shows the time, outcome, platform and account, the post, what happened, who did it (a member, an API key or the scheduler) and, in All activity, the project. A row links to **Open in Failures** while its target still needs a person, **Open post** once it has moved on, or **Open accounts** for account events.

## API

`GET /api/v1/activity` returns the same events newest first, with the same filters (`outcome`, `platform`, `account`, `from`, `to`, `range`) and an opaque `cursor`. A key needs the `read` permission. See the OpenAPI document at `/api/v1/openapi.json`, and the [n8n recipe](n8n.md#8-read-activity).

## Notifications

Docket tells you about problems without you opening Activity. A **bell** in the header shows how many problems are unread; it is always there and the count hides at zero ("99+" above 99).

- **What counts.** Failed, ambiguous and needs-reauth events from your projects. A connect attempt that failed counts only for the person who made it. Webhooks for the same events are described in [n8n](n8n.md); notifications are the in-app view.
- **Unread** means newer than where you last looked in that project, not "still broken": a problem stays unread after it is fixed until it is marked read. Each person has one position per project, and it only moves forward.
- **Marking read.** Exactly three things do it: *Mark all as read* (every project you belong to, muted or not), the project's Activity with the *Problems* preset and no other filter (first page), and All activity with the same preset (the projects it covers). Opening the bell, other filters and paging mark nothing.
- **Muting.** Turn a project's notifications off on your **Notifications** page (`/notifications`, in the user menu and the bell panel) or on the project's settings page. Muting hides; the events stay in Activity. Turning notifications back on starts fresh: the project is marked read at that moment.
- **Starting points.** A new member starts at the moment they joined, so an invited person sees no old problems. A rejoin starts again. The first deploy marked everything before it as read.
- **Refresh.** The count updates every 60 seconds while the tab is visible, and once when it becomes visible again. It is quiet: screen readers hear it only when the count rises. Without JavaScript the bell is a link to `/notifications`.
- **Only inside Docket.** Docket only notifies you inside Docket; to get problems by email, chat or phone, send its webhooks to a tool such as n8n (see [n8n.md](n8n.md)).
- **Callout.** A project's home and Posts show "Problems since you last looked" with a link to Activity with Problems.
- **API.** `GET /api/me/notifications` (count) and `/api/me/notifications/recent` (up to 10 items) serve the signed-in session only; they never carry event details, tokens or post text.
