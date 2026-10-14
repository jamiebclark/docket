# Feature Specification: Date-pegged series — content that fires on an anniversary, from a spreadsheet

**Feature Branch**: `072-dated-series`

**Created**: 2026-10-14

**Status**: Draft

**Input**: User description: "Add a second occurrence rule to the series engine from `evergreen-series`: instead of 'n posts per period', a series can be driven by a dated list — each row carrying a month/day (optionally a year), the fields the template needs, and an optional media reference. This is how a brand runs birthdays, anniversaries and 'on this day' content without anyone writing them weekly: upload once, and the series fires each row on its date, every year unless the row names a year. Reuse the CSV ingestion that already exists for jobs (src/server/services/jobs/sources/csv.ts and its tests) rather than inventing a second parser, extended with a validated date column; rows with unparseable or impossible dates are reported on import and skipped, not silently dropped. Store rows in a table keyed to the series (committed migration), editable and re-importable. The worker pass resolves 'which rows are due' in the project's time zone (src/server/db/schema/projects.ts `timezone`, via the Temporal usage the codebase already standardises on), and must handle the cases that make date recurrence bite: Feb 29 in a non-leap year (record the chosen rule in docs/decisions.md), a row whose date passes while the series is paused or the worker is down (fire late within a bounded window, or skip — decide and document), two rows on the same date, a lead time so a post can be generated and reviewed before the date rather than on it, and the same restart/overlap idempotency as the cadence rule so a row never fires twice. Generated posts go through the identical generation, policy and allocation path as `evergreen-series` — no separate code path. UI: on the series screen, importing and viewing a dated list, showing the next few upcoming rows and any rows that failed to import; owner/admin only, server-enforced; follow the docket-ui skill and docs/design-system.md. Tests: import validation and error reporting, due-date resolution across time zones and DST, leap day, missed-window behaviour, lead time, duplicate dates, idempotency across restarts and overlapping ticks, project isolation and authz. Update docs/generator.md and docs/decisions.md. This entry does NOT fetch dates from any external source or API, does NOT generate images of real people (the constraint recorded in `image-generation` holds — a dated series about a public figure is text and typography, not a likeness), and does NOT change the cadence rule's semantics."

## Context and sources

This is the fourth entry of the content-engine roadmap (`.specify/roadmaps/content-engine-roadmap.json`,
slug `dated-series`). It follows `brand-profile-fields` (a project holds its own tagline, description and
website), `image-generation` (a generated image lands in the media library as an ordinary asset) and
`evergreen-series` (a **standing series** keeps producing posts on a cadence, with runs, positions,
policy, allocation, media sources, idempotency and a bounded worker section). It precedes
`setup-write-api` and `mcp-server`.

`evergreen-series` deliberately built the engine so that this entry adds **one more way to decide when a
run opens** and changes nothing else (its decisions W2 and W3, `docs/decisions.md` entry 061). This spec
holds itself to that.

### Behaviour on `main` that this feature builds on

- **A standing series is configuration, not a work list.** It holds the project, a name, a brief, a
  `template`/`templateFields` pair, a voice profile, target account ids, a resolved approval and
  scheduling policy, a media source, an enabled flag and `lastRunAt`/`nextRunAt`. Each time it fires it
  opens a **run**; the run carries **positions**, and a position is what produces one post.
- **`templateFields` exists but is always empty today.** A cadence series' template may contain no
  `{{ placeholder }}`, and one is refused at creation with the same wording a batch job uses for an
  unknown placeholder. The placeholder machinery (`placeholdersIn`, `unknownPlaceholders`,
  `renderTemplate` with its data marks) is already shared with batch jobs.
- **Period boundaries are computed in the project's time zone through Temporal.** `src/lib/series/cadence.ts`
  is pure: `periodStartDate`, `periodStartInstant` (a local midnight that does not exist moves forward;
  one that exists twice takes the earlier offset), `nextBoundaryAfter` and `boundariesBetween`.
- **A run is keyed by series, period and period start, and at most one run per series is open at a time.**
  A new period closes a still-open run as incomplete. A position is keyed by run and position number, so
  a position produces at most one post however the worker restarts or overlaps.
- **One policy decision, one place.** The single policy function approves, approves-and-queues, or leaves
  a post in review. A target that fails content validation forces review even under auto-approve. Queued
  targets take a real slot through the existing allocator, which already accepts an "after" floor and
  searches the queue horizon forward from it, trying candidates one at a time against a uniqueness
  constraint so two writers cannot double-book.
- **The CSV ingestion for jobs is one pure function plus a thin source.** `parseJobCsv` (in
  `src/server/services/jobs/sources/csv.ts`) decodes UTF-8, refuses files over 1 MB, parses with
  `csv-parse/sync`, validates the header (names 1–64 characters, letters/numbers/space/underscore/hyphen/
  dot, no blanks, no case-insensitive duplicates), skips blank lines, refuses rows with more values than
  the header or longer than 50,000 characters, and refuses a file with more than 500 data rows. It returns
  **either** a usable result **or** a list of problems: today any problem at all fails the whole file.
- **Media is provider-declared and reserved.** Instagram and TikTok require media; Facebook, Threads,
  Bluesky and X do not. A standing series declares one media source — none, a pool (an unused library
  image, optionally tag-narrowed, reserved inside the write) or generate (one image per post through the
  declared image-generation contract, sent the series' stored prompt and the fixed real-people
  instruction and nothing else). A position whose media requirement cannot be satisfied is **skipped
  whole** with the reason and the account recorded; a skip is not a failure.
