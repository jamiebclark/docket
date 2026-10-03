# Feature Specification: Docket Scheduling Engine — Accounts, Posts, Posting Slots, Provider Framework and the Scheduler Tick

**Feature Branch**: `002-scheduling-engine`

**Created**: 2026-10-03

**Status**: Draft

**Input**: User description (roadmap entry `scheduler-engine`, reproduced in full because later phases rely on its technical detail):

> Build Docket's scheduling engine (no UI beyond what is needed to exercise it — entry 3 builds the screens). Before specifying, read docs/build-prompt.md in full (especially 'Deployment: one codebase, any host', 'Data model', 'The provider framework', 'Publishing as a step machine', 'Scheduler rules', 'Posting slots and the queue', 'Quality bar'), .specify/memory/constitution.md, docs/research/tooling.md and docs/decisions.md, and build on the DAL and project model from entry 1.
>
> Must deliver:
> - Schema + migrations (all project-scoped, registered with the scope-enforcement test): social_accounts (provider key, display name, external id, encrypted credentials, token expiry, status active|needs_reauth, last error, per-account publish limit metadata), media_assets (storage key, public URL, mime, width, height, bytes, alt text, used-in-post tracking; storage implementation itself comes in entry 3), posts (statuses draft|needs_review|approved|scheduled|publishing|published|partially_failed|failed, base content, origin manual|generated|api, generation metadata jsonb), post_media ordering, post_targets (scheduled_at UTC, schedule_kind slot|explicit|now, slot occurrence reference, per-platform override content, step machine state jsonb, status incl. ambiguous, external id + url, attempt count, next_attempt_at, lease_until/lease_owner, last error), posting_slots (account, weekday, local time, paused), publish_attempts (append-only: target, step, request summary, response summary, outcome, timestamp — never tokens), and a scheduler heartbeat (last successful tick per subsystem).
> - Provider framework in src/providers/: SocialProvider interface (key, displayName, capabilities incl. text length + counting rule, max images, mime types, max bytes, media required, text-only allowed, supported post types text|image|carousel with room for video|story|reel; connect strategy oauth|credentials|manual-token; optional refreshCredentials; validate(content, capabilities) -> ValidationIssue[]; advance(ctx) -> StepResult continue|done|retryable_error|fatal_error|ambiguous), a registry, shared text-counting utilities (graphemes via Intl.Segmenter, UTF-8 bytes, chars), and docs/adding-a-provider.md. Adding a provider must require only a new folder + registry line.
> - A `mock` provider with configurable behaviour (succeed, multi-step continue, retryable error, fatal error, ambiguous, rate-limited) usable in tests and in the app for offline development, with a mock 'connect' that creates an account without credentials.
> - Slot allocation service (one function used by UI, jobs and API later): next free occurrence per account computed in the project time zone using @js-temporal/polyfill with explicit DST handling (non-existent local times resolve forward; repeated times use the earlier instant — record this in decisions.md); transactional allocation backed by a partial unique index so two concurrent queue requests can never take the same (account, occurrence) ; clear error when an account has no active slots; freeing an occurrence on cancel/delete/move; explicit actions move-to-next-free-slot, swap two queued targets, pull-the-queue-forward for one account; warning (not error) when an explicit-time target lands within a configurable window of a queued target on the same account; a function listing upcoming empty slot occurrences per account.
> - Post services: create/update draft, add to queue (returns per-target times before confirm via a preview function), schedule at explicit time, publish now, cancel target, retry a failed target; post status derivation incl. partially_failed.
> - runTick() in src/server/scheduler/: bounded work (default well under 30 s, configurable time and item budget), claims due targets with FOR UPDATE SKIP LOCKED + lease column in a short transaction, calls provider.advance outside any transaction, persists step state, exponential backoff with cap for retryable errors, marks ambiguous outcomes and never retries them automatically, enforces per-account publish limits in our code before calling providers, recovers targets whose lease expired (killed tick), a separate token-refresh section that refreshes credentials near expiry via provider.refreshCredentials and flags needs_reauth on failure, and writes the heartbeat. Safe to run concurrently.
> - Triggers: worker entry (src/worker.ts or similar, built into the same Docker image) looping runTick every WORKER_INTERVAL_SECONDS (30–60); POST /api/internal/tick authenticated by TICK_SECRET (constant-time compare) running one tick; env RUN_WORKER_IN_PROCESS to run the loop inside the web process (Next instrumentation hook). Add the worker service to docker-compose.yml using the same image.
> - Minimal UI hooks only: a scheduler-health indicator in the app shell showing last successful tick and a loud stale warning (threshold configurable).
> - Tests required: concurrent ticks never double-claim; a killed tick (expired lease) is recovered; backoff timing and attempt cap; ambiguous outcomes are not retried; partially_failed derivation and single-target retry; concurrent queueing never double-books an occurrence; DST spring-forward and fall-back cases in at least two zones; freed occurrences are reused; per-account limit enforcement; end-to-end: create post -> queue -> tick -> published with the mock provider; scope-enforcement test covers the new tables.
> - Append decisions to docs/decisions.md; update .env.example.
>
> Must NOT do: media upload/storage, composer, calendar, post list and accounts/slots screens (entry 3); any real provider (bluesky, meta-facebook-instagram and meta-threads entries); LLM generation (generator); public API (public-api); failures view (hardening).

## Overview

Docket's first pillar is the scheduler: a post is written once, aimed at one
or more social accounts in a project, and goes out at the right time on each
— either in that account's next free weekly posting slot, at a time the user
chose, or immediately. This feature builds the engine behind that promise,
without the screens (entry 3 builds the composer, calendar, post list and
account/slot screens on top of it):

