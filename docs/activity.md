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