- **The worker is one loop of bounded sections**, with a standing-series section that claims and leases
  skip-locked rows, is kill-safe and deadline-aware, reports its counts in the tick summary, and is
  bounded by its own two per-tick limits. A credit hold means a series is not claimed at all, with
  nothing to clean up afterwards. A series that closes three runs in a row having produced nothing pauses
  itself with the reason.
- **Project isolation is structural.** Every project-owned read and write goes through the scoped
  data-access layer; the `standing_series: ["manage"]` statement (owner and admin) guards
  create/edit/pause/delete, and `post: ["view"]` guards reading the list and run history.
- **One date format for people.** Every instant a person sees goes through the shared local formatter in
  the project's zone, enforced by a lint test (`docs/decisions.md` entry 050).

### Facts, and what is not verified

- Which providers require media comes from `docs/limits.md` and the provider capability declarations, not
  from memory: required for Instagram and TikTok, not required for Facebook, Threads, Bluesky and X.
- All date arithmetic in this entry is done with the installed Temporal polyfill, with the same explicit
  DST disambiguation `src/lib/series/cadence.ts` already uses. No new dependency is needed.
- No live model, image or platform call is made by any test in this entry; anything needing real
  credentials is reported as verified with mocks only.
- No external calendar, holiday feed, almanac or "on this day" service is consulted — by this entry or by
  anything it adds. Every date in the product comes from a file a person uploaded or a row they typed.

## Decisions made while specifying

Everything below was decided here rather than left open, and every one of them belongs in
`docs/decisions.md` as this entry's spec decisions (A1–A38).

### The object, and the second occurrence rule

- **A1 — A dated series is a standing series with a different occurrence rule, not a new object.** A
  series has exactly one **occurrence rule**: *cadence* (N posts per day, week or month — unchanged) or
  *dated list*. Everything else about a series — name, brief, instructions template, voice profile,
  target accounts, policies, media source, enabled flag, runs, positions, failures, self-pause, the
  credit hold and the per-tick bounds — behaves exactly as it does today. The product word for the second
  rule is **Dated list**, and such a series is a **dated series** in prose.
- **A2 — The occurrence rule is chosen when the series is created and cannot be changed afterwards.** A
  cadence run's positions are planned angles; a dated run's positions are spreadsheet rows. Converting
  one into the other would have to decide what happens to an open run, a half-fired list and a run
  history that means something different on each side. Editing a series may change anything else; to
  change the rule, create another series. The edit screen says so.
- **A3 — A dated series has no cadence.** Count and period are not asked for, not stored for it, and
  refused by the server if submitted. How often it fires is the list's business.
- **A4 — A dated series uses the same worker section, claim, lease and per-tick limits as a cadence
  series.** No new section, no new process, no new environment variable, no separate code path for
  generation, policy, allocation, media or failure handling.

### The list and its rows

- **A5 — A row is a date, the template's field values, and an optional media reference.** Nothing else.
  No per-row accounts, voice profile, policy, lead time or prompt: those belong to the series, and a row
  that could override them would be a second series in disguise.
- **A6 — A date is a month and day, optionally preceded by a year.** Without a year the row fires every
  year, forever, until someone removes it. With a year it fires once, in that year, and is then history.
- **A7 — The list's columns are the series' template fields.** This is what `templateFields` was kept for
  (W3/W4). The series' instructions may use `{{ column name }}` for any non-reserved column, matched
  case-insensitively and rendered through the existing template renderer with its data marks, exactly as
  a batch job's instructions are.
- **A8 — Two reserved column names, `date` and `media`; every other column is a template field.**
  `date` is required. `media` is optional. Both are matched case-insensitively. Column names otherwise
  obey the jobs CSV rules unchanged.
- **A9 — One date format: `MM-DD`, or `YYYY-MM-DD` for a row that names its year.** Zero-padded, hyphens
  only. `03-14` and `2027-03-14` are dates; `3/14`, `14-03`, `Mar 14` and `14 March` are not, and are
  reported. Accepting several formats would mean guessing whether `03-04` is March 4th or April 3rd, and
  a dated series that fires a month late is worse than one that refuses to import. The product already
  settled on exactly one date shape for display (entry 050); this is the same principle for input.
- **A10 — A row's identity within a series is its date plus the value of the list's key column**, where
  the key column is the first non-reserved column, compared case-insensitively after trimming. That is
  the key a person already has in mind ("the 14th of March, Ada Lovelace"). It gives three things at
  once: re-import can match a row to the one it replaces and so keep its fire history; a list may not
  hold the same date and key twice; and two different subjects on the same date are plainly two rows.
- **A11 — At most 10 rows may resolve to one calendar date.** Counted across every-year and
  year-specific rows together, so `03-14` and `2027-03-14` both count toward the 14th of March 2027. Ten
  is the cap a run already has on its positions, and a brand posting eleven times on one day is a
  different problem. Import reports the rows that would exceed it, and the row editor refuses them.
- **A12 — 500 rows per series, 1 MB per file, 50,000 characters per row — the jobs CSV limits exactly.**
  Nothing is raised or lowered for this entry.
- **A13 — A row's media reference names an image already in the project's media library, by filename.**
  Exactly one live, non-video asset must match, case-insensitively. Nothing is uploaded by an import and
  nothing is fetched from a URL.