- the records for social accounts, media, posts, per-account targets, weekly
  posting slots, an attempt log and a scheduler heartbeat;
- one queue service that hands out slot occurrences correctly across time
  zones and daylight-saving changes and never double-books;
- the post services every later caller (screens, generation jobs, public API)
  will use to draft, queue, schedule, publish now, cancel and retry;
- a provider plug-in contract plus a `mock` provider, so the whole pipeline
  can be exercised offline and real platforms can be added later by dropping
  in one folder;
- a short, repeatable scheduler "tick" that publishes due posts one bounded
  step at a time, is safe to run on several machines at once and safe to
  kill, and can be driven by a worker process, an HTTP call from any cron, or
  the web process itself;
- a small health indicator in the app shell so a stopped scheduler is never
  silent.

The guiding rule throughout: **a missed post is better than a duplicate
post.** When the engine cannot know whether a platform accepted a post, it
stops and asks a human instead of trying again.

## User Scenarios & Testing *(mandatory)*

Personas: the **owner/admin** who connects accounts and defines posting
slots; the **editor** who writes and schedules posts; the **operator** who
deploys Docket and keeps the scheduler running; the **developer** who later
adds a real platform. Because entry 3 builds the screens, most stories here
are exercised through the service layer, the scheduler entry points, and the
one new UI element (the health indicator).

### User Story 1 - Queue a post and have it publish on its own (Priority: P1)

An owner connects a mock social account to a project (no credentials needed)
and gives it weekly posting slots, for example Monday, Wednesday and Friday
at 09:00 in the project's time zone. An editor creates a draft post with
some text aimed at that account, asks to add it to the queue, sees the exact
time it will go out, and confirms. When that time arrives, the scheduler
publishes it through the mock provider; the target records the external post
id and URL, the post becomes `published`, and every provider call made along
the way is visible in the attempt log.

**Why this priority**: This is the core value of the scheduler pillar and
the end-to-end path every later entry relies on. If only this works, the
product already schedules posts (to a mock).

**Independent Test**: With a fresh project, connect a mock account, add one
slot, create a draft, preview the queue (time shown), confirm, advance the
clock past the slot time, run one tick, and verify the post and target are
`published` with an external id, URL and attempt-log entries.

**Acceptance Scenarios**:

1. **Given** a project with a connected mock account that has active slots, **When** an editor previews "add to queue" for a draft aimed at that account, **Then** they receive, per target, the exact UTC instant and the project-local wall time it would go out, and nothing is reserved yet.
2. **Given** a preview, **When** the editor confirms, **Then** each target is assigned its own account's next free slot occurrence, the post becomes `scheduled`, and the confirmation returns the times actually assigned (flagging any that differ from the preview because another post took the previewed occurrence in the meantime).
3. **Given** a post aimed at three accounts with different slots, **When** it is added to the queue, **Then** each target gets the next free occurrence of its own account's slots, so the three targets may go out at three different times.
4. **Given** a scheduled target whose time has arrived, **When** a tick runs, **Then** the target is published through its provider, records external id and URL, and the post's status becomes `published` once all its targets are published.
5. **Given** a mock account configured for multi-step publishing (e.g. "create container" then "publish"), **When** ticks run, **Then** each tick performs at most one step for that target, persists the in-between state, and the target is `published` after the final step — never within a single long-running call.
6. **Given** a draft, **When** the editor schedules it at an explicit future time instead, **Then** each target is scheduled at that instant, consumes no slot occurrence, and is published by the first tick after that instant.
7. **Given** a draft, **When** the editor chooses "publish now", **Then** each target becomes due immediately and is published by the next tick.
8. **Given** an editor in project A, **When** they try to read, queue, schedule or cancel anything belonging to project B (where they are not a member), **Then** it behaves as if it does not exist.

---

### User Story 2 - A scheduler that is safe to run anywhere, at any concurrency, and safe to kill (Priority: P1)

