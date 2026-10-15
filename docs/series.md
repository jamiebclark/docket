# Standing series

A standing series keeps producing posts on a cadence, or on a list of calendar dates, until someone
pauses or deletes it, instead of being created once — the piece that makes generation continuous
rather than something a person starts each time. It is a different object from an in-request series,
which asks for 2–10 angles while you wait: a standing series is configuration — a voice profile, a
template, target accounts, a media source and a cadence — that fires on its own, in the background,
under **Batch jobs → Standing series**. Creating, editing, pausing, resuming and deleting a series
needs owner or admin; everyone who can view posts can see the list and each series' run history.

For the generator itself — providers, voice profiles, brand context, the review queue and batch jobs —
see [Generator and jobs](generator.md).

**Cadence and period boundaries.** A cadence is a count (1–10) and a period: day, week or month.
Boundaries are the project's own local day, a Monday-starting week, or the 1st of the month, resolved
in the project's time zone. A series created mid-period is first due at the *next* boundary, so
turning one on never immediately spends credit on a partial period. At most one run is open per
series at a time: if the next boundary arrives while a run is still producing, that run closes as
incomplete (its counts are kept) and the new period's run opens.

**No backfill.** If the worker has been down across several boundaries, a series does not catch up by
producing one run per missed boundary — it records how many periods it missed and jumps straight to
the current one. A series that has been off for three weeks produces one period's worth of posts, not
three.

**What a run does.** A run of two or more posts plans its angles first, through the same planning call
an in-request series uses, telling it which angles recent runs already used so a weekly series does
not repeat itself; a run of exactly one post skips planning. Each post then goes through the ordinary
generation path — the same prompt composition, brand context, voice profile, schema validation,
correction retry and usage ledger as a manual Generate — so nothing about how a post is written
differs because it came from a series.

**Policy, with no bypass.** A series' approval and scheduling policy is authorised once, at creation
or edit, and stored on the series — the member who allowed auto-approve may not even be on the project
by the time it fires. The one policy function still decides every post: a post that fails platform
validation goes to review even under auto-approve, exactly as it would from any other path. A post set
to queue takes a real slot through the existing allocator, inside the same transaction as the policy
decision, so two series — or two worker processes — competing for the same account's slots cannot
double-book; a post with no free slot in the queue horizon is left as a draft with that reason
recorded, not retried into a different policy.

**Media sources.** A series declares one media source: `none`, `pool` (an unused image from the
project's media library, optionally narrowed by a tag) or `generate` (one freshly generated image per
post, through the same `ImageGenerator` contract the Media page's "Generate an image" action uses, with
the series' own stored prompt and nothing else — no post text, no brand fields, no voice profile — sent
with the same fixed real-people instruction). A pooled image is reserved exactly like a batch job's
image, so the same image is never claimed by two posts, two jobs or two series at once; videos are
never eligible. Creating a pool or generate series needs media storage configured; if storage is
removed later, an existing series simply skips with that reason rather than failing.

**The media-required skip.** When a series targets an account whose platform requires media (Instagram,
TikTok) and the series cannot produce a usable image for a given post — the pool is exhausted, image
generation is not configured, image generation failed, or storage is not set up — that position is
skipped whole, with the reason recorded and the account named; no half-complete post is written. A
skip is not a failure: it is a neutral outcome that does not count an attempt and does not mark the
run "completed with failures" on its own.

**Idempotency and the per-tick bounds.** A series is claimed and leased exactly like a batch job: the
claim is skip-locked, a lease protects it from a second worker, and a position is produced at most once
under a uniqueness constraint, so overlapping ticks or a restart mid-run cannot double-generate a post.
The standing-series section is its own bounded part of the same worker tick, with its own two limits:

| Variable | Meaning |
| --- | --- |
| `STANDING_SERIES_TICK_MAX_SERIES` | Most standing series one tick claims, 1–10. Default 2. |
| `STANDING_SERIES_TICK_MAX_POSTS` | Most posts one claimed series produces in that tick, 1–10. Default 2. |

These limits are additive to `GENERATION_TICK_MAX_ITEMS`: enabling standing series raises the install's
total concurrent model calls per tick by up to `GENERATION_TICK_MAX_ITEMS + STANDING_SERIES_TICK_MAX_SERIES`
(each claimed series can itself produce several posts within `STANDING_SERIES_TICK_MAX_POSTS`, so the
true ceiling on in-flight calls per tick is `GENERATION_TICK_MAX_ITEMS` from batch jobs plus up to
`STANDING_SERIES_TICK_MAX_SERIES × STANDING_SERIES_TICK_MAX_POSTS` from standing series). Claims rotate
oldest-due-first, so one busy series or project cannot starve another.