- **A14 — A row's image is used, not consumed.** Unlike a pool image, it is not reserved and not marked
  used: the same portrait is meant to be posted on the same birthday every year. Two rows may name the
  same file.
- **A15 — A row's media reference wins over the series' media source for that row.** The series' source
  is the fallback for rows that name no media: a dated series may be none, pool or generate just as a
  cadence series may. The media-required skip (W28) is unchanged — a row whose named image the platform
  planner refuses outright counts as not satisfying the requirement, and the position is skipped whole
  with the reason and the account named.
- **A16 — Row field values are never sent to an image provider.** The generate source still sends only
  the series' stored prompt plus the fixed real-people instruction, as `image-generation` decided. A
  dated series about a person is therefore text and typography over a pooled or named image, and
  `docs/generator.md` says plainly that generate is the wrong source for a birthday list.

### Import, re-import and editing

- **A17 — One parser, extended with a mode — not a second parser.** The existing pure CSV function gains
  the ability to return usable rows *and* per-row problems together. Whole-file problems (not UTF-8, over
  1 MB, unreadable as CSV, a bad or duplicated header, no data rows, over 500 rows) still refuse the
  import whole: there is nothing to salvage from a file nobody can read. The jobs source keeps today's
  all-or-nothing behaviour byte for byte, proved by its existing tests staying green unchanged.
- **A18 — A row-level problem skips that row, names its line and says what is wrong.** The import
  succeeds with the rows that were usable. These are reported and skipped: a date that does not parse; a
  date that cannot exist (`02-30`, `13-01`, `2027-02-29`); a year-specific date whose day has already
  passed in the project's zone; a date and key that another row in the same file already used; a row
  beyond the 10-per-date cap; an empty key-column value; a media reference matching no live image,
  matching more than one, or matching a video.
- **A19 — An import replaces the whole list.** A spreadsheet is the mental model: what you upload is what
  the series has. Rows matched by identity (A10) are updated in place and keep their fire history; rows
  not in the file are removed with their history; new rows are added. Nothing an import does touches a
  post that has already been produced.
- **A20 — The last import's problems are kept on the series, up to 100 of them, with the file's name and
  when it ran.** Otherwise "12 rows failed" is a toast that dies on the first reload, and nobody ever
  fixes those twelve rows. A later successful import replaces the record.
- **A21 — A template placeholder that names no column is refused when the series is saved, and an import
  that would remove a column the template uses is refused whole.** The wording is the existing unknown-
  placeholder message, which already lists the available fields. The alternative — rendering a silently
  empty value into every post for the next year — is the kind of failure nobody notices.
- **A22 — Rows are editable one at a time: add, edit, delete.** The same validation as an import, applied
  to the one row, with the same messages. Deleting a row deletes its fire history and leaves its posts.

### Which rows are due

- **A23 — An occurrence is a row and a year.** Its **target date** is the row's month and day in that
  year, as a local date in the project's time zone. A year-specific row has exactly one occurrence ever.
- **A24 — February 29 in a non-leap year fires on February 28.** The occurrence still happens once that
  year, one day early, in the same month. The alternatives were rejected: skipping means a brand's
  anniversary content vanishes in three years out of four with nothing to show anyone; moving to March 1
  puts a February anniversary in the wrong month. This is the same "constrain into the month" rule the
  monthly cadence already relies on.
- **A25 — A series-level lead time of 0–30 days, default 0.** The occurrence's **due instant** is local
  midnight at the start of (target date minus lead days), resolved through Temporal with the same
  disambiguation every other boundary in the product uses: a midnight that does not exist moves forward,
  one that exists twice takes the earlier offset. Lead time is how a post gets written and reviewed
  before the day rather than on it, and it is the only protection against a worker that is down on the
  day itself.
- **A26 — The window closes at the end of the target date's local day.** A row fires at any moment from
  its due instant until the end of its own date; after that the occurrence is recorded as **missed** and
  never fires. Late is fine until the day is over, because a post about the 14th is still about the 14th
  at 11pm — and worthless on the 15th. One rule covers both of the hard cases the brief names: a series
  paused across its date and a worker down across its date behave identically, and neither backfills.
  A dated series with no lead time is therefore protected for one day and no more, which `docs/generator.md`
  states next to the lead-time control.
- **A27 — Missed occurrences are recorded lazily and boundedly.** When a series is next evaluated, the
  occurrences whose windows closed unfired in the last 30 days are recorded as missed, at most 50 per
  pass. A series switched back on after a year does not write 365 history rows, and the ones it does
  write are the ones a person might still ask about.
- **A28 — One run per due date, one position per row due on it, oldest date first.** The existing
  one-open-run-per-series rule holds unchanged: a dated series works through a backlog of due dates one
  date at a time, under the existing per-tick bounds, oldest first. A list imported inside many rows'
  windows therefore drains in date order instead of firing hundreds of posts in one tick; rows whose
  window closes while they wait are missed (A26), which is the honest outcome and is visible.
- **A29 — A dated run never calls the angle planner.** Each position has the row's own data, which is
  what makes it distinct; there is nothing for a planner to diversify. Each position takes the existing
  single-post generation path with the row's fields rendered into the series' instructions. The
  avoid-recent-titles mechanism is untouched and unused here.
