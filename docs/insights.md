# Post and account insights

Docket periodically reads the numbers a connected platform reports for a published post — likes,
reposts, whatever that platform declares — and shows the latest reading on the post's detail page.
This is a **snapshot**, not a live value: it is whatever Docket last managed to read, with the time
it was read stated plainly.

## Supported platforms

| Platform | Post numbers | Account numbers |
|---|---|---|
| Bluesky | Yes — likes, reposts, replies, quotes (whichever the response actually contains) | Captured, shown nowhere yet (see "What this does not do") |
| Facebook Pages, Instagram, Threads, TikTok, Pinterest, X | Not yet | Not yet |

A platform with no `insights` module simply never grows these tables and never does any of this
work — there is nothing to turn off, and nothing changes on screen beyond the panel stating plainly
that Docket cannot read numbers from that platform yet.

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