The operator runs Docket however their host allows: a separate worker
process from the same image (Docker Compose's new `worker` service), an
external cron calling a secret-protected tick endpoint every minute, or the
web process running the loop itself on a single-service host. Several of
these can run at the same time — two worker replicas plus a cron, say — and
every due target is still worked by exactly one of them at a time. If a tick
is killed in the middle (container restart, host sleep, deploy), the work it
had claimed is picked up again later without duplicating anything that may
already have gone out.

**Why this priority**: The scheduler is the part that runs unattended. A
double-claimed target means a duplicate public post; a stuck target means a
silently missed one. Deployment flexibility is a core product requirement
("one codebase, any host").

**Independent Test**: Run several ticks concurrently against a set of due
mock targets and verify each was advanced exactly once; claim a target and
abandon it (simulated kill), move the clock past the lease, run a tick and
verify recovery; call the tick endpoint with no, wrong and correct secrets;
start the worker and the in-process loop and verify heartbeats advance.

**Acceptance Scenarios**:

1. **Given** many due targets and several ticks started at the same moment, **When** they all run, **Then** no target is advanced by more than one tick, and every due target that fits within the combined budgets is advanced once.
2. **Given** a tick with a configured time budget and item budget, **When** more work is due than fits, **Then** the tick stops claiming new work once either budget is reached, finishes what it holds, and returns well within the time budget; the remaining work is picked up by later ticks.
3. **Given** a tick that claimed a target and was killed before recording a result, **When** the claim's lease expires and a later tick runs, **Then** the target is reclaimed: if the interrupted step is one the provider declares safe to repeat it is retried (counting as an attempt); if it is a step that could have made the post public, the target is marked `ambiguous` instead and is not retried.
4. **Given** a tick whose lease was taken over by another tick, **When** the original tick finally tries to record its result, **Then** that result does not overwrite the current owner's state; it is still written to the attempt log so nothing is lost.
5. **Given** the tick endpoint, **When** it is called without the secret or with a wrong secret, **Then** it refuses (unauthorised) without revealing why or how close the guess was, and runs nothing; **When** called with the correct secret, **Then** it runs one tick and returns a summary of what that tick did (counts only, no content or credentials).
6. **Given** the tick endpoint secret is not configured, **When** the endpoint is called, **Then** it is disabled (responds as not available) rather than open.
7. **Given** the worker process, **When** it runs, **Then** it performs one tick, waits the configured interval, and repeats; on a shutdown signal it finishes its current tick and exits cleanly.
8. **Given** the in-process option is enabled for the web process, **When** the web app starts, **Then** it runs the same loop after startup completes; when disabled (default), the web process runs no ticks on its own.
9. **Given** `docker compose up`, **When** the stack starts, **Then** a `worker` service built from the same image as `web` runs the loop and the heartbeat advances, with no extra configuration beyond the existing `.env`.

---

### User Story 3 - Failures are handled honestly (Priority: P1)

Platforms fail in different ways. A temporary failure (timeout before
sending, platform overload, "try again later") is retried automatically with
growing delays, up to a cap, then the target is marked `failed` with the last
error. A permanent failure (rejected content, revoked permission) fails the
target at once. An outcome the engine cannot know — the final publish call
timed out, or returned something unreadable — marks the target `ambiguous`
and is never retried automatically. When some targets of a post publish and
others fail, the post shows as `partially_failed`, and the editor can retry
just the failed target without touching the ones that went out.

**Why this priority**: Honest failure handling is what makes unattended
publishing trustworthy, and "never blindly retry an unknown outcome" is a
non-negotiable rule in the constitution.

**Independent Test**: Using mock accounts configured for each failure mode,
run ticks with a controlled clock and verify retry times, the attempt cap,
immediate failure, the `ambiguous` state with no further calls, the
`partially_failed` post status, and that retrying one failed target leaves
published targets untouched.

**Acceptance Scenarios**:

1. **Given** a target whose provider returns a temporary error, **When** ticks run, **Then** the target is retried after an exponentially growing delay (base delay × 2^(attempts−1), never more than the configured maximum delay, and never earlier than a "not before" time the provider supplied), and each failure is recorded in the attempt log.
2. **Given** a target that keeps returning temporary errors, **When** it reaches the configured attempt cap, **Then** it becomes `failed` with the last error and is not retried again automatically.
3. **Given** a provider returns a permanent error, **When** the tick records it, **Then** the target becomes `failed` immediately, without retries.
4. **Given** a provider returns an ambiguous outcome, **When** the tick records it, **Then** the target becomes `ambiguous`, no later tick calls the provider for it again, and the post reflects that a target needs attention.
5. **Given** a post with two targets where one is `published` and the other `failed` (or `ambiguous`), **When** no targets remain pending, **Then** the post's status is `partially_failed`.
6. **Given** a `partially_failed` post, **When** an editor retries the failed target, **Then** only that target is reset (attempt count cleared, due now) and re-published by the next tick; the published target is not called again; when it succeeds the post becomes `published`.
7. **Given** an `ambiguous` target, **When** an editor checks the platform and resolves it, **Then** they can mark it as published (optionally with its URL) or as failed; only a target marked failed can then be retried. An ambiguous target cannot be retried directly.
8. **Given** any provider call, **When** it is recorded in the attempt log, **Then** the entry holds the target, step, a request summary, a response summary, the outcome and a timestamp, and never contains credentials or tokens.

---

### User Story 4 - A queue that is always correct (Priority: P2)

The queue behaves like a careful human assistant. Two people (or a person
and a generation job) queuing posts for the same account at the same instant
always get different slot occurrences. Slot times follow the project's wall
clock across daylight-saving changes: a 02:30 slot on the night clocks jump
forward goes out right after the jump; a 01:30 slot on the night clocks fall
back goes out once, at the first 01:30. An account with no active slots gets
a clear "no active posting slots" message instead of a guessed time. When a
queued post is cancelled, deleted or moved, its occurrence becomes free and
the next queued post can take it — but nothing else is reshuffled behind the
user's back. Instead, explicit actions exist: move a target to the next free
slot, swap two queued targets, and pull one account's queue forward to fill
gaps. Explicitly timed posts never consume slots, but the user is warned if
one lands close to a queued post on the same account. Upcoming empty slot
occurrences can be listed per account so gaps are visible.

**Why this priority**: The queue is the main way posts are scheduled, and
double-booking or DST mistakes are hard-to-spot errors that publish at the
wrong time. It ranks below P1 only because the simplest end-to-end path
(Story 1) already covers basic allocation.

**Independent Test**: Exercise the allocation service directly: concurrent
allocations for one account, DST transition dates in several zones, an
account with no or only paused slots, cancel-then-requeue, move/swap/pull
forward, explicit-time proximity warnings, and the empty-slots listing.

**Acceptance Scenarios**:

1. **Given** one account with free occurrences, **When** many queue requests for that account run concurrently, **Then** every request gets a distinct occurrence (guaranteed by a database constraint, not only application logic) and none fails because of the race (losers simply take the next free occurrence).
2. **Given** a slot at a local time that does not exist on a spring-forward date (e.g. 02:30 on the US or EU transition night), **When** that occurrence is assigned, **Then** its instant is the local time shifted forward by the length of the gap (02:30 → 03:30 for a one-hour gap).
3. **Given** a slot at a local time that occurs twice on a fall-back date (e.g. 01:30 in New York, 01:30 in London), **When** that occurrence is assigned, **Then** its instant is the earlier of the two, and the slot yields only one occurrence that day.
4. **Given** an account with no slots, or only paused slots, **When** a target for it is queued, **Then** that target fails with a clear message naming the account and the reason; other targets of the same post on other accounts are still queued; the preview shows the same message before confirming.
5. **Given** a queued target holding an occurrence, **When** it is cancelled, its post deleted, or it is moved, **Then** the occurrence becomes free, and the next queue request for that account can take it if it is the earliest free one.
6. **Given** a freed occurrence, **When** nothing else happens, **Then** no other queued target moves automatically.
7. **Given** a queued or explicitly scheduled target that has not started publishing, **When** the user moves it to the next free slot, **Then** it takes its account's earliest free occurrence after now and releases any occurrence it held.
8. **Given** two queued targets on the same account, **When** the user swaps them, **Then** they exchange occurrences atomically (no moment where either occurrence is double-held or a third request can steal one). Swapping targets on different accounts, or a target that is not queued, is refused with a clear message.
9. **Given** an account whose queue has gaps (freed or never-filled occurrences before later queued targets), **When** the user pulls that account's queue forward, **Then** its queued targets, in their current order, are moved into the earliest free occurrences from now on; no target moves later than it was; explicitly timed targets and other accounts are untouched.
10. **Given** an explicit time that falls within the configured warning window (default 30 minutes) of a queued target on the same account, **When** the user schedules or previews it, **Then** they receive a warning naming the nearby target and its time, and the schedule still succeeds.
11. **Given** an account with slots, **When** upcoming empty occurrences are listed for a date range, **Then** each free occurrence is returned with its UTC instant, local wall time and slot, in time order; occupied and paused-slot occurrences are excluded.
12. **Given** a project whose time zone is changed, **When** existing targets are inspected, **Then** their already-assigned instants are unchanged; only new assignments use the new zone.
13. **Given** an explicit time in the past, **When** a user schedules at it, **Then** it is refused with a message suggesting "publish now".

---

### User Story 5 - Platform limits and account health are respected (Priority: P2)

Platforms cap how much an account may publish (for example 100 or 250 posts
per rolling 24 hours). Docket enforces these caps itself before calling the
platform, deferring excess work instead of letting the platform reject it.
Accounts whose credentials expire are refreshed automatically shortly before
expiry; when a refresh fails, the account is flagged as needing
re-authorisation with the reason, and its due posts fail clearly rather than
being sent with dead credentials.

**Why this priority**: These protect real accounts once real providers
arrive (entries 4–5); the engine must already enforce them so providers
only declare their numbers.

**Independent Test**: With a mock account limited to N publishes per window,
make N+k targets due and verify only N start and the rest are deferred to the
time the window frees up; with mock accounts near expiry configured to
refresh successfully or fail, run a tick and verify new expiry or
`needs_reauth` with an error.

**Acceptance Scenarios**:

1. **Given** an account with a publish limit of N per rolling window, **When** more than N of its targets become due within one window, **Then** only N start publishing; the rest are deferred until the earliest moment the window has room, without counting an attempt and without calling the provider.
2. **Given** a provider default limit and a stricter per-account limit, **When** limits are enforced, **Then** the stricter one applies.
3. **Given** an account whose credentials expire within the configured refresh window and whose provider supports refreshing, **When** the token-refresh part of a tick runs, **Then** the credentials are refreshed, stored encrypted, the expiry is updated, and the account stays `active`.
4. **Given** a refresh that fails, **When** the tick records it, **Then** the account becomes `needs_reauth` with the reason (no secrets in the reason), and a failing refresh for one account does not stop other accounts' refreshes or the publishing part of the tick.
5. **Given** an account in `needs_reauth`, **When** one of its targets becomes due, **Then** the provider is not called; the target becomes `failed` with a message that the account must be reconnected, and can be retried after reconnection.
6. **Given** stored credentials, **When** any record, log line, attempt entry, error message or page is produced, **Then** the credentials never appear in it.

---

### User Story 6 - The operator can see whether the scheduler is alive (Priority: P2)

On a sleeping or misconfigured host the scheduler stops silently. Every
project page shows a small scheduler-health indicator with the time of the
last successful tick. When that time is older than a configurable threshold
(default 5 minutes), or no tick has ever run, the indicator becomes a loud,
unmissable warning that says what is wrong and how to fix it (start the
worker, enable the in-process loop, or point a cron at the tick endpoint).

**Why this priority**: Cheap to build and prevents the worst failure mode —
everyone believing posts are going out when they are not.

**Independent Test**: Render the app shell with a fresh heartbeat (quiet
indicator), an old heartbeat (warning) and no heartbeat (never-ran warning).

**Acceptance Scenarios**:

1. **Given** the publishing part of the scheduler completed within the threshold, **When** any member views a project page, **Then** a quiet indicator shows the last successful tick (relative and in the project's time zone).
2. **Given** the last successful tick is older than the threshold, **When** a member views any project page, **Then** a prominent warning is shown, announced to assistive technology, stating how long ago the scheduler last ran and listing the ways to run it.
3. **Given** no tick has ever completed, **When** a member views a project page, **Then** a warning says the scheduler has never run, with the same guidance.
4. **Given** a tick in which individual targets failed but the tick itself completed, **When** the heartbeat is written, **Then** it still counts as a successful tick (the heartbeat measures whether the scheduler runs, not whether posts succeed); a tick that crashes does not update it.
5. **Given** separate scheduler sections (publishing, token refresh), **When** they run, **Then** each records its own last-success time, and the indicator is driven by the publishing section.

---

### User Story 7 - A developer adds a platform by adding one folder (Priority: P3, developer-facing)

A developer adding Bluesky, Facebook, Instagram or Threads later creates one
folder with the provider's declaration — name, capabilities (text limit and
how text is counted, image count, allowed file types and sizes, whether media
is required or text-only is allowed, supported post types), how accounts
connect, optional credential refresh, content validation and the step-by-step
publish routine — and adds one line to the registry. The scheduler, post
services, queue and schema need no changes. A written guide explains the
contract, the meaning of each publish result, the rules for when to report
"ambiguous", and the rule against logging secrets. The `mock` provider is
built exactly this way and serves as the worked example.

**Why this priority**: The owner's stated top priority for long-term
quality, but it delivers value only when the next provider is added; the
mock provider proves it now.

**Independent Test**: Verify the mock provider lives entirely in its own
folder plus one registry line; verify the shared text counters on emoji,
combining characters and multi-byte text; validate content against declared
capabilities and check the issues returned; follow the guide's checklist
against the mock.

**Acceptance Scenarios**:

1. **Given** the provider registry, **When** a provider is looked up by key, **Then** its declaration is returned; an unknown key yields a clear error, and a stored account whose provider is no longer registered fails its targets clearly instead of crashing the tick.
2. **Given** shared text counters, **When** they count the same text, **Then** they report graphemes (user-perceived characters), Unicode code points and UTF-8 bytes; e.g. a family emoji counts as 1 grapheme but several code points and many bytes.
3. **Given** content and a provider's capabilities, **When** it is validated, **Then** each problem is returned as an issue with a severity (error or warning), a machine-readable code, a human message, and the field it concerns (e.g. text over the limit with the count and the limit, too many images, disallowed file type, file too large, media required, text-only not allowed, unsupported post type).
4. **Given** a target whose content has validation errors for its provider, **When** a user tries to queue, schedule or publish it, **Then** it is refused with those issues; warnings do not block.
5. **Given** the mock provider, **When** an account is connected through its mock "connect", **Then** an account is created with a display name, a chosen behaviour and no credentials.
6. **Given** a mock account, **When** its behaviour is set to succeed, multi-step, temporary error (always or for the first N tries), permanent error, ambiguous, or platform rate-limited (temporary error carrying a "not before" time), **Then** publishing through it behaves accordingly, in tests and in the running app.

---

### Edge Cases

- **Two slots that resolve to the same instant** on one account (e.g. a
  02:30 slot shifted to 03:30 on spring-forward night while a 03:30 slot
  also exists): they form a single occurrence; only one target can hold it.
- **Duplicate slots**: an account cannot have two slots with the same weekday
  and local time.
- **Pausing or deleting a slot** with targets already assigned to upcoming
  occurrences: those targets keep their times; paused/deleted slots are only
  excluded from new allocation and from the empty-slots listing.
- **No free occurrence within the allocation horizon** (default 366 days,
  e.g. every occurrence taken): queueing fails with a clear message rather
  than looping.
- **Occurrence already in the past when a target is due**: a target whose
  time passed while the scheduler was down is published by the next tick
  (late rather than never); the attempt log records how late.
- **Cancelling a target mid-flight**: a target currently held by a tick
  cannot be cancelled (clear "publishing in progress" message); a multi-step
  target waiting between steps can be cancelled; published, failed and
  ambiguous targets cannot be cancelled.
- **Deleting a post** that has any published or in-progress target is
  refused (cancel the remaining targets instead); deleting a post otherwise
  frees all its occurrences.
- **All targets of a post cancelled**: the post returns to `draft`.
- **A post in `needs_review`** cannot be queued, scheduled or published until
  approved; `draft` and `approved` posts can.
- **Editing a scheduled post's content**: allowed while no target has started
  publishing; the edited content is re-validated and targets that would no
  longer validate are refused with the issues.
- **A multi-step publish that never finishes** (provider keeps returning
  "continue"): after a configurable maximum duration since its first step
  (default 24 hours) the target becomes `failed` with "publishing did not
  complete".
- **A provider call that hangs**: every provider call has a timeout shorter
  than the lease, so a live tick never loses its lease to a slow call; a
  timeout is reported by the provider as temporary (before anything was
  sent) or ambiguous (after the publish request was sent).
- **Clock skew between machines**: due-ness, leases and backoff are judged by
  the database's clock, not each process's local clock.
- **A provider throws instead of returning a result**: treated as a
  temporary error for steps declared safe to repeat, and as ambiguous for
  steps that could have made the post public.
- **Schema not migrated yet when the worker starts** (Compose start-up
  order): the worker waits and retries rather than crashing in a loop.
- **The tick endpoint called very often or concurrently**: safe by the same
  claiming rules; each call is bounded by the same budgets.
- **Account removed while targets are queued**: its unpublished targets are
  cancelled and their occurrences freed; published history is kept.
- **Media referenced by a target**: alt text travels with each image to the
  provider; an asset is marked as used once attached to any post.

## Requirements *(mandatory)*

### Functional Requirements

**Records and project isolation**

- **FR-001**: The system MUST store, per project, social accounts with: provider key, display name, external account id, encrypted credentials (optional, absent for the mock), credential expiry, status (`active` | `needs_reauth`), last error, and publish-limit settings (a count per rolling window, optional, overriding the provider default only if stricter).
- **FR-002**: The system MUST store, per project, media assets with: storage key, public URL, file type, width, height, byte size, alt text, and when it was first used in a post. This feature does not upload or store files.
- **FR-003**: The system MUST store, per project, posts with: status (`draft` | `needs_review` | `approved` | `scheduled` | `publishing` | `published` | `partially_failed` | `failed`), base content, origin (`manual` | `generated` | `api`), free-form generation metadata, and an ordered list of attached media assets.
- **FR-004**: The system MUST store one target per post per social account with: scheduled UTC instant, how it was scheduled (`slot` | `explicit` | `now`), the slot occurrence it holds (if any), optional per-platform content override, step-machine state, status (`draft` | `scheduled` | `publishing` | `published` | `failed` | `ambiguous` | `cancelled`), external post id and URL, attempt count, next attempt time, lease expiry and lease holder, and last error. A post cannot have two targets for the same account.
- **FR-005**: The system MUST store, per account, weekly posting slots with weekday, local time and a paused flag.
- **FR-006**: The system MUST keep an append-only publish attempt log per target recording step, request summary, response summary, outcome and timestamp; entries are never updated or deleted by the application and never contain credentials or tokens.
- **FR-007**: The system MUST record, per scheduler section, the time of the last successful run. This is the one new system-wide (not project-owned) record and MUST be registered as such with the scope-enforcement registry.
- **FR-008**: Every new project-owned table MUST carry the project scope, be registered with the scope-enforcement test, and be reachable only through the scoped data-access layer. The scheduler, which works across projects, MUST do so through the data-access layer's explicit cross-project mechanism, naming its reason, and MUST still act on each target within that target's project.
- **FR-009**: Role rules: owners and admins manage social accounts (connect, disconnect, limits) and posting slots; editors, admins and owners create and edit posts and queue, schedule, publish now, move, swap, pull forward, cancel, retry and resolve targets. Enforced in the data-access layer.

**Provider framework**

- **FR-010**: The system MUST define a provider contract with: key, display name, capabilities (text limit and counting rule — graphemes, code points or UTF-8 bytes; max images; allowed file types; max bytes per file; whether media is required; whether text-only posts are allowed; supported post types `text`, `image`, `carousel`, extensible to `video`, `story`, `reel` without changing the contract's shape), a default publish limit (optional), connect strategy (`oauth` | `credentials` | `manual-token`), optional credential refresh, content validation returning issues, and a publish step routine.
- **FR-011**: Each publish step MUST return exactly one of: continue (with new state and optional "not before" time), done (external id, optional URL), temporary error (message, "not before" time), permanent error (message), or ambiguous (message). Providers MUST declare which of their steps could make a post public, so the engine knows when an interruption must become `ambiguous`.
- **FR-012**: The system MUST provide a provider registry; adding a provider MUST require only a new provider folder and one registry line, with no changes to the scheduler, post services, queue service or schema.
- **FR-013**: The system MUST provide shared text-counting utilities for graphemes, Unicode code points and UTF-8 bytes, used by every provider's validation.
- **FR-014**: The system MUST provide a written guide for adding a provider: the contract, capability fields, connect strategies, the step results and when to use each (especially ambiguous), state persistence between steps, limits, refresh, testing with mocked HTTP only, and the no-secrets rule.
- **FR-015**: The system MUST include a `mock` provider built through the same contract, with a mock connect that creates an account without credentials and per-account configurable behaviour: succeed, multi-step (N continue steps then done), temporary error (always or first N attempts), permanent error, ambiguous, platform rate-limited, and credential refresh succeed/fail. It MUST be usable in tests and in the running app for offline development, and MUST be hidden from connection choices in production unless explicitly enabled.

**Slot allocation (one service for every caller)**

- **FR-016**: The system MUST compute slot occurrences from each slot's weekday and local time in the project's time zone, converting to UTC at assignment time. Local times that do not exist (spring-forward gap) MUST resolve forward by the length of the gap; local times that occur twice (fall-back overlap) MUST resolve to the earlier instant. This rule MUST be recorded in the decisions log.
- **FR-017**: Allocating "next free occurrence" for a target MUST pick the earliest occurrence after now for the target's account, among active (non-paused) slots, that no other live target holds, within a bounded horizon (default 366 days).
- **FR-018**: Allocation MUST be transactional and backed by a database uniqueness rule on (account, occurrence instant) among live slot-held targets, so concurrent requests from any caller can never hold the same occurrence; a request that loses a race MUST move on to the next free occurrence instead of failing.
- **FR-019**: Queueing a target for an account with no active slots, or with no free occurrence within the horizon, MUST fail for that target with a clear, specific message; it MUST NOT guess a time.
- **FR-020**: Cancelling, deleting or moving a target MUST free its occurrence; freed occurrences MUST be reusable by later allocations; no other target MUST be moved automatically.
- **FR-021**: The system MUST provide explicit actions: move a target to its account's next free slot; swap two queued targets on the same account atomically; pull one account's queue forward (move its queued targets, preserving order, into the earliest free occurrences from now, never later than their current time).
- **FR-022**: Scheduling at an explicit time MUST NOT consume a slot occurrence, MUST refuse times in the past, and MUST return a warning (not an error) when the time is within a configurable window (default 30 minutes) of a queued target on the same account.
- **FR-023**: The system MUST list upcoming empty slot occurrences per account for a requested range, with UTC instant, local wall time and slot.

**Post services (one service for every caller)**

- **FR-024**: The system MUST let callers create and update draft posts (base content, origin, generation metadata, ordered media, target accounts, per-target overrides) and delete posts per the edge-case rules.
- **FR-025**: The system MUST provide a queue preview that returns, per target, the proposed instant and local time, or the reason it cannot be queued, plus any validation issues — without reserving anything; and a confirm action that allocates and returns the actual times, flagging differences from the preview.
- **FR-026**: The system MUST provide schedule-at-explicit-time and publish-now actions for a post's targets.
- **FR-027**: Queue, schedule and publish-now MUST validate each target's effective content (override, else base content, plus media) against its provider's capabilities and refuse targets with error-level issues.
- **FR-028**: The system MUST provide cancel-target, retry-failed-target (resets attempt count and makes it due now; only for `failed` targets) and resolve-ambiguous-target (mark published with optional URL, or mark failed) actions.
- **FR-029**: Post status MUST be derived from its targets whenever a target changes: ignoring cancelled and unscheduled targets — if none remain, the post keeps or returns to its editorial status (`draft`, `needs_review` or `approved`; all-cancelled returns to `draft`); else if any target is publishing → `publishing`; else if any is scheduled → `scheduled`; else if all are published → `published`; else if none are published → `failed`; otherwise → `partially_failed`. Ambiguous targets count as not published.

**The scheduler tick**

- **FR-030**: The system MUST provide one tick operation that does a bounded amount of work, limited by a configurable time budget (default 20 seconds) and item budget (default 25 targets), and returns a summary (counts per outcome, no content or secrets).
- **FR-031**: The tick MUST claim due targets in a short transaction that skips rows other ticks hold and sets a lease (holder and expiry, default 5 minutes, always longer than the time budget plus the provider-call timeout); it MUST call providers outside any open database transaction and then record the result only if it still holds the lease.
- **FR-032**: The tick MUST persist step state after every continue result and schedule the next step no earlier than the provider's "not before" time.
- **FR-033**: Temporary errors MUST be retried with exponential backoff (default base 60 seconds, doubling, capped at 1 hour, no earlier than the provider's "not before") up to a configurable attempt cap (default 5), after which the target is `failed`.
- **FR-034**: Ambiguous results MUST mark the target `ambiguous`; no automatic process may call the provider for an ambiguous target again.
- **FR-035**: The tick MUST recover targets whose lease expired: retry the interrupted step if the provider declared it safe to repeat (counting an attempt), otherwise mark the target `ambiguous`.
- **FR-036**: The tick MUST enforce per-account publish limits before calling the provider (counting publishes started within the rolling window, including in-flight ones), deferring excess targets to when the window has room, without counting an attempt.
- **FR-037**: The tick MUST include a separate token-refresh section, with its own share of the budget, that refreshes credentials expiring within a configurable window (default 72 hours) for providers that support it, stores them encrypted, and on failure marks the account `needs_reauth` with a secret-free reason. Failures in one section or for one account MUST NOT stop the others.
- **FR-038**: Due targets on `needs_reauth` accounts, or on accounts whose provider is not registered, MUST NOT call a provider and MUST become `failed` with a clear message.
- **FR-039**: The tick MUST write each section's heartbeat when that section completes, even if individual targets failed; a crashed section MUST NOT update its heartbeat.
- **FR-040**: The tick MUST be safe to run concurrently from any number of processes and safe to kill at any point, with time judged by the database clock.
- **FR-041**: A multi-step publish MUST fail with "publishing did not complete" if it is still unfinished a configurable time (default 24 hours) after its first step.

**Triggers and configuration**

- **FR-042**: The system MUST provide a worker entry point, built into the same container image as the web app, that runs a tick, waits a configurable interval (default 60 seconds, allowed 30–60), and repeats; it MUST stop cleanly on shutdown signals after finishing the current tick, and wait for the database schema to be ready on start.
- **FR-043**: The system MUST provide an internal HTTP tick trigger, accepting only POST, authenticated by a shared secret compared in constant time, that runs one tick and returns its summary; when the secret is not configured the trigger MUST be disabled. The secret MUST be at least 32 characters.
- **FR-044**: The system MUST let the operator enable running the worker loop inside the web process (default off), started after the existing start-up sequence.
- **FR-045**: Docker Compose MUST gain a `worker` service using the same image as `web`, started after the web service has applied migrations.
- **FR-046**: Every new setting MUST be validated at start-up (failing loudly with the variable named) and documented in `.env.example`: tick secret, worker interval, in-process loop toggle, tick time and item budgets, lease duration, attempt cap, backoff base and maximum, token-refresh window, stale-heartbeat threshold, explicit-time warning window, multi-step maximum duration, and the mock-provider toggle.

**Health indicator**

- **FR-047**: The project app shell MUST show a scheduler-health indicator with the last successful publishing tick and a loud, accessible warning when it is older than a configurable threshold (default 5 minutes) or has never run, including guidance on how to run the scheduler. It is visible to every project member and reveals no secrets or configuration values.

**Documentation and decisions**

- **FR-048**: The decisions log MUST gain entries for this feature's judgement calls (at least: the DST rule, backoff and attempt defaults, lease and recovery rules, limit counting, post status derivation, "chars" meaning code points, needs_reauth handling, the heartbeat being system-wide, mock provider gating). The README MUST describe the three ways to run the scheduler and the health indicator.

### Key Entities

- **Social account**: a connection to one platform account within one project. Has a provider, a status, optional encrypted credentials with expiry, publish-limit settings, and last error. Owns posting slots and targets.
- **Media asset**: a file registered in a project (storage comes later) with dimensions, size, type, alt text and first-used time. Attached to posts in order.
- **Post**: the thing a user writes once. Has base content, origin, generation metadata, ordered media and a status derived from its targets plus its editorial state.
- **Post target**: one post going to one account. Holds when and how it is scheduled, the slot occurrence (if queued), content override, step state, publishing status, lease, attempts, external id/URL and last error. The unit the scheduler works on.
- **Posting slot**: a weekly weekday + local time for one account, pausable.
- **Slot occurrence**: a concrete dated instance of a slot (account + instant), held by at most one live target. Not stored on its own; identified by account and instant on the target that holds it.
- **Publish attempt**: an immutable log entry of one provider call or recovery event for a target.
- **Scheduler heartbeat**: system-wide last-success time per scheduler section (publishing, token refresh; later generation).
- **Provider**: a plug-in declaration (capabilities, connect strategy, validation, step routine, optional refresh, default limit). Lives in code, not in the database.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With the mock provider and no real accounts, a post can go from draft to queued to published with no manual steps after confirming, and is published within one scheduler interval (≤ 60 seconds by default) of its slot time.
- **SC-002**: With 5 ticks running at once over 200 due targets, every target is published exactly once — 0 duplicate provider "done" calls across 20 repeated runs.
- **SC-003**: With 50 simultaneous queue requests for one account, 50 distinct occurrences are assigned and 0 occurrences are held twice, across 20 repeated runs.
- **SC-004**: Every tick returns within its time budget (default 20 seconds, so well under 30) even with 1,000 due targets and a provider that is deliberately slow.
- **SC-005**: A target whose tick was killed is recovered (retried or marked ambiguous per its step) within one lease duration plus one scheduler interval.
- **SC-006**: 0 ambiguous targets are ever called again automatically.
- **SC-007**: For spring-forward and fall-back dates in at least two time zones (including New York and London, plus one southern-hemisphere zone), 100% of affected occurrences resolve to the instant defined by the DST rule.
- **SC-008**: Temporary failures are retried at the expected times (within one scheduler interval of the computed backoff) and stop after exactly the configured number of attempts.
- **SC-009**: An account's publishes never exceed its effective limit in any rolling window, in tests that make twice the limit due at once.
- **SC-010**: A stale or never-run scheduler is visible on every project page within one page load once the threshold passes.
- **SC-011**: The mock provider is added by one folder plus one registry line, and a reviewer following the adding-a-provider guide can identify every contract obligation without reading scheduler code.
- **SC-012**: Scans of attempt logs, errors, account records as returned to callers, and rendered pages in tests find 0 occurrences of stored credentials or tokens.
- **SC-013**: `docker compose up` starts `postgres`, `web` and `worker` from one image, and the health indicator shows a recent tick within two minutes of start.

## Assumptions

- **Entry 1 is the base**: projects (with IANA time zone), members, roles, the scoped DAL (`forProject`, `crossProject`), the scope-enforcement registry and test, the secrets-at-rest helper and Zod env validation all exist and are reused, not rebuilt.
- **"All project-scoped"** in the input applies to every new table except the scheduler heartbeat, which is inherently system-wide (one scheduler serves all projects); it is registered in the not-project-owned list instead.
- **Screens are out of scope**: no composer, calendar, post list, accounts or slots screens, no media upload/storage, no failures view. Stories are exercised through services, the scheduler entry points, tests and the health indicator. Entry 3 builds the screens on these services.
- **No real providers** in this feature; Bluesky and Meta entries implement them against this contract. Per-provider limits quoted in research (Instagram 100 / 24 h, Threads 250 / 24 h) are provider defaults those entries will declare.
- **Editorial statuses** (`needs_review`, `approved`) are set by the generator's approval policy later; manual drafts can be queued directly by editors.
- **"chars"** in the counting rule means Unicode code points (not UTF-16 code units); recorded as a decision.
- **Backoff has no random jitter**, so retry times are predictable and testable at Docket's small scale.
- **Late posts are sent late, not dropped**: a target whose time passed while the scheduler was down is published on the next tick.
- **A cancelled post goes back to `draft`** rather than to `approved`; re-queueing it is one action.
- **Retry of a failed target** makes it due now; choosing a new time is done with move/schedule actions.
- **Resolving ambiguous targets** is provided as a service action now (so ambiguity is never a dead end); the screen that surfaces them belongs to the hardening entry.
- **Defaults** (all configurable): tick time budget 20 s, item budget 25, lease 5 min, attempt cap 5, backoff 60 s doubling to 1 h, token-refresh window 72 h, stale threshold 5 min, explicit-time warning window 30 min, multi-step maximum 24 h, allocation horizon 366 days, worker interval 60 s (30–60), in-process loop off, mock provider enabled outside production.
- **Worker start-up order**: the web service applies migrations; the worker starts after the web service is healthy and waits for the schema if needed.
- **Neon compatibility** holds: claiming uses row locks with skip-locked inside short transactions, which work through Neon's transaction-mode pooler; no session-level database features are used.
- **Dependencies**: `@js-temporal/polyfill` is already installed (decision 19); no new runtime dependency is expected.