- **A30 — A queued post is allocated from the start of its target date, not from now.** Otherwise lead
  time would defeat itself: a post generated seven days early would take the first free slot a week
  before the anniversary. The allocator's existing "after" floor carries the target date's local
  midnight; the queue horizon is measured from there. No free occurrence inside the horizon leaves the
  post an approved draft with the reason recorded, exactly as W23 already specifies.
- **A31 — A row fires at most once per year, under a uniqueness constraint on the occurrence.** Two
  overlapping ticks, a killed worker, an expired lease, a recovered run and a re-import of an identical
  row all resolve to the same single post. This is the cadence rule's guarantee restated for dates, and
  it is enforced in the database rather than by checking first.
- **A32 — Due resolution reads the project's time zone every time.** Changing a project's zone moves
  every unfired occurrence and rewrites no fired one. An occurrence that was already missed stays missed.
- **A33 — A dated series with no usable rows simply has no next due date.** That is not an error and not
  a reason to pause: the series is created before its list is imported, shows "No upcoming dates", and
  opens no run, so the self-pause rule (three runs producing nothing, W34) never fires on an empty list.
  W34 is otherwise unchanged and applies to a dated series' runs as it does to a cadence series'.
- **A34 — Pause and resume are unchanged (W12).** A paused series fires nothing; resuming does not
  backfill. On resume, occurrences whose windows closed are missed, and the next due date is the next one
  still ahead or still inside its window.

### Interface and permissions

- **A35 — The dated list lives on the existing series detail screen.** Four things, in this order: the
  next 10 upcoming occurrences with their dates and, where lead time is set, when each will be generated;
  the last import's problems if any; the rows table with its columns, paginated, with add, edit and
  delete; and the Import control. The run history already on that screen is unchanged, and a run names
  the date it fired for.
- **A36 — Importing, adding, editing and deleting rows needs `standing_series: ["manage"]` — owner and
  admin — enforced on the server for every route.** Viewing the list, the upcoming dates and the import
  problems needs `post: ["view"]`, as the rest of the screen already does. Nothing is gated in the
  interface only.
- **A37 — The list is shown as a plain table of the file's own columns**, following the `docket-ui` skill
  and `docs/design-system.md`: one control per question, the house table density, the shared local date
  format, visible focus, labelled controls, and an empty state that says what to upload rather than
  showing a bare "No rows".
- **A38 — No API, webhook, notification, real-time push or external date source.** The same boundary
  `evergreen-series` drew. A dated list is imported and read through the project's own screens.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A brand's birthday list posts itself all year (Priority: P1)

An owner has a spreadsheet of fifty dates — birthdays, founding anniversaries, "on this day" moments —
each with the name and a line of detail, and some with a portrait already in the media library. They
create a standing series, choose Dated list as the occurrence rule, write instructions that use the
spreadsheet's columns, and import the file. From then on, without anyone opening the app, each row
produces a post on its own date, every year.

**Why this priority**: This is the feature. Upload once, and a year of dated content writes itself.

**Independent Test**: Import a list, advance the clock to one row's date, run the worker, and find one
post for that row in the project with the row's data rendered into it; advance to the next row's date and
find the next post; advance a year and find the first row producing again.

**Acceptance Scenarios**:

1. **Given** a dated series with a row for 14 March and today's local date is 14 March, **When** the
   worker runs, **Then** exactly one post exists for that row, generated through the ordinary generation
   path, with the row's field values rendered into the series' instructions.
2. **Given** that same row the day after it fired, **When** the worker runs again, **Then** no second
   post is produced and nothing about the series changes.
3. **Given** that same row a year later on 14 March, **When** the worker runs, **Then** a new post is
   produced for the new year's occurrence.
4. **Given** a row for 14 March and today is 13 March with no lead time, **When** the worker runs,
   **Then** nothing is produced and the series shows that row as next due on 14 March.
5. **Given** a row that names the year 2027, **When** 2027's date passes and it has fired, **Then** the
   row never produces another post and is shown as past.
6. **Given** a row naming a portrait in the media library, **When** it fires, **Then** the post carries
   that image, the image is not marked used or reserved, and the same row fires with the same image the
   following year.

---

### User Story 2 - A messy spreadsheet imports what it can and says what it could not (Priority: P1)

The file has sixty rows. Four have dates nobody can read, one says 30 February, one names a photo that is
not in the library, and two are the same person on the same day. The import takes the fifty-two good
rows, lists the eight it could not use with their line numbers and what was wrong with each, and the
owner can still see that list after a reload while they fix the file.

**Why this priority**: A dated list is uploaded by a person from a real spreadsheet. An importer that
silently drops rows produces a year of missing posts nobody can explain.

**Independent Test**: Import a file with each class of bad row and assert the stored rows, the reported
problems with their line numbers, and that the problems survive a reload.

**Acceptance Scenarios**:

1. **Given** a file whose rows include an unparseable date, an impossible date, a past year-specific
   date, a duplicate date-and-key, an eleventh row on one date, an empty key value and an unmatched media
   reference, **When** it is imported, **Then** every other row is stored, each bad row is reported with
   its line number and reason, and no bad row is stored.
2. **Given** a file that is not UTF-8, is larger than 1 MB, has a duplicated column name or has more than
   500 data rows, **When** it is imported, **Then** the import is refused whole, the existing list is
   untouched, and the reason is shown.
3. **Given** an import that reported problems, **When** the page is reloaded, **Then** the problems are
   still shown with the file's name and when it ran.