**Billing.** A credit hold behaves exactly as it does for batch jobs: a held credential owner's series
is not claimed at all — nothing is generated, no attempt is counted, no failure is recorded, and
`next_run_at` does not advance, so the run simply waits where it left off. The existing probe (one call
every 5 minutes) clears the hold with nothing else to do; a billing refusal reached mid-run requeues
the position with no attempt counted and refreshes the hold on whichever credential actually ran.

**Self-pausing.** A series that closes three runs in a row with zero posts produced pauses itself,
recording why (no usable target, a missing voice profile, and so on), visible on the series' detail
page and undone by the same Resume control a person's own pause uses. A credit hold never counts
toward this: a held run was never claimed, so it was never "produced nothing" in this sense.

**Limits.** Same per-run cadence bound as an in-request series (1–10 posts), the same name rules as
any other named object (1–100 characters, unique per project, case-insensitive), and run history is
retained for 90 days (housekeeping prunes closed runs older than that; an open run is never pruned).

## Dated list

A series' occurrence rule is chosen once, at creation, and cannot be changed afterward: cadence (above)
or **dated list** — a spreadsheet of rows, each pegged to a calendar date, firing on its own anniversary
every year instead of on a recurring schedule. A birthday list is the motivating case: one row per
person, one post per person per year, on their date.

**The file.** A dated list is a CSV with a `date` column (required) and an optional `media` column,
both matched case-insensitively; every other column, in file order, becomes a template field, and the
first of them is the row's identity (its "key column" — a person's name, typically). `date` and `media`
are reserved and cannot also be used as a template field's name. A file with only a `date` column is
allowed — the row's date is the only thing that varies, and the series' instructions use no fields.

**Date formats.** `MM-DD` for a date that recurs every year, or `YYYY-MM-DD` for a date pinned to one
specific year (an anniversary that happened once, like a grand opening, rather than every year).
Leading/trailing spaces are trimmed before parsing. `02-29` is accepted and follows the leap-day rule
below; `YYYY-02-29` is only accepted when `YYYY` is actually a leap year. A year-specific row in the
past at import time is refused.

**The leap-day rule.** A `02-29` row fires on 29 February in a leap year and on 28 February in the
three years in between — never 1 March. It keeps its own fire history per year, so firing on 28
February in a non-leap year does not consume the row's turn for the leap year that follows.

**Limits.** At most 500 rows per list (the same ceiling a batch job's CSV uses) and at most 10 rows
sharing one calendar date (the same ceiling a cadence run's per-period post count uses) — the eleventh
row on a shared date is reported and skipped, not silently dropped from the file. A key-column value
that is blank after trimming is reported and skipped. The rendered instructions for a row are capped
at 10,000 characters.

**The window, lead time and missed occurrences.** Each row's occurrence has a window: it opens
`lead_days` (0–30, set once per series, same as the cadence count's range) days before the row's local
date and closes at the end of that date, both in the project's time zone. `lead_days: 0` means the
window is the date itself; a positive lead time opens the window early so the post can be generated,
reviewed and even queued before the day arrives, while never actually publishing early (see below). If
the worker is down for the entire window — a missed tick, a long outage — the occurrence is recorded
**missed** once the window closes, not backfilled; the row's next occurrence is still computed
correctly for the following year. The bounded sweep that records misses processes at most 50 rows per
tick and only records a miss within 30 days of the window having closed, so a very old stale row is
still advanced to its next occurrence without flooding one tick with historical misses.

**Lead time and queueing.** A post generated early from its lead time is never queued earlier than the
row's own local date: the post carries a queue floor at that date's local midnight, read at every point
a queue allocation picks a slot, so auto-approve-and-queue, pulling a draft forward and a reviewer
approving after the fact all respect the same floor. Review-required leaves the post waiting with no
slot held at all until someone approves it.

**Media.** A row may name its own image in the `media` column, matched by filename against the
project's media library; that reference wins over whatever media source the series itself is
configured with, and a row naming none falls back to the series' source. A row's own image is never
reserved or marked used — the same portrait fires again next year. A reference to a video, to nothing
in the library, or to more than one file with that name is reported at import; a referenced asset later
deleted from the library skips that occurrence with the media reason rather than failing it. **`generate`
is deliberately the wrong media source for a dated list of people**: it would send a photorealistic
prompt for a named individual to an image model with no actual photo of them, producing a fabricated
likeness — the pool and a row's own named asset are the only sound choices for that case; `generate`
remains available for a dated list that is not about named people.

**Re-import.** Importing again replaces the list, not appends to it: a row matched by identity (date
plus key-column value) to a row already stored keeps its fire history and its place in the current
year; a row no longer in the file is removed along with its history; a new row is added fresh. Posts
already produced are never touched by a re-import. Two imports racing each other resolve to one winner
and the other refused as a conflict, never a half-replaced list.

**Permissions.** Viewing a dated series — its rows, upcoming dates and import problems — needs the same
access as viewing any series; importing, adding, editing or deleting a row needs owner or admin, the
same boundary as creating or editing the series itself, enforced on the server regardless of what the
interface happens to show an editor.
