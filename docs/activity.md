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
- **Unread** means newer than where you last looked in that project, not "still broken": a problem stays unread after it is fixed until it is marked read or snoozed. Each person has one **floor** per project, and it only moves forward.
- **Row actions.** Every row in the bell's panel and on `/notifications` offers two controls:
  - **Mark read** dismisses that one problem only — it does not touch any other problem and does not move the floor past anything still unread or snoozed.
  - **Snooze** hides that one problem until "1 hour", "Tomorrow morning" (9 AM) or "Next week" (9 AM next Monday), in your project's time zone. It leaves the count, the panel, `/notifications` and the project callout at once, but it never leaves Activity — the event is still there, for everyone, including whoever snoozed it. When the time passes it comes back unread and marked "New", with no page to open and no job to run.

  Both controls work with or without JavaScript, and announce what happened out loud.
- **A snooze is on the event, not on whatever it was about.** If the underlying problem gets fixed — a retry succeeds, a post goes out, a reauth is resolved — while it is snoozed, the snooze still runs out on schedule and the event still comes back unread. Docket does not cancel a snooze just because the thing it was about is no longer broken; it assumes you asked to be reminded and reminds you. The row links wherever Activity would link it, so a fixed target shows as the post rather than as a Failures entry.
- **The floor still wins.** *Mark all as read* and the two *Problems*-preset Activity views (below) raise your floor over everything that exists at that moment — including anything currently snoozed. A snoozed problem at or below the new floor is read and does not come back; if any snoozes were cleared this way, the confirmation says so.
- **Marking read.** Four things move the floor or dismiss a row: the two row actions above (one event each), *Mark all as read* (every project you belong to, muted or not), the project's Activity with the *Problems* preset and no other filter (first page), and All activity with the same preset (the projects it covers). Opening the bell, other filters and paging mark nothing.
- **A limit on how many problems you can leave half-read.** You can have at most 200 individually-marked-or-snoozed problems per project at once — twice the unread cap. If you hit it, row actions for that project pause and point you at *Mark all as read*, which clears the whole project in one step. Working through problems oldest-first never comes close to the limit; it only bites if you deliberately leave the oldest ones unread while clearing everything newer.
- **Preferences, per kind and per platform.** On your **Notifications** page (`/notifications`, in the user menu and the bell panel) or on a project's settings page, you choose which of the four attention kinds and which platforms may notify you, per project. Both axes gate independently — an event needs its kind on *and*, if it records a platform, at least one of those platforms on. Switching any of them off hides; the events stay in Activity for everyone. "Notifications for this project are off" just means no kind is currently on — there is no separate project-level flag to drift from the switches.
- **One-click project control.** Every project still keeps a single "Turn all off" (the old mute, unchanged in effect) and a "Turn all on" beside it, next to the per-kind and per-platform switches rather than hidden behind them.
- **Fresh start, every time.** Turning any switch back on — a kind, a platform, or "Turn all on" — starts counting from that moment: only events after it may notify you through that switch. Events from while it was off never show up later as unread; they stay in Activity, for everyone, exactly as before.
- **Starting points.** A new member starts at the moment they joined, so an invited person sees no old problems. A rejoin starts again. The first deploy marked everything before it as read.
- **Refresh.** The count updates every 60 seconds while the tab is visible, once when it becomes visible again, and once more exactly when your soonest snooze is due to come back. It is quiet: screen readers hear a mark, a snooze or a rising count, never a falling one from the background refresh alone. Without JavaScript the bell is a link to `/notifications`.
- **Inside Docket, and by email when a mail server is configured.** For chat or phone, send the webhooks to a tool such as n8n (see [n8n.md](n8n.md)).
- **Callout.** A project's home and Posts show "Problems since you last looked" with a link to Activity with Problems.
- **API.** `GET /api/me/notifications` (count) and `/api/me/notifications/recent` (up to 10 items) serve the signed-in session only; they never carry event details, tokens or post text.

### Email

When a mail server is configured ([deployment.md](./deployment.md)), the Email card on your **Notifications**
page lets you choose how problems reach your inbox. It is a separate choice from the bell above: email is
off for everyone by default, including people who already have every in-app notification on, and turning
it on never changes what the bell shows. What may be emailed is the same per-kind, per-platform rule as the
bell — there is no second, email-only notion of what you care about.

- **Cadence.** Off, immediate, or a daily digest at an hour you choose. Immediate sends on the next tick
  after an eligible problem appears, coalescing everything into one message rather than one email per
  event. A digest sends at most once per local day, late if the worker was briefly down, and skipped
  (rather than sent stale) if it was down for days — its problems simply appear in the next one.
- **Time zone.** Stored with your email settings, since a digest hour and quiet hours are both wall-clock
  rules. Until you choose one, Docket uses the zone your projects agree on, UTC otherwise, and always says
  so in words next to the hour.
- **Quiet hours.** An optional window, which may wrap midnight, during which immediate mail is held and
  sent as one message at the window's end rather than dropped or sent as a burst. A chosen digest hour is
  exempt, since picking an hour is already telling Docket when you want it.
- **Pausing.** Repeated delivery failure, or one hard rejection from your mail server, pauses your email
  with a plain-words reason on the settings page and a button to resume it. A pause never touches your
  in-app notifications, and you see only your own delivery outcome, never anyone else's.
- **Unsubscribe.** Every problem email carries a link that works without signing in and names nobody in
  its address. It opens a page — it does not act just by being fetched — offering to turn off every
  problem email, turn off just that project's, switch to a digest, or turn back on; a mail client's own
  one-click unsubscribe button acts immediately. The link keeps working for 60 days after it was sent.

Invitations are a separate, one-time email, unaffected by any of the above: see [accounts.md](./accounts.md).