4. **Given** a series whose instructions use a column, **When** an import is attempted whose file lacks
   that column, **Then** the import is refused whole with a message naming the missing field.
5. **Given** a list already imported and partly fired, **When** the same file is imported again
   unchanged, **Then** the rows keep their fire history and nothing fires a second time.
6. **Given** a list already imported, **When** a file is imported with one row removed and one added,
   **Then** the removed row and its history are gone, the added row is pending, the untouched rows keep
   their history, and every post already produced still exists.

---

### User Story 3 - Dates behave at the edges (Priority: P1)

A project in Auckland and a project in Los Angeles each have a row for the same day, and each fires on
its own local date. A row for 29 February still produces something in 2027. A row whose date passed while
the series was paused does not ambush anyone a week later. Two people share a birthday and both get a
post.

**Why this priority**: These are the cases that make date recurrence bite, and each of them is a wrong
post or a missing post in production.

**Independent Test**: Drive the resolver with fixed clocks across zones, DST transitions, leap years,
closed windows and shared dates, and assert what fires, what is missed and when.

**Acceptance Scenarios**:

1. **Given** two projects in different time zones each with a row for 14 March, **When** the clock passes
   each project's local midnight, **Then** each fires on its own local date and neither fires on the
   other's.
2. **Given** a project whose local date begins in a daylight-saving gap or repetition, **When** an
   occurrence's due instant is resolved, **Then** exactly one instant is chosen — a missing midnight
   moves forward, a doubled midnight takes the earlier offset — and the row fires exactly once.
3. **Given** a row for 29 February, **When** a non-leap year reaches 28 February, **Then** the row fires
   that day, once, and does not fire again that year.
4. **Given** a row for 14 March and a series paused from 1 March to 20 March, **When** the series is
   resumed, **Then** no post is produced for 14 March, the occurrence is recorded as missed, and the next
   due date is the following year's.
5. **Given** a row for 14 March with no lead time and a worker that is down for all of 14 March, **When**
   the worker comes back on 15 March, **Then** the occurrence is recorded as missed and nothing is
   produced; **and given** the same row with a lead time of 3 days and a worker down only on 14 March,
   **Then** the post was already produced on 11 March.
6. **Given** two rows on 14 March, **When** the date comes, **Then** two posts are produced, one per row,
   each with its own row's data.
7. **Given** a project whose time zone is changed from Los Angeles to Auckland, **When** the next due
   date is resolved, **Then** it is resolved in Auckland and occurrences already fired are unchanged.

---

### User Story 4 - A post is ready before the day, and lands on the day (Priority: P2)

The owner sets a lead time of three days so that posts arrive in Review with time to read them, and the
series is set to auto-approve and queue. Each post is generated three days early but takes a posting slot
on or after the day itself, not the day it was written.

**Why this priority**: Without this, lead time either does not exist (so nothing can be reviewed) or
silently publishes anniversary content days early.

**Independent Test**: Set a lead time, fire an occurrence, and assert the post exists before the date
while its queued target holds a slot occurrence on or after the target date.

**Acceptance Scenarios**:

1. **Given** a series with a lead time of 3 days and a row for 14 March, **When** the worker runs on
   11 March, **Then** the post is produced, and nothing is produced for that row on 12–14 March.
2. **Given** that series set to auto-approve and add-to-queue, **When** the post is produced on 11 March,
   **Then** it is approved and each target holds the earliest free occurrence of its account's slots on or
   after 14 March.
3. **Given** that series set to review-required, **When** the post is produced on 11 March, **Then** it
   waits in Review, approved by nobody and in no slot.
4. **Given** a target whose account has no free occurrence between the target date and the end of the
   queue horizon, **When** the post is produced, **Then** it stays an approved draft with that reason
   recorded and is not queued earlier than the target date.
5. **Given** a produced post that fails content validation for one of its targets, **When** policy is
   applied under auto-approve, **Then** the post is left in review with the validation reason, exactly as
   any other path behaves.

---

### User Story 5 - Nothing fires twice, whatever the worker does (Priority: P1)

Two workers tick at once; one is killed mid-run; the machine restarts; the same date is due in both. The
project still ends up with exactly one post per due row.

**Why this priority**: Duplicate posts reach real audiences and cannot be taken back. The constitution
already states that a missed post beats a duplicate post.

**Independent Test**: Drive two concurrent ticks against one due dated series and assert one run and one
post per row; kill a run between positions, tick again, and assert no row produces twice.

**Acceptance Scenarios**:

1. **Given** one dated series with three rows due today and two ticks running at the same time, **When**
   both attempt it, **Then** one run exists for that date and exactly three posts exist, one per row.
2. **Given** a run interrupted after some of its positions produced posts, **When** a later tick picks it
   up, **Then** it continues from the first unfinished position and produces no second post for any row
   that already has one.
3. **Given** a run whose worker died while holding it, **When** its lease expires, **Then** a later tick
   recovers it and finishes it.
4. **Given** a series under a credit hold on the day a row is due, **When** ticks run, **Then** the
   series is not claimed, nothing is generated, no attempt is counted, no failure is recorded, and when
   the hold clears inside the row's window the row fires normally.

---

### User Story 6 - Only owners and admins can change the list (Priority: P2)

An editor can see the series, its upcoming dates and its posts, and can do nothing to the list. An owner
or admin can import, add, edit and delete rows. Another project's series is not reachable at all.

