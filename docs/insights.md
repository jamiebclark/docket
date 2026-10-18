# Post and account insights

Docket periodically reads the numbers a connected platform reports for a published post — likes,
reposts, whatever that platform declares — and shows the latest reading on the post's detail page.
This is a **snapshot**, not a live value: it is whatever Docket last managed to read, with the time
it was read stated plainly.

## Supported platforms

| Platform | Post numbers | Account numbers | Permission needed |
|---|---|---|---|
| Bluesky | Yes — likes, reposts, replies, quotes (whichever the response actually contains) | Captured, shown nowhere yet (see "What this deliberately does not do") | None — reuses the account's existing session |
| Instagram | Yes — reactions-by-type, comments, shares, saves, plus the reel/video family where the post type has one (whichever the response actually contains) | Captured (reach, follower count, profile views), shown nowhere yet | `instagram_manage_insights`, opt-in (see "Reconnecting for insights" below) |
| Facebook Pages | Yes — reactions by type and post clicks; the views/impressions family is a named gap (see "Named gaps") | Captured (Page follows), shown nowhere yet | `read_insights`, opt-in |
| Threads | Yes, where research could confirm the metric names; otherwise declared `unavailable` with a reason — see "Named gaps" | Declared `unavailable` for this entry (`account: []`) | `threads_manage_insights`, opt-in |
| TikTok | Yes — likes, comments, shares, views; a post TikTok's own response omits is `unqueryable` rather than guessed (see "Named gaps") | Yes — followers, likes, video count | `video.list` for post numbers, `user.info.stats` for account numbers, both opt-in (see [tiktok-setup.md#insights](tiktok-setup.md#insights)) |
| Pinterest | Yes — impressions, pin clicks, outbound clicks, saves | Yes — followers, monthly views, no flag needed (reuses `user_accounts:read` from connecting) | `pins:read` for pin analytics, opt-in (see [pinterest-setup.md#insights](pinterest-setup.md#insights)); needs a business account, and a Trial app's pins are invisible to anyone but their own creator |
| X | Yes — likes, replies, reposts, quotes, impressions | Not read — the per-user read price is unconfirmed (see "Named gaps") | Reuses `tweet.read`, already requested; metered at $0.001/read and off by default (see [x-setup.md#insights](x-setup.md#insights)) |

A platform with no `insights` module simply never grows these tables and never does any of this
work — there is nothing to turn off, and nothing changes on screen beyond the panel stating plainly
that Docket cannot read numbers from that platform yet.

## Reconnecting for insights

Reading Instagram's, Facebook's or Threads' numbers needs a permission Docket does not request by
default: the deployer opts in with one environment flag per connect group (off by default, so no
existing install's consent screen changes until someone deliberately turns it on). Turning the flag
on changes what the *next* connect or reconnect asks for — it does nothing to an account already
connected.

An account connected before the flag was on, or whose grant did not include the permission, shows a
line on the Accounts page: *"Insights need a reconnect"*, with the reason and a link to
[meta-setup.md](meta-setup.md). Reconnecting through the existing "Reconnect" button updates the same
account in place — it keeps its publish-limit overrides, its posting instructions, its slot
assignments, its engagement state and its insights poll state and snapshots, and no second account
appears. Nothing about the account's ability to publish changes while insights permission is missing;
only the numbers wait.

With `META_LOGIN_CONFIG_ID` set, Docket cannot widen what the dialog asks for on its own — the
permission has to be added to the Meta Login configuration itself, a deployment act. The accounts page
says so plainly, with no reconnect button offered for a loop that cannot succeed.

## Named gaps

- **Facebook's views/impressions family is not declared.** Meta deprecated `post_impressions`,
  `page_impressions` and `page_fans` on 2025-11-15, and which replacement metric answers on Docket's
  running Graph API version could not be confirmed. Facebook ships with reactions-by-type, clicks,
  page engagement and page follows instead; the views family is a parked research question
  (`docs/decisions.md`, 081).
- **Facebook Reel targets cannot be read.** A Reel is stored under its video id, not its post id, and
  Docket cannot yet tell the two apart well enough to ask for a Reel's numbers; such a target freezes
  with reason `unqueryable` rather than erroring forever.
- **No account-metric screen yet.** Every platform's account snapshots (followers and the like) are
  captured on schedule, as in 080, but no screen shows them.
- **Unrecoverable TikTok ids show as unavailable, not guessed.** TikTok's publish response holds the
  real post id (`publicaly_available_post_id`) separately from the `publish_id` Docket used to store
  as the target's external id. A target published before this entry, whose real id cannot be
  recovered from retained publish attempts, has no id to query at all — insights for it stay
  unavailable rather than Docket guessing at a video id that may be wrong.
- **TikTok cannot tell "deleted" apart from "never a valid id".** TikTok's video-query endpoint
  simply omits an id from its response whether the video was deleted or the id was never a video id
  to begin with; both land as the same `unqueryable` outcome, reported with one reason that covers
  both.
- **X's account numbers are not read, and two billing questions are parked.** X's per-user read
  price is not confirmed to match the $0.001 owned-post rate, so Docket does not spend money on an
  unverified assumption. Whether a `public_metrics` read on an owned post bills as one resource, and
  whether a page of user ids cost one resource total or one per id, stay open until X's pricing page
  is clearer — see [x-setup.md#insights](x-setup.md#insights).

## The snapshot-not-current-value rule

The panel never calls out to a platform while a person is looking at the page. It only ever shows
the most recent row the scheduler already wrote, plus when that row was captured. A member who wants
a fresher number waits for the next scheduled read; there is no "refresh now" action.

## The absent-never-zero rule

A key a platform declares but a particular response did not contain renders **nothing at all** — no
row, no dash, no `0`. A `0` is a real, reported value; its absence is a fact Docket does not know, and
the two are never confused. The panel also never shows a delta, a trend, a second number, or more than
one snapshot at a time — see "What this deliberately does not do" below.

## The decay schedule

A newly published post is read every hour for its first day, then daily through its first week, then
weekly through its first four weeks, and then never again — the target **freezes** once it reaches 28
days old, on the assumption that engagement has settled. A post the platform reports as gone is
frozen immediately, with its last known numbers kept. A post published by hand (no connected account
tracked it) is never polled — there is no post to ask the platform about.

Account numbers (followers and the like) never decay this way: an account's followers keep changing
for as long as the account is connected, so it is read on its own fixed interval for the account's
whole life.

A platform may declare a post type that expires — an Instagram Story is gone from the platform 24
hours after it is published. Such a target is polled on the same dense first-band cadence as any new
post, but never scheduled past its declared lifetime: it freezes at that boundary with reason
`expired`, and the panel renders "this story has expired; these numbers are final" beside whatever
snapshots were captured while it lived. A Story already past its 24-hour window when this entry's
poller first sees it is frozen immediately, with no call spent reading something that is already
gone.

Reading insights never competes with publishing for an account's platform allowance: half of every
account's read budget is reserved for insights, and polling backs off — never fails — when that
reserve is exhausted, leaving the other half free for a scheduled publish in the same tick.

## Retention

Snapshots older than the configured retention window (`INSIGHTS_RETENTION_DAYS`, default 400 days)
are pruned in small batches on the regular housekeeping pass. Pruning only ever touches the snapshot
tables — the poll-state row that decides when a target or account is next due survives its
snapshots being pruned, and a frozen target stays frozen.

## What this deliberately does not do

- **No chart, trend, delta or comparison of any kind.** The panel shows the one latest reading and
  nothing else; anything derived from more than one snapshot is out of scope for this entry.
- **No manual refresh.** Numbers appear on the schedule above, never on demand.
- **No per-project on/off switch.** A project sees a platform's numbers exactly when that platform's
  provider declares support for them, with no setting to change that.
- **Account snapshots are captured but shown nowhere.** Docket reads and stores an account's own
  numbers (followers, and whatever else a platform declares) on the same schedule as post numbers,
  but no screen displays them yet — that capture exists so a later entry covering account trends
  does not have to wait for history to accumulate. This is a known, deliberate gap, not an oversight.
