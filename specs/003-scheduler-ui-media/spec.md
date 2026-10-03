# Feature Specification: Docket Scheduler Screens and Media — Storage, Media Library, Composer, Calendar, Posts and Accounts

**Feature Branch**: `003-scheduler-ui-media`

**Created**: 2026-10-03

**Status**: Draft

**Input**: User description (roadmap entry `scheduler-ui`, reproduced in full because later phases rely on its technical detail):

> Build the user-facing scheduler screens and media handling on top of entry 2's services. Before specifying, read docs/build-prompt.md in full (especially 'Media', 'Posting slots and the queue', 'The provider framework', 'UI'), .specify/memory/constitution.md, the docket-ui skill (.claude/skills/docket-ui/SKILL.md), docs/research/llm-and-storage.md (S3/R2 section), docs/research/meta.md and docs/research/bluesky.md (image constraints), and docs/decisions.md.
>
> Must deliver:
> - Storage interface (put, delete, public URL, presigned URL) with an S3-compatible implementation via @aws-sdk/client-s3 configured by env (endpoint, region, bucket, credentials, public base URL, forcePathStyle; R2 checksum settings per research). A MinIO service in docker-compose under an optional `offline` profile for offline development and tests, with docs stating clearly that real Instagram/Threads publishing needs a publicly reachable bucket (R2 custom domain or S3) because Meta fetches media by URL.
> - Media library: upload through the app (size and mime checks), sharp to read dimensions and strip metadata, alt text editing, tags, 'unused' filter (not yet used in any post), delete (blocked or warned if used by scheduled posts). A per-provider variant pipeline hook: providers declare constraints (format, max bytes, dimensions) and a variant generator produces and caches derived files (e.g. JPEG for Instagram, <=2,000,000 bytes for Bluesky); implement the generic mechanism and the constraints declared so far.
> - Composer (/p/[slug]/compose and edit existing): base content, optional per-platform overrides, target account picker, media picker, live validation and counts per target from provider capabilities (no counting logic in components), per-platform preview, and the three actions add to queue (shows each target's resulting time before confirm), schedule at a specific time (project time zone), publish now; near-queued-post warning.
> - Calendar (/p/[slug]/calendar): month and week views in the project time zone, posts per account, upcoming empty slots shown as placeholders, drop a post onto an empty slot (with keyboard equivalent), queue actions move-to-next-free, swap, pull queue forward.
> - Post list with status filters (URL search params) and post detail with per-target status, attempts and retry for failed targets; ambiguous targets clearly flagged with a 'mark as published / mark as not published' resolution.
> - Accounts screen: list accounts with provider, status and last error; prominent needs_reauth banner across the app; connect via the mock provider; posting slots editor per account (add, pause, delete).
> - Tests: storage interface against MinIO or a mocked S3 client, variant generation, composer validation logic, server actions' authorization (editor vs admin per build prompt roles), and the queue actions through the UI service layer.
> - Update README and docs; append decisions.
>
> Must NOT do: real provider connect flows (bluesky, meta-facebook-instagram, meta-threads), generation UI (generator), API keys/webhooks UI (public-api), the dedicated failures view (hardening).

## Overview

Entry 2 built the scheduling engine — accounts, posts, per-account targets,
weekly posting slots, the queue, the `mock` provider and the scheduler tick —
with no screens. This feature puts a face on it and adds the one thing the
engine deliberately left out: real files.

- **Storage**: one small storage abstraction (put, delete, public URL,
  time-limited signed URL) backed by any S3-compatible bucket (Cloudflare R2,
  AWS S3, or a local MinIO for offline work), configured entirely by
  environment settings.
- **Media library**: upload images through the app, have them checked,
  measured and cleaned of hidden metadata, give them alt text and tags, find
  the ones never used, and delete them safely. Each platform's file rules
  (format, size, dimensions) are declared by its provider, and a generic
  variant pipeline makes and caches a compliant copy per platform.
- **Composer**: write a post once, optionally adjust it per account, attach
  media, see live per-account counts, issues and previews, then add to queue
  (seeing each account's time first), schedule at a time, or publish now.
- **Calendar**: month and week views in the project's time zone with every
  account's posts and its upcoming empty slots, where posts can be moved into
  gaps by drag-and-drop or keyboard, plus the queue actions (move to next free
  slot, swap, pull forward).
- **Posts**: a filterable list and a detail page showing each target's
  status, attempts and errors, with retry for failed targets and a clear
  "needs your decision" resolution for ambiguous ones.
- **Accounts**: account list with status and last error, mock-provider
  connect, a posting-slot editor per account, and an app-wide banner whenever
  an account needs reconnecting.

Every screen calls the existing service layer (constitution IV); this
feature adds services only where the screens need something the engine does
not yet offer (media upload, tags, variants, post listing, "move this target
into that specific empty slot").

## User Scenarios & Testing *(mandatory)*

Personas (roles from the build prompt): the **owner/admin** who connects
accounts and defines posting slots; the **editor** who manages media and
writes, schedules and fixes posts; the **operator** who configures storage
and deploys Docket. Owners and admins can do everything editors can.

### User Story 1 - Compose a post and add it to the queue (Priority: P1)

An editor opens Compose in a project, writes the post text, picks two
connected accounts as targets, attaches an image from the media library, and
watches each target's character count and issues update as they type. One
account's platform has a shorter limit, so they open that account's override
and shorten the text just for it. The per-account previews show what each
platform will receive. They choose "Add to queue", see the exact time each
account's next free slot gives (in the project's time zone), and confirm.
The post is now scheduled, with each target at its own time.

**Why this priority**: Composing and queuing is the reason the scheduler
exists; with only this story, the product schedules real posts (to the mock
provider today, to real platforms in later entries).

**Independent Test**: In a project with two mock accounts that have slots
and one uploaded image, compose a post with an over-limit text for one
account's limit, fix it with an override, preview the queue, confirm, and
verify both targets are scheduled at the previewed times and the post detail
page shows them.

**Acceptance Scenarios**:

1. **Given** an editor on the composer with targets selected, **When** they type, **Then** every target shows "used / limit" computed by that target's provider rule (e.g. graphemes), and a target past its limit shows an error state with the issue text — the counts match exactly what the server enforces on submit.
2. **Given** a target whose provider requires media, or does not allow text-only posts, **When** no media is attached, **Then** that target shows the provider's issue and cannot be queued, scheduled or published until fixed; other targets are unaffected.
3. **Given** base content and an override for one target, **When** the editor views previews, **Then** the overridden target previews and validates its override, while the other targets use the base content; clearing the override returns that target to the base content.
4. **Given** valid content, **When** the editor chooses "Add to queue", **Then** a confirmation shows, per target, the account, the local date and time with the time-zone name, and any target that cannot be queued with its reason (e.g. "Account X has no active posting slots"); nothing is reserved until they confirm.
5. **Given** the confirmation, **When** the editor confirms, **Then** each queueable target takes its account's next free slot, the editor sees the times actually assigned, and any time that differs from the preview (because someone else took that slot meanwhile) is highlighted.
6. **Given** some targets queue and one cannot (no slots), **When** the editor confirms, **Then** the queueable targets are scheduled and the failed one is reported with its reason and remains unscheduled for later action.
7. **Given** the composer, **When** the editor saves without choosing a scheduling action, **Then** the post is kept as a draft with its targets, overrides and media, and can be reopened later from the post list.
8. **Given** a project with no connected accounts, **When** an editor opens Compose, **Then** they see an explanation that a social account is needed, with a link to Accounts (or a note to ask an owner or admin, if they cannot connect accounts).

---

### User Story 2 - Schedule at a time, publish now, and edit a scheduled post (Priority: P1)

Instead of queuing, an editor can pick an exact date and time (always in the
project's time zone, with the zone shown) or publish immediately. If the
chosen time is close to a post already queued on the same account, they are
warned but can go ahead. Publish now asks for confirmation, because it goes
out within the next scheduler run. A scheduled post that has not started
publishing can be reopened in the composer and edited; its targets are
re-checked against their platforms.

**Why this priority**: The three scheduling actions are the composer's core
contract in the build prompt; editing before publish is needed for everyday
use.

**Independent Test**: Schedule a draft at a time 10 minutes from a queued
post on the same mock account and verify the warning and the schedule;
publish another now and verify it is published by the next tick; edit a
scheduled post's text and verify the change and re-validation.

**Acceptance Scenarios**:

1. **Given** the composer, **When** the editor picks "Schedule at a time" and enters a local date and time, **Then** the time is interpreted in the project's time zone, the confirmation shows it in that zone (and, where the time does not exist or occurs twice because of a daylight-saving change, shows the instant it resolves to), and every target is scheduled at that instant without consuming slots.
2. **Given** an explicit time within the warning window of a queued post on the same account, **When** the editor reviews it, **Then** a warning names the nearby post and its time, and the editor can still confirm.
3. **Given** an explicit time in the past, **When** the editor tries to schedule it, **Then** it is refused with a suggestion to publish now instead.
4. **Given** "Publish now", **When** the editor confirms the dialog (which names the accounts it will go to), **Then** each valid target becomes due immediately and the post detail shows it as publishing or published after the next scheduler run.
5. **Given** a scheduled post where no target has started publishing, **When** the editor opens it in the composer, **Then** the existing content, overrides, media and targets are loaded, and saving re-validates every target; a target that would no longer be valid is refused with its issues and keeps its previous content.
6. **Given** an existing scheduled post, **When** the editor removes a target account in the composer, **Then** that target is cancelled and its slot freed; **When** they add a new account, **Then** the new target starts unscheduled and the editor is prompted to queue, schedule or publish it.
7. **Given** a post with any target publishing or published, **When** the editor opens it, **Then** content editing is disabled with an explanation, and only actions still allowed on individual targets are offered.
8. **Given** a post in review (`needs_review`), **When** an editor opens it, **Then** the scheduling actions are unavailable with an explanation that it must be approved first.

---

### User Story 3 - Upload and manage media (Priority: P1)

An editor uploads images to the project's media library. Each file is checked
for type and size, measured, and stored with its hidden metadata (camera
details, location) removed and its orientation corrected. They write alt text
for each image, add tags such as "product" or "event-2026", and can later
filter the library by tag or show only images never used in any post. When
they delete an image that a scheduled post still needs, Docket refuses and
says which posts use it; deleting one used only by drafts or already
published posts asks for confirmation first.

**Why this priority**: Image posts need files, Instagram cannot post without
one, and the generator's "one post per unused image" flow (later entry)
depends on tags and the unused filter.

**Independent Test**: With storage configured (offline bucket or mocked),
upload a JPEG carrying location metadata, a PNG, an over-size file and a
non-image; verify the first two are stored with dimensions and without
metadata, the others are rejected with reasons; edit alt text and tags,
filter by tag and by unused, and try deleting an image attached to a
scheduled post.

**Acceptance Scenarios**:

1. **Given** the media library, **When** an editor uploads one or more files, **Then** each file is reported individually: accepted files appear in the library with a thumbnail, dimensions, byte size and type; rejected files show why (unsupported type, too large, too many pixels, unreadable).
2. **Given** an accepted image that carried hidden metadata (e.g. location, camera details) and a rotation flag, **When** it is stored, **Then** the stored file contains no such metadata and displays the right way up, and the recorded dimensions are those of the upright image.
3. **Given** a stored image, **When** an editor edits its alt text, **Then** the new alt text is saved and is what every platform that supports alt text receives for that image from then on; images without alt text are visibly marked as missing it.
4. **Given** images, **When** an editor adds or removes tags, **Then** the tags are saved, the library can be filtered by a tag, and the filter is reflected in the page address so it can be shared or bookmarked.
5. **Given** images some of which have been attached to posts, **When** the editor filters by "unused", **Then** only images never attached to any post are shown.
6. **Given** an image attached to a post with a target that is scheduled, publishing, failed (still retryable) or awaiting a decision (ambiguous), **When** an editor tries to delete it, **Then** deletion is refused and the message lists those posts with links.
7. **Given** an image attached only to drafts or to fully published or cancelled posts, **When** an editor deletes it, **Then** a confirmation names the image and the posts that use it; on confirm, the image, its stored file and its platform variants are removed, it is detached from drafts, and published posts' history records that the image was deleted.
8. **Given** storage is not configured, **When** a member opens the media library or the composer's media picker, **Then** they see a plain explanation that media storage is not set up (and, for owners/admins, a pointer to the docs) instead of an error; text-only posting still works.

---

### User Story 4 - Media fits each platform automatically (Priority: P2)

Platforms have different file rules: one accepts only JPEG, another caps
each image at 2,000,000 bytes, others limit width or aspect ratio. Each
provider declares its rules; when a post with images is queued, scheduled
or published, Docket makes a compliant copy ("variant") of each image for
each target platform that needs one, stores it, and reuses it next time. The
composer tells the editor when an image will be adapted ("converted to JPEG
for this account") and blocks only what cannot be fixed automatically (for
example an aspect ratio the platform refuses, since Docket never crops).

**Why this priority**: Real providers (next entries) depend on it, but the
mock provider and the UI work without it; the generic mechanism must exist
now so providers only declare numbers.

**Independent Test**: With test providers declaring an Instagram-like rule
(JPEG only, 8 MB, width 320–1440, aspect 4:5 to 1.91:1) and a Bluesky-like
rule (2,000,000 bytes), generate variants for a large PNG and a large JPEG;
verify format, size and dimensions comply, that a second request reuses the
cached variant, and that an out-of-range aspect ratio is reported as an
issue rather than cropped.

**Acceptance Scenarios**:

1. **Given** a provider that declares media constraints (accepted formats, preferred output format, maximum bytes per file, minimum and maximum dimensions, allowed aspect-ratio range), **When** an image does not meet them, **Then** the variant generator produces a derived file that meets every constraint it can fix (format conversion, downscaling, re-compression), keeping metadata stripped and colours consistent.
2. **Given** an image that already meets a provider's constraints, **When** a variant is requested, **Then** the original is used as-is and no copy is made.
3. **Given** a variant already made for the same image and the same constraints, **When** it is requested again, **Then** the cached variant is reused; **When** a provider's declared constraints change, **Then** a new variant is made for the new constraints.
4. **Given** an image whose aspect ratio is outside a provider's allowed range, or that is smaller than the provider's minimum and cannot be fixed without distortion, **When** it is validated for that provider, **Then** it is reported as an error naming the rule, and no variant is attempted.
5. **Given** a byte limit the generator cannot reach without dropping below the provider's minimum dimensions or a quality floor, **When** generation is attempted, **Then** it fails with a clear message for that target and that target is refused; other targets are unaffected.
6. **Given** a post with images queued, scheduled or published now, **When** each target is accepted, **Then** its variants exist before it is accepted (so failures are seen by the editor, not discovered at publish time), and at publish time the provider receives each variant's public address, type, dimensions, size and the image's alt text.
7. **Given** a variant missing at publish time (e.g. removed from the bucket), **When** the scheduler reaches that target, **Then** the variant is regenerated before the provider is called; if that fails, the target fails with a clear, secret-free message and no provider call.
8. **Given** the composer, **When** an attached image will be adapted for a target, **Then** that target shows an informational note saying what will change (e.g. "Converted to JPEG", "Compressed to fit 2,000,000 bytes"), not an error.

---

### User Story 5 - See and rearrange the schedule on a calendar (Priority: P2)

An editor opens the calendar and sees the month (or a week) in the project's
time zone, with the zone named. Each post appears on its day and time,
labelled with its account and status. Upcoming empty slots appear as dashed
placeholders per account, so gaps are obvious. The editor drags a queued post
onto an empty slot of the same account — or, from the keyboard, selects the
post and picks "Move to slot…" — and it moves there. From a post's menu they
can also move it to its account's next free slot or swap it with another
queued post, and for any account they can "pull the queue forward" to close
gaps.

**Why this priority**: The calendar is how the owner sees what is going out
and spots gaps; rearranging relies on the queue actions entry 2 already
provides.

**Independent Test**: With a mock account with daily slots and three queued
posts leaving a gap, open the month and week views, verify posts and dashed
empty slots appear at the right local times, move a post into the gap by
keyboard, swap two posts, pull the queue forward, and verify the resulting
times through the service layer.

**Acceptance Scenarios**:

1. **Given** scheduled targets and slots, **When** a member opens the calendar, **Then** the month view (default) shows each target on its local day with time, account and status, and the page shows the project's time-zone name; the week view shows the same targets positioned by local time.
2. **Given** an account with active slots, **When** the visible range includes future dates, **Then** each upcoming free slot occurrence in that range is shown as a dashed placeholder labelled with the account; past occurrences, occupied occurrences and paused slots are not shown as empty slots.
3. **Given** many accounts, **When** the member filters the calendar by account, **Then** only that account's posts and empty slots are shown; the view, date and account filter are kept in the page address.
4. **Given** a target that is queued or explicitly scheduled and has not started publishing, **When** the editor drops it onto an empty slot of the same account (or uses "Move to slot…" from the keyboard and picks the slot), **Then** the target takes exactly that occurrence, any occurrence it held is freed, and the calendar updates; dropping onto another account's slot is refused with a clear message.
5. **Given** two editors acting at once, **When** both try to put a target into the same empty slot, **Then** exactly one succeeds and the other is told the slot was just taken, with the calendar refreshed.
6. **Given** a queued target, **When** the editor chooses "Move to next free slot", **Then** it moves to the account's earliest free occurrence after now (never the one it already holds); if none is free, it stays and a message says so.
7. **Given** two queued targets on the same account, **When** the editor chooses "Swap with…" on one and picks the other, **Then** their times are exchanged atomically; the picker only offers queued targets on the same account.
8. **Given** an account whose queue has gaps, **When** the editor chooses "Pull queue forward" for that account, **Then** a confirmation shows which posts will move and to when, and on confirm the account's queued targets move into the earliest free occurrences in their current order, none later than before.
9. **Given** any drag action, **When** the user uses only the keyboard, **Then** an equivalent exists (select a post, open its action menu, choose the action, pick the destination), with focus returned to the moved post afterwards and the change announced.
10. **Given** a calendar range with no posts and no slots, **When** it is shown, **Then** an empty state explains that slots are set per account and links to Accounts.

---

### User Story 6 - Find posts and fix the ones that went wrong (Priority: P2)

An editor opens the post list and filters it by status — for example
"failed" or "partially failed" — through links that change the page address.
Opening a post shows each target: account, status, scheduled time (and how
it was scheduled), the published link, the last error, and the attempt log.
A failed target has a "Retry" button. An ambiguous target is flagged in amber
with "Needs your decision", explaining that Docket could not tell whether
the platform published it; after checking the platform, the editor marks it
"published" (optionally pasting the link) or "not published".

**Why this priority**: Without this, failures are invisible and ambiguous
targets are dead ends; the dedicated failures view comes later (hardening),
but the per-post view is the minimum.

**Independent Test**: Using mock accounts configured to fail, be ambiguous
and succeed, publish posts, then filter the list by each status, open the
details, retry a failed target and verify it publishes on the next tick,
and resolve an ambiguous target both ways.

**Acceptance Scenarios**:

1. **Given** posts in several statuses, **When** a member selects a status filter, **Then** the list shows only posts with that status, the filter is a link reflected in the page address, and the list shows per post an excerpt, status (text plus colour), target accounts with their own statuses, and the next or last scheduled time in the project's time zone.
2. **Given** more posts than fit on one page, **When** the member pages through, **Then** pagination is also kept in the page address and works from the keyboard.
3. **Given** a post, **When** a member opens its detail, **Then** each target shows account, status, scheduled local time with zone, schedule kind (slot, explicit, now), external link once published, last error, attempt count and the attempt log (time, step, outcome, request and response summaries) — never credentials.
4. **Given** a failed target, **When** an editor chooses "Retry", **Then** only that target is reset and made due now, and the detail reflects the new state; published targets of the same post are untouched.
5. **Given** an ambiguous target, **When** a member views the post or the list, **Then** it is shown in amber with "Needs your decision" and an explanation; retry is not offered.
6. **Given** an ambiguous target, **When** an editor chooses "Mark as published" (optionally with the post's link) or "Mark as not published", **Then** the target becomes published or failed respectively, the post's status updates, and a failed-after-resolution target can then be retried.
7. **Given** a scheduled target that has not started publishing, **When** an editor cancels it from the detail page (after a confirmation naming the account), **Then** it is cancelled and any slot it held is freed.
8. **Given** a post with no published or in-progress targets, **When** an editor deletes it after confirming, **Then** it disappears from the list and its slots are freed; deletion is refused, with an explanation, if any target is published or publishing.

---

### User Story 7 - Manage accounts, posting slots and reconnection warnings (Priority: P2)

An owner or admin opens Accounts, sees every connected account with its
platform, status and last error, and connects a new mock account (choosing
a display name and how it should behave, for offline development). For each
account they edit its weekly posting slots: add a day and local time, pause
or resume a slot, or delete it. Whenever any account in the project needs
reconnecting, every project page shows a prominent banner saying which
account and what to do. Editors see accounts and slots but cannot change
them.

**Why this priority**: Slots drive the queue and accounts are the targets;
without this screen, setup needs the service layer by hand.

**Independent Test**: As an admin, connect two mock accounts, add, pause and
delete slots, mark one account as needing reconnection (via the mock's
refresh-failure behaviour and a tick), verify the banner on every project
page, reconnect it, and verify the banner clears; as an editor, verify the
same screens are read-only and the server refuses the changes.

**Acceptance Scenarios**:

1. **Given** connected accounts, **When** a member opens Accounts, **Then** each account shows display name, platform, status (text plus colour), last error (secret-free), its slots, and when it was connected.
2. **Given** an owner or admin, **When** they connect a mock account with a display name and a behaviour, **Then** it appears in the list as active and is selectable in the composer; the mock option is shown only when the mock provider is enabled for this deployment.
3. **Given** an account, **When** an owner or admin adds a slot by weekday and local time, **Then** the slot appears in the list (sorted by weekday then time) with the project's time-zone name, and a duplicate weekday-and-time is refused with a clear message.
4. **Given** a slot, **When** it is paused or resumed, **Then** its state changes and paused slots are visibly marked; targets already holding its occurrences keep their times.
5. **Given** a slot, **When** an owner or admin deletes it after a confirmation naming the slot, **Then** it is removed; targets already holding its occurrences keep their times.
6. **Given** an account with no slots, **When** its slot list is shown, **Then** an empty state says "No posting slots yet" with an "Add a slot" action (for owners/admins).
7. **Given** an account in `needs_reauth`, **When** any member views any project page, **Then** a prominent, assistive-technology-announced banner names the account(s) and says what to do: owners/admins get a link to the account; editors are told to ask an owner or admin; the banner never shows secrets.
8. **Given** a mock account in `needs_reauth`, **When** an owner or admin chooses "Reconnect", **Then** it becomes active again and the banner disappears (real providers' reconnect flows arrive in their own entries).
9. **Given** an owner or admin, **When** they remove an account after a confirmation that names it and says how many unpublished posts will be cancelled, **Then** the account disappears from the list and composer, its unpublished targets are cancelled and their slots freed, and published history is kept.
10. **Given** an editor, **When** they view Accounts, **Then** connect, slot editing, reconnect and remove controls are not offered, and the same changes attempted directly against the server are refused.

---

### User Story 8 - Configure storage for any environment (Priority: P3, operator-facing)

The operator points Docket at a bucket through environment settings: Cloudflare
R2 or AWS S3 in production, or a local MinIO started with an optional
`offline` Compose profile for working without the internet. Docket checks the
settings at start-up and fails loudly, naming the setting, if they are
incomplete. The documentation says plainly that real Instagram and Threads
publishing needs a bucket the internet can reach (an R2 custom domain or S3),
because Meta downloads each image from its public address; a local MinIO is
only for offline development with the mock provider.

**Why this priority**: Needed to use the media library at all, but it is a
one-time setup task and its correctness is mostly verified by tests.

**Independent Test**: Start the stack with the `offline` profile and verify a
ready-to-use bucket exists and uploads work end to end; start with partial
storage settings and verify start-up fails naming the missing setting; run
the storage tests against MinIO or a mocked client.

**Acceptance Scenarios**:

1. **Given** complete storage settings, **When** Docket starts, **Then** media features are enabled; **Given** no storage settings, **Then** Docket starts with media features disabled (as in User Story 3, scenario 8); **Given** partial or invalid settings, **Then** start-up fails with a message naming the setting.
2. **Given** `docker compose --profile offline up`, **When** the stack starts, **Then** a MinIO service with a bucket ready for Docket is available with no manual steps, and the documented settings point Docket at it; without the profile, no MinIO service starts.
3. **Given** a stored file, **When** its public address is requested, **Then** it is the configured public base address plus the file's key, and fetching it returns the file with the right content type.
4. **Given** a stored file, **When** a time-limited signed address is requested with a lifetime between 1 second and 7 days, **Then** a working signed address is returned; lifetimes outside that range are refused.
5. **Given** an R2 bucket, **When** files are uploaded and fetched, **Then** the integrity-check settings the research identifies as R2-compatible are in effect by default, and no unsupported upload options (such as per-object public-access flags) are sent.
6. **Given** the README and storage docs, **When** an operator reads them, **Then** they find: every storage setting, worked examples for R2 (custom domain), S3 and offline MinIO, the statement that Instagram/Threads cannot fetch from `localhost` or a private bucket, that signed addresses do not work on R2 custom domains, and that the mock provider is the way to develop offline.

---

### Edge Cases

- **Upload limits**: files above the configured size limit (default 20 MB),
  images above the configured pixel limit (default 50 megapixels, protecting
  the server from decompression bombs), animated images, and files whose
  content does not match their claimed type are rejected with a specific
  reason; the type is judged from the file's contents, not its name.
- **Partial batch upload**: when uploading several files, each one succeeds
  or fails on its own; one bad file never discards the others.
- **Storage failure mid-upload**: if the bucket refuses or times out, no
  media record is created (no record without a file); if a record cannot be
  saved after the file was stored, the stored file is removed (or left
  orphaned and reported in logs) — never a record pointing at nothing.
- **Concurrent delete and attach**: an image being attached to a post in one
  tab while another tab deletes it — exactly one wins; the composer reports
  the image is gone, or the delete is refused because it is now in use.
- **Variant pipeline under load**: generating variants for a post with many
  images and several targets is bounded in time; generation for one image
  failing never affects other images or targets.
- **Constraint changes**: when a provider's declared constraints change in a
  new release, old variants are not reused; already-published history is
  untouched.
- **Alt text limits**: alt text over the longest limit any registered
  provider accepts (Instagram and Threads accept up to 1,000 characters per
  research; the library allows up to 2,000) is accepted in the library but
  flagged by each provider's validation where it exceeds that provider's
  limit.
- **Daylight-saving in the composer and calendar**: an explicit local time
  that does not exist (spring-forward) or occurs twice (fall-back) resolves
  by the same rule as the queue (entry 2 decision), and the confirmation
  shows the resolved instant; week views on transition days show the 23- or
  25-hour day correctly.
- **Project time-zone change**: already-scheduled targets keep their
  instants and are displayed in the new zone; empty slots are recomputed in
  the new zone.
- **Stale screens**: a calendar or post page acted on after the data changed
  (target already published, slot already taken, post deleted) gets a clear
  message and a refreshed view, never a silent overwrite.
- **Composer with no valid targets**: all three scheduling actions are
  disabled with the reason; saving as a draft is still allowed.
- **Override longer than base**: an override is validated on its own; an
  empty override is treated as "no override" (uses the base content).
- **Unregistered provider**: an account whose provider is no longer
  registered appears in Accounts with a clear status and cannot be targeted.
- **Large ranges**: the calendar only computes empty slots for the visible
  range and never beyond the queue's horizon.
- **Roles and isolation**: a member who loses access mid-session gets "not
  found" on their next action (entry 1 behaviour); no screen ever shows data
  from another project.
- **Media of other projects**: an image id from another project can never be
  attached, viewed, signed or deleted; it behaves as not found.

## Requirements *(mandatory)*

### Functional Requirements

**Storage**

- **FR-001**: The system MUST provide one storage abstraction with four operations — store a file under a key with its content type, delete a file by key, produce the public address of a key, and produce a time-limited signed address for a key (lifetime 1 second to 7 days) — and every part of Docket that touches files MUST use it.
- **FR-002**: The system MUST provide an S3-compatible implementation configured entirely by environment settings: endpoint, region, bucket, access key id, secret access key, public base address, path-style addressing on/off, and integrity-check behaviour defaulting to the R2-compatible "only when required" mode documented in research.
- **FR-003**: Storage settings MUST be validated at start-up: none set means media features are disabled; a partial or invalid set MUST fail start-up naming the setting; every setting MUST be documented in `.env.example`. Storage credentials MUST never reach the browser, logs, attempt log or error messages.
- **FR-004**: Docker Compose MUST gain an optional `offline` profile that starts a MinIO service and prepares a bucket for Docket automatically; without the profile nothing about the default stack changes.
- **FR-005**: The system MUST NOT send storage options the research lists as unsupported by R2 (for example per-object access-control headers), and MUST set the content type on every stored file.

**Media library**

- **FR-006**: Editors, admins and owners MUST be able to upload one or more images through the app; each file is accepted or rejected on its own, judged by its actual contents, against an allowed type list (default JPEG, PNG and WebP, still images only), a configurable size limit (default 20 MB) and a configurable pixel limit (default 50 megapixels).
- **FR-007**: For every accepted image the system MUST apply its orientation flag, remove embedded metadata (including location and camera details), record its upright width, height, byte size and type, store the cleaned file, and only then create the media record. The original uncleaned file is never stored.
- **FR-008**: Members MUST be able to view the media library with thumbnails, dimensions, size, type, alt text (with images missing alt text visibly marked), tags and whether each image has been used; filters for tag, "unused" (never attached to any post) and "missing alt text" MUST be links reflected in the page address, with pagination.
- **FR-009**: Editors, admins and owners MUST be able to edit an image's alt text (up to 2,000 characters) and its tags (free-form, case-insensitive, up to 20 per image, each up to 40 characters).
- **FR-010**: Deleting an image MUST be refused when it is attached to any post with a target that is scheduled, publishing, failed or ambiguous, listing those posts; otherwise it MUST require a confirmation naming the image and any posts using it, then remove the image's record, stored file and variants, detach it from drafts, and keep published posts' history readable with the image shown as deleted.
- **FR-011**: When storage is not configured, the media library and media picker MUST show a plain "media storage is not set up" state; text-only posting MUST keep working.

**Variant pipeline (provider hook)**

- **FR-012**: The provider contract MUST let each provider declare media constraints: accepted formats, the output format to convert to when needed, maximum bytes per file, minimum and maximum width and height, and an allowed aspect-ratio range. Declaring constraints MUST remain a change inside the provider's own folder (constitution V).
- **FR-013**: The system MUST provide one variant generator that, for an image and a provider's constraints, returns the original when it already complies, or produces a compliant derived file by format conversion, downscaling and re-compression (metadata stripped, colours normalised to the standard web colour space); it MUST NOT crop or upscale, and MUST fail with a clear reason when the constraints cannot be met that way.
- **FR-014**: Variants MUST be stored through the storage abstraction and cached per image and per constraint set, so the same request reuses the existing variant and a change in constraints produces a new one; deleting an image deletes its variants.
- **FR-015**: Provider validation in the composer and services MUST judge each image as it will be sent after adaptation: fixable mismatches (format, too large, too many pixels) are informational notes; unfixable ones (aspect ratio out of range, below minimum size, generation impossible) are errors.
- **FR-016**: Queuing, scheduling and publishing now MUST ensure each accepted target's variants exist before accepting it, and report generation failures per target. At publish time the engine MUST pass each provider the variant's public address, type, dimensions, size and the image's alt text, regenerating a missing variant before the provider call and failing the target with a clear message (no provider call) if that is impossible.
- **FR-017**: This feature MUST implement the generic mechanism and the constraints of the providers registered so far (the mock provider's declared capabilities); real providers declare their own constraints in their entries. Tests MUST exercise the mechanism with test providers declaring the Instagram and Bluesky rules from research (Instagram: JPEG only, 8 MB, width 320–1440, aspect 4:5 to 1.91:1; Bluesky: at most 2,000,000 bytes per image).

**Composer** (`/p/[projectSlug]/compose`, and editing an existing post)

- **FR-018**: The composer MUST provide: base text, a target-account picker listing the project's active accounts (with platform), an optional per-target override of the text for each selected account labelled with its platform, and a media picker (choose from the library with search, tag and unused filters, upload inline, reorder, remove, and edit alt text in place).
- **FR-019**: For each selected target, the composer MUST show live character counts as "used / limit" and validation issues, computed by the target provider's own counting rule and validation — the same logic the server applies on submit — with no counting logic re-implemented in the screen; a target past its limit MUST show an error state. Results MUST update as the user types without a full page reload.
- **FR-020**: For each selected target, the composer MUST show a preview of what that platform will receive: the effective text (override or base) and the attached images in order with alt-text indicators and adaptation notes. The preview is an approximation, not a pixel-perfect rendering.
- **FR-021**: The composer MUST offer save as draft and the three scheduling actions: add to queue (shows each target's resulting time, or its reason it cannot be queued, before the user confirms, and then the actually assigned times with differences highlighted); schedule at a specific local date and time in the project's time zone (zone name shown; resolved instant shown for non-existent or repeated local times; past times refused; near-queued-post warnings shown but not blocking); and publish now (confirmation naming the accounts).
- **FR-022**: Opening an existing post MUST load its content, overrides, media and targets; saving MUST re-validate all targets and follow entry 2's rules (no content edits once any target has started publishing; removed accounts cancel their targets; added accounts start unscheduled; posts in review cannot be scheduled until approved).
- **FR-023**: The composer MUST handle targets independently: an invalid or unqueueable target never blocks the others, and each target's outcome is reported.

**Calendar** (`/p/[projectSlug]/calendar`)

- **FR-024**: The calendar MUST offer month and week views in the project's time zone (zone name shown), with previous/next/today navigation, and with view, date and account filter kept in the page address.
- **FR-025**: The calendar MUST show every non-cancelled target in range on its local day and time, labelled with account and status, linking to the post; and every upcoming free slot occurrence in range (future only, active slots only, within the queue horizon) as a dashed placeholder labelled with its account.
- **FR-026**: The system MUST provide a service action "move this target into this specific free occurrence of its account", transactional and protected by the same database guarantee as the queue, freeing any occurrence the target held; it applies to queued or explicitly scheduled targets that have not started publishing, refuses other accounts' occurrences, and reports "slot just taken" when it loses a race.
- **FR-027**: The calendar MUST let a user drop a target onto an empty slot, and MUST offer a keyboard equivalent for every drag action (select the post, open its action menu, choose "Move to slot…", pick from that account's upcoming empty slots), returning focus to the moved post and announcing the change.
- **FR-028**: The calendar MUST expose the queue actions from entry 2: move to next free slot and swap with another queued target on the same account (from a target's action menu), and pull the queue forward for one account (with a confirmation listing the moves before they happen).

**Posts**

- **FR-029**: The system MUST provide a post list (`/p/[projectSlug]/posts`) with status filters for every post status (and "needs your decision" for posts with an ambiguous target) as links reflected in the page address, paginated, showing per post an excerpt, status, target accounts with their own statuses, and the relevant scheduled time in the project's time zone. A service function for listing posts by status MUST be added to the shared service layer.
- **FR-030**: The system MUST provide a post detail page showing per target: account, status, scheduled local time with zone, schedule kind, external link once published, last error, attempt count and the attempt log entries (time, step, outcome, request and response summaries) — never credentials or tokens.
- **FR-031**: The post detail MUST offer, where the target's state allows it: retry (failed targets only), cancel (scheduled targets not yet publishing, with confirmation), and for ambiguous targets "Mark as published" (with an optional link) and "Mark as not published"; ambiguous targets MUST be shown in amber with "Needs your decision" and an explanation, and MUST NOT offer retry.
- **FR-032**: The post detail MUST offer edit (opens the composer) and delete (with confirmation; refused with an explanation when any target is published or publishing).

**Accounts and slots** (`/p/[projectSlug]/accounts`)

- **FR-033**: The accounts screen MUST list each account with display name, platform, status, secret-free last error, connected date and its posting slots.
- **FR-034**: Owners and admins MUST be able to connect a mock account (display name, behaviour) when the mock provider is enabled, reconnect a mock account that needs reauthorisation, change a mock account's behaviour, and remove any account (confirmation naming it and the number of unpublished posts that will be cancelled). Real providers' connect and reconnect flows are out of scope.
- **FR-035**: Owners and admins MUST be able to add a slot (weekday and local time, project time-zone name shown, duplicates refused), pause or resume it, and delete it (confirmation); the list is sorted by weekday then time and marks paused slots.
- **FR-036**: Every project page MUST show a prominent, accessible banner whenever any of the project's accounts is in `needs_reauth`, naming the accounts and telling owners/admins how to fix it (link) and editors to ask an owner or admin; it MUST disappear once no account needs reauthorisation.

**Authorization, isolation and shared layer**

- **FR-037**: Every server action and page in this feature MUST call the shared service layer (no direct database access, constitution III/IV), validate input with the same schemas the services and future API use, and return a typed success-or-error result with field errors for forms.
- **FR-038**: Roles MUST be enforced on the server: editors, admins and owners manage media and create, edit, queue, schedule, publish, move, swap, pull forward, cancel, retry, resolve and delete posts; only owners and admins connect, reconnect, configure and remove accounts and manage posting slots. Non-members get "not found" for every project resource. The UI hides actions a role cannot perform, but the server check is authoritative.

**Screens and states**

- **FR-039**: Every new screen MUST follow the docket-ui conventions: it replaces the placeholder for its section in the app shell, has a page title, handles loading, empty, error and populated states explicitly, is fully usable from the keyboard with visible focus and labelled controls, uses real table markup for tabular lists, shows statuses with text plus colour, and shows every date and time in the project's time zone (relative times carry the absolute time as a tooltip).

**Tests**

- **FR-040**: Automated tests MUST cover: the storage abstraction against MinIO or a mocked S3 client (store, delete, public address, signed address and lifetime bounds, integrity settings, no unsupported headers); upload checks and metadata stripping; variant generation (format conversion, byte target, dimension limits, aspect-ratio refusal, caching and constraint-change invalidation); composer validation logic per target (counts by each counting rule, overrides, media requirement, adaptation notes); authorization of every server action for editor, admin, owner and non-member; and the queue actions as invoked by the screens through the service layer (move to a specific slot including the race, move to next free, swap, pull forward).

**Documentation and decisions**

- **FR-041**: The README MUST describe media storage setup and the new screens; a storage document MUST give the R2, S3 and offline MinIO setups and state clearly that real Instagram/Threads publishing needs a publicly reachable bucket (R2 custom domain or S3) because Meta fetches media by public address, that `localhost` and private buckets will not work, and that signed addresses do not work on R2 custom domains. `docs/adding-a-provider.md` MUST explain declaring media constraints. Judgement calls MUST be appended to `docs/decisions.md`.

### Key Entities

- **Stored file**: bytes in the bucket under a key, with a content type; reachable at the public base address plus key, or through a time-limited signed address. Not a database record on its own.
- **Media asset** (extends entry 2's record): one cleaned image in a project — storage key, public address, type, upright width and height, byte size, alt text, tags, first-used time, uploader, created time.
- **Media tag**: a short case-insensitive label on a media asset, used for filtering and by later generation jobs; scoped to the project.
- **Media constraints**: a provider's declared file rules — accepted formats, output format, maximum bytes, minimum/maximum dimensions, aspect-ratio range. Lives in code with the provider.
- **Media variant**: a derived, compliant copy of one media asset for one constraint set — storage key, public address, type, dimensions, byte size, and an identifier of the constraint set it satisfies. Project-scoped, deleted with its asset.
- **Post, post target, posting slot, slot occurrence, social account, publish attempt**: as defined by entry 2; this feature reads and acts on them through its services, adding "move target to a specific occurrence" and "list posts by status".

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An editor can compose a two-account post with one image, fix an over-limit target with an override, and add it to the queue in under 2 minutes, without leaving the composer.
- **SC-002**: Character counts and issues in the composer update within half a second of typing, and in 100% of tested cases (emoji, combining characters, multi-byte text, each counting rule) match the result the server returns on submit.
- **SC-003**: 100% of uploaded test images that carried location or camera metadata are stored with none of it, and display upright.
- **SC-004**: For test providers declaring the Instagram and Bluesky rules from research, 100% of generated variants meet every declared constraint (format, bytes, dimensions), and repeating the request reuses the cached variant instead of producing a new file.
- **SC-005**: With two people moving different posts into the same empty slot at once, exactly one succeeds in 20 out of 20 repeated runs, and no occurrence is ever held twice.
- **SC-006**: A month view for a project with 10 accounts, 300 scheduled posts and daily slots is usable (posts and empty slots shown) within 2 seconds on a typical laptop.
- **SC-007**: Every action available by drag-and-drop or mouse on the calendar, composer, post, media and accounts screens can be completed with the keyboard alone.
- **SC-008**: An account needing reconnection is visible on every project page on the next page load after it is flagged, to every member of the project.
- **SC-009**: Every server action in this feature refuses editors where only owners/admins are allowed, and refuses non-members, in 100% of the authorization tests.
- **SC-010**: An operator following the storage docs can start the offline stack and upload an image in under 10 minutes, and the docs state the public-bucket requirement for Instagram/Threads in the setup section itself, not only in a footnote.
- **SC-011**: Scans of rendered pages, action results, logs and attempt entries in tests find 0 occurrences of storage credentials or account tokens.

## Assumptions

- **Entries 1 and 2 are the base**: projects, members and roles, the scoped data-access layer, the app shell with project switcher and scheduler-health indicator, the provider contract and registry, the mock provider, the queue service (preview, allocate, move to next free, swap, pull forward, empty slots, near-queued warnings), post services (draft, update, queue, schedule, publish now, cancel, retry, resolve ambiguous, delete, attempts) and account/slot services already exist and are reused, not rebuilt.
- **"Mark as not published"** maps to entry 2's "resolve ambiguous as failed"; the target can then be retried.
- **Per-platform overrides are per target account** (a post has one target per account), labelled by platform in the composer, because entry 2 stores overrides on targets.
- **Post type is derived from media** (no images → text, one → image, several → carousel), checked against each provider's supported post types.
- **"Unused" means never attached to any post** (entry 2's first-used time), so detaching an image or deleting its post does not make it "unused" again; this protects the later "generate for all unused images" flow from duplicates.
- **Delete rule**: blocked when any target that could still publish (scheduled, publishing, failed, ambiguous) depends on the image; warned otherwise. Platforms already hold their own copy of published images.
- **Uploads go through the app server**, not browser-to-bucket signed uploads; this avoids the R2 checksum issue with signed uploads noted in research and keeps type/size checks on the server. Signed addresses are used for time-limited reads (e.g. thumbnails when the bucket is not public).
- **Upload defaults** (configurable): JPEG, PNG and WebP still images; 20 MB per file; 50 megapixels per image. GIF, HEIC and animated images are out of scope (video/animation is later).
- **Variants are made when a target is accepted** (queue, schedule, publish now), not at upload, because the platforms involved are only known then; the scheduler regenerates a missing one as a fallback.
- **Mock provider constraints**: the mock keeps its existing capabilities (JPEG and PNG, 5,000,000 bytes, 4 images) expressed as media constraints; Instagram-like and Bluesky-like rules are exercised through test providers, and the real providers declare them in their own entries.
- **Mock-only connect and reconnect**: entry 2's mock connect is reused; "reconnect" for a mock account simply returns it to active. Real providers' connect and reconnect flows (OAuth, credential forms, token paste) belong to the Bluesky and Meta entries.
- **Brief vs this entry on local storage**: the build prompt says to "use a real bucket in every environment" because Meta cannot fetch from `localhost`; this entry adds an optional offline MinIO for development and tests with the mock provider only, and the docs carry the build prompt's warning prominently. This is the one new piece of infrastructure (MinIO and its bucket-setup step, under an opt-in profile) and is justified in plan.md and the decisions log per constitution VI.
- **Research facts relied on** (`docs/research/llm-and-storage.md` §3, `meta.md`, `bluesky.md`): R2 uses region `auto`, rejects per-object access-control headers, supports signed GET/PUT/HEAD/DELETE for 1 s to 7 days on the S3 API domain only (not custom domains), and needs the "checksum only when required" settings with current SDK versions; Instagram needs JPEG, ≤ 8 MB, width 320–1440, aspect 4:5 to 1.91:1, alt text ≤ 1,000 characters; Threads accepts JPEG/PNG ≤ 8 MB, width 320–1440, aspect ≤ 10:1, alt text ≤ 1,000 characters; Bluesky images ≤ 2,000,000 bytes each, up to 4, alt text required (may be empty). Research marks as **UNVERIFIED** whether R2 and MinIO need path-style addressing and whether older MinIO rejects default checksums; both are made configurable and covered by tests against MinIO or a mocked client, and are reported as verified only if those tests ran.
- **Dependencies**: the S3 client and signer, and the image library, are already installed (decision 19). Drag-and-drop uses the platform's native capabilities; no UI framework is added.
- **Out of scope** (per the input): real provider connect flows, generation screens, API keys and webhooks screens, the dedicated failures view, video and animation.