**Why this priority**: A dated list is a year of unattended publishing. Who can change it is a security
boundary, not a courtesy.

**Independent Test**: Call every list route as an editor, as a non-member and with another project's
series id, and assert refusal in each case regardless of what the interface offered.

**Acceptance Scenarios**:

1. **Given** an editor, **When** they open a dated series, **Then** they see the rows, the upcoming dates
   and the import problems, and no control that changes the list.
2. **Given** an editor, **When** they call an import, add, edit or delete route directly, **Then** the
   server refuses it and the list is unchanged.
3. **Given** a member of project A, **When** they reference a series or a row belonging to project B by
   id on any route, **Then** the response is a not-found and nothing in project B is read or written.
4. **Given** a row that names a media asset, **When** the asset belongs to another project, **Then** the
   reference does not match and the row is reported on import.

### Edge Cases

- A file with a `date` column but no other column: the series' instructions can use no fields, which is
  allowed; the row's date is the only thing that varies.
- A file whose only non-reserved column is the key column: identity is date plus that value, as A10 says.
- A row whose key-column value is only whitespace: reported and skipped (A18).
- A row with trailing or leading spaces around its date: trimmed, then parsed.
- A date of `02-29` in a list, in a leap year: fires on 29 February that year and on 28 February in the
  other three.
- A year-specific row for `2028-02-29`: a real date, fires once.
- A year-specific row for `2027-02-29`: impossible, reported and skipped.
- A row for today, imported today, after today's due instant has passed but before the day ends: fires in
  the next tick (it is inside its window).
- Four hundred rows imported on 1 January with a 30-day lead time: many windows are open at once; dates
  drain oldest first under the existing per-tick bounds, and rows whose windows close while waiting are
  recorded as missed.
- A list where eleven rows share one date: the first ten by file order are imported, the eleventh is
  reported and skipped.
- A series whose instructions use a column, edited to stop using it: the column stays a field and is
  simply unused.
- A media reference naming a file that is later deleted from the library: the row is kept, and the
  occurrence skips with the media reason rather than failing.
- A row naming a video: reported and skipped at import; a library asset that becomes unusable later skips
  at fire time.
- Two rows naming the same image on the same date: both fire with that image; it is not reserved (A14).
- A dated series with pool as its fallback and an exhausted pool: rows without their own media skip with
  the pool reason; rows naming their own image still fire.
- The project's time zone changed between an occurrence's due instant and the end of its window: the
  window is recomputed in the new zone, and the occurrence fires if it is still inside it.
- A series deleted while a dated run is open: the series, its rows, their history and its runs go; posts
  already produced stay (W13).
- An import run twice concurrently: one wins, the other is refused as a conflict, and the list is never
  half-replaced.
- A project whose time zone is one with a half-hour or 45-minute offset: local midnight is still exactly
  one instant and the row fires once.

## Requirements *(mandatory)*

### Functional Requirements

#### The occurrence rule

- **FR-001**: A standing series MUST carry exactly one occurrence rule: cadence or dated list.
- **FR-002**: The occurrence rule MUST be chosen at creation and MUST be refused on edit, with a message
  saying to create another series.
- **FR-003**: A cadence series' behaviour MUST be unchanged by this feature in every respect: the same
  boundaries, the same backfill rule, the same planning, the same self-pause, the same per-tick bounds
  and the same stored shape.
- **FR-004**: A dated series MUST NOT store or accept a cadence count or period; submitting one MUST be
  refused by the server.
- **FR-005**: A dated series MUST use the same worker section, claim, lease, deadline, credit-hold
  behaviour and per-tick limits as a cadence series, with no new environment variable and no second loop.
- **FR-006**: A dated series' posts MUST be produced by the same generation, policy, allocation, media
  and failure-recording path as a cadence series' posts, with no dated-specific prompt, validation,
  failure kind or policy branch.

#### The list

- **FR-007**: A dated series MUST hold an ordered list of rows, each with a month, a day, an optional
  year, a value for each of the list's template fields, and an optional media asset reference.
- **FR-008**: A row without a year MUST recur every year until it is removed; a row with a year MUST
  produce at most one occurrence, in that year.
- **FR-009**: The list's non-reserved columns MUST be the series' template fields, and the series'
  instructions MUST be able to use any of them as a placeholder, rendered through the existing template
  renderer with its data marks.
- **FR-010**: The reserved column names MUST be `date` (required) and `media` (optional), matched
  case-insensitively; every other column MUST become a template field.
- **FR-011**: A date MUST be accepted only as `MM-DD` or `YYYY-MM-DD`, zero-padded, after trimming.
- **FR-012**: A row's identity within a series MUST be its date together with its key-column value
  (the first non-reserved column), compared case-insensitively after trimming; a list MUST NOT hold two
  rows with the same identity.
- **FR-013**: At most 10 rows MUST be allowed to resolve to any one calendar date, counting every-year
  and year-specific rows together.
- **FR-014**: A series MUST hold at most 500 rows; an import file MUST be at most 1 MB and each row at
  most 50,000 characters.
- **FR-015**: A row's media reference MUST resolve to exactly one live, non-video media asset of the same
  project, matched by filename case-insensitively, or be reported as a problem.
- **FR-016**: A row's media asset MUST NOT be reserved or marked used, and MUST be reusable by the same
  row in later years and by other rows.
- **FR-017**: A row's media reference MUST take precedence over the series' media source for that row;
  the series' source MUST apply to rows with no reference.
- **FR-018**: Row field values MUST NOT be sent to an image provider; a generated image MUST be produced
  from the series' stored prompt and the fixed real-people instruction only.

#### Import and editing

- **FR-019**: Importing MUST reuse the existing CSV ingestion, extended to return usable rows and
  per-row problems together, and MUST NOT introduce a second parser.
- **FR-020**: The jobs CSV source's behaviour MUST remain exactly as it is today, including its
  all-or-nothing treatment of problems, proved by its existing tests passing unchanged.
- **FR-021**: A whole-file problem (not UTF-8, over the size limit, unreadable as CSV, blank or duplicate
  column name, no data rows, over 500 rows, a missing `date` column, a column the instructions require
  absent) MUST refuse the import whole and leave the existing list untouched.
- **FR-022**: A row-level problem MUST skip that row only, MUST be reported with the file's line number
  and a plain-language reason, and MUST NOT be silently dropped; the remaining rows MUST import.
- **FR-023**: Row-level problems MUST include an unparseable date, an impossible date, a year-specific
  date already past in the project's zone, a duplicate identity, a row beyond the per-date cap, an empty
  key-column value, and a media reference matching nothing, matching more than one asset, or matching a
  video.
- **FR-024**: An import MUST replace the whole list: rows matched by identity are updated and keep their
  occurrence history, rows absent from the file are removed with their history, and new rows are added.
- **FR-025**: An import MUST NOT modify or delete any post already produced by the series.
- **FR-026**: The most recent import's problems (up to 100), the file's name and when it ran MUST be
  stored on the series and shown until a later successful import replaces them.
- **FR-027**: Saving a series whose instructions name a field that is not a list column MUST be refused
  with the existing unknown-placeholder message.
- **FR-028**: A row MUST be addable, editable and deletable individually, under the same validation and
  with the same messages as an import; deleting a row MUST delete its occurrence history and keep its
  posts.
- **FR-029**: Two imports or edits of the same list running at once MUST NOT leave the list partly
  replaced; the loser MUST be refused as a conflict.

#### Due resolution

- **FR-030**: An occurrence MUST be identified by a row and a year, and its target date MUST be the row's
  month and day in that year as a local date in the project's time zone.
- **FR-031**: A row for 29 February MUST fire on 28 February in a non-leap year, once.
- **FR-032**: A series MUST carry a lead time of 0–30 whole days, defaulting to 0.
- **FR-033**: An occurrence's due instant MUST be the start of the local day that is the target date minus
  the lead time, resolved through Temporal with explicit disambiguation: a local midnight that does not
  exist moves forward, one that occurs twice takes the earlier offset.
- **FR-034**: An occurrence MUST be eligible to fire from its due instant until the end of its target
  date's local day, and MUST NOT fire after that.
- **FR-035**: An occurrence whose window closes without firing MUST be recorded as missed, with the
  reason distinguishable from a failure and from a skip.
- **FR-036**: Missed occurrences MUST be recorded only for windows that closed within the last 30 days,
  at most 50 per evaluation pass.
- **FR-037**: A dated series MUST open at most one run at a time, for the oldest due target date, with
  one position per row due on that date.
- **FR-038**: A dated run MUST NOT call the angle planner; each position MUST take the single-post
  generation path with its row's fields rendered into the series' instructions.
- **FR-039**: A queued target of a dated post MUST be allocated the earliest free slot occurrence at or
  after the start of the target date's local day, never earlier; with none inside the queue horizon the
  post MUST stay an approved draft with the reason recorded.
- **FR-040**: A row MUST produce at most one post per year, enforced by a uniqueness constraint rather
  than a prior check, so overlapping ticks, lease expiry, process restart and run recovery cannot
  double-fire it.
- **FR-041**: Due resolution MUST read the project's current time zone on every pass; changing the zone
  MUST move unfired occurrences and MUST NOT alter fired or missed ones.
- **FR-042**: A dated series with no usable rows MUST open no run, report no next due date, and MUST NOT
  be auto-paused for producing nothing.
- **FR-043**: Pausing MUST stop a dated series firing; resuming MUST NOT backfill, and occurrences whose
  windows closed while paused MUST be missed.
- **FR-044**: A dated series' next due date MUST be visible and MUST be the earliest occurrence that is
  still ahead of now or still inside its window.
- **FR-045**: A credit hold MUST prevent a dated series being claimed at all, with no attempt counted, no
  failure recorded and no occurrence consumed, and MUST allow it to fire normally once cleared inside the
  window.
- **FR-046**: A position whose media requirement cannot be satisfied MUST be skipped whole with the
  reason and the requiring account recorded, and MUST NOT count as a failure.

#### Interface and permissions

- **FR-047**: The series detail screen MUST show, for a dated series, the next 10 upcoming occurrences
  with their dates and generation dates, the last import's problems, the rows table, and an Import
  control.
- **FR-048**: Run history MUST identify the date a dated run fired for.
- **FR-049**: Importing, adding, editing and deleting rows MUST require `standing_series: ["manage"]`,
  enforced on the server for every route, independently of what the interface renders.
- **FR-050**: Viewing the rows, upcoming occurrences and import problems MUST require `post: ["view"]`.
- **FR-051**: Every list read and write MUST be project-scoped, so a row, a series or a media asset of
  another project is not reachable by id.
- **FR-052**: Every date and instant shown MUST use the shared local formatter in the project's time zone.
- **FR-053**: The screens MUST follow the `docket-ui` skill and `docs/design-system.md`: keyboard
  operable, visible focus, labelled controls, house table density, and empty, loading and error states
  that say what to do.
- **FR-054**: `docs/generator.md` MUST document the dated list: the date formats, the reserved columns,
  the limits, the leap-day rule, the window and missed behaviour, lead time and its interaction with
  queueing, the per-date cap, re-import semantics, why generate is the wrong media source for a list
  about people, and the permissions.
- **FR-055**: `docs/decisions.md` MUST record this entry's decisions A1–A38, including the leap-day rule
  and the missed-window rule explicitly.

### Key Entities *(include if feature involves data)*

- **Standing series (extended)**: gains an occurrence rule (cadence or dated list), a lead time in days,
  and the record of its last import; its cadence count and period become meaningless for a dated series.
- **Dated row**: one line of the list, keyed to its series — a month, a day, an optional year, the
  template field values as text, an optional media asset reference, and the file line it came from. Its
  identity within the series is its date plus its key-column value.
- **Occurrence**: one firing of one row in one year — the row, the year, the target date, and its outcome
  (produced, failed, skipped or missed). What makes a row fire exactly once a year.
- **Import record**: the last import of a list — the file's name, when it ran, how many rows were stored,
  and up to 100 problems, each with a line number and a reason.
- **Run and position (existing)**: a dated run is the firing of one target date; each of its positions is
  one due row, and produces at most one post.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An owner can turn a 50-row spreadsheet of dates into a running series in under 5 minutes,
  with no step outside the series screen and no row typed by hand.
- **SC-002**: Across a simulated year, every every-year row produces exactly one post per year and every
  year-specific row produces exactly one post in total — 100% of rows, 0 duplicates.
- **SC-003**: Every post for a row with a lead time of N days exists at least N−1 days before the row's
  date, and no queued post for a row is scheduled before the row's own date.
- **SC-004**: A row for 29 February produces a post in 100% of years, leap or not.
- **SC-005**: Of rows that cannot be used, 100% are reported with their line number and a reason, and 0%
  are stored or silently dropped; the report is still visible after a reload.
- **SC-006**: Two projects in different time zones with the same row each fire on their own local date in
  100% of cases, including across daylight-saving transitions in both directions.
- **SC-007**: Under two concurrent workers, repeated restarts and forced lease expiry, a due row produces
  exactly one post in 100% of runs of the concurrency test.
- **SC-008**: A row whose window closes unfired produces no post and is reported as missed in 100% of
  cases, and no missed row ever produces a post afterwards.
- **SC-009**: Every attempt to change a dated list by someone other than an owner or admin is refused by
  the server — 100% of routes, including direct calls that bypass the interface.
- **SC-010**: No row data of any kind reaches an image provider: 0 occurrences in the recorded prompts of
  the image-generation tests.
- **SC-011**: The existing cadence behaviour is unchanged: the whole of the `evergreen-series` test suite
  passes without modification to any assertion about cadence semantics.

## Assumptions

- The occurrence rule is the only new axis: a series is still one brief, one template, one voice profile,
  one set of accounts and one policy pair, whichever rule it uses.
- A dated list is uploaded as CSV. Spreadsheet formats (`.xlsx`) are out of scope; "export as CSV" is a
  step every spreadsheet tool has.
- The key column is the first non-reserved column of the file. Lists that want a different key reorder
  their columns; no separate "key" setting is introduced.
- A lead time cap of 30 days is enough for review and keeps the queue-horizon search bounded; longer
  lead times are a scheduling-calendar feature, not this one.
- Missed-occurrence history retained for 30 days is enough to answer "why did nothing post on the 14th";
  older misses are not interesting and are not recorded.
- Occurrence history is pruned with the run history it belongs to, under the existing 90-day
  housekeeping, with an open run never pruned.
- The brand's own judgement governs whose birthday is posted; Docket adds no list of people, no public
  figure data and no likeness generation.

## What this entry does not do

- **No external date source.** No holiday calendar, no almanac, no "on this day" feed, no API import. A
  date exists in Docket because a person put it there.
- **No likeness generation.** The `image-generation` constraint holds: row data never reaches an image
  provider, and a dated series about a real person is text and typography over an image a person chose.
- **No change to cadence semantics.** Boundaries, the no-backfill rule, planning, avoid-titles,
  self-pause and the per-tick bounds are untouched.
- **No conversion between occurrence rules.**
- **No per-row accounts, voice profile, policy, lead time, instructions or image prompt.**
- **No recurrence beyond "this month and day, every year or once".** No "second Tuesday", no "every three
  years", no ranges, no spans, no multi-day events, no lunar or non-Gregorian calendars.
- **No backfill** of occurrences whose windows closed, and no retry of a missed occurrence.
- **No public API, MCP, webhook, notification, email or real-time push** for dated lists.
- **No spreadsheet editing experience**: the rows table adds, edits and deletes one row at a time, and
  re-import is how a bulk change is made.
- **No media upload during import**, and no fetching an image from a URL named in a row.
- **No video**: a row's asset is an image, and none is generated.
- **No explicit-time scheduling**: a dated post is a draft or takes a real slot on or after its date.
