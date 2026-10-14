# Feature Specification: Standing content series that keep producing posts on a cadence

**Feature Branch**: `071-evergreen-series`

**Created**: 2026-10-13

**Status**: Draft

**Input**: User description: "Generation jobs today are finite: a job is built from a fixed source, the runner works through its items, and it is closed. A content backlog needs the opposite — a standing series that keeps emitting posts on a cadence until someone stops it. Add a recurring series (committed migration) holding projectId, name, the voiceProfileId and template/templateFields shape generation_jobs already uses, the target accounts, a cadence (how many posts per period, which period), the approval and scheduling policy to apply, an enabled flag, and lastRunAt/nextRunAt. A worker pass — in the existing scheduler/worker loop rather than a new process — wakes due series, generates the period's posts through the existing generation path (so prompts, schema validation, failures and the credit hold all behave exactly as a manual Generate does), and applies the project's approval and scheduling policy through the one policy function — meaning a validation failure still forces review even under auto-approve, which is intended behaviour and must not be routed around. Posts set to queue use the existing allocator so they land in the account's real posting slots and never double-book. Where a target account requires media (Instagram, TikTok), the series either draws from a configured media pool or, when the project has image generation configured, generates one per post through the ImageGenerator implemented in image-generation; a series that cannot satisfy its media requirement records the reason and skips that post rather than emitting an invalid one. Idempotency and concurrency are part of this entry: a series must not double-generate when two worker ticks overlap or the process restarts mid-run, and must be bounded per tick. UI: a Series section under the existing Batch jobs area to create, pause, resume and delete a series and see its recent runs and failures; owner/admin only for create/edit, enforced server-side. Tests: cadence firing and not firing, restart and overlapping-tick idempotency, policy application, no slot double-booking across concurrent series, media-required skip, generation failure handling, credit hold pausing a series cleanly, project isolation and authz. Update docs/generator.md and docs/decisions.md. This entry does NOT add date-pegged occurrences — dated-series builds that on the cadence engine defined here — and does NOT change one-off Generate or the existing finite batch jobs beyond shared refactoring."

## Context and sources

This is the third entry of the content-engine roadmap. It follows `brand-profile-fields` (a project now holds its own tagline, description and website, and generation prompts carry them) and `image-generation` (the declared `ImageGenerator` contract is implemented and a generated image lands in the media library as an ordinary asset). It precedes `dated-series`, which adds a second occurrence rule — anniversaries from a spreadsheet — on the cadence engine this entry defines.

### Behaviour on `main` that this feature builds on

- **Generation is finite in both existing shapes.** A *batch job* is created from a fixed source (CSV rows, picked or filtered media, API submissions), holds a frozen list of items, and is closed when the last one finishes. An *in-request series* asks the model for 2–10 distinct angles, stores the edited plan, then writes one post per angle while the person waits. Neither produces anything after it finishes; repeating means a human creating it again.
- **A job authorises its policies once, at creation.** Approval and scheduling policy are resolved against the creating member's role, and auto-approve combined with add-to-queue needs an explicit confirmation. Every item afterwards is generated under the policy stored on the job, with no further role check.
- **One policy decision, one place.** A freshly saved post is approved, approved-and-queued, or left in review by a single function. A target that fails content validation forces the whole post to review even under auto-approve; an account that is merely unavailable does not.
- **Queueing never double-books.** A queued target takes the earliest free occurrence of its account's posting slots by trying candidates one at a time against a uniqueness constraint; a loser walks on to the next candidate. Holds are taken in a fixed account order so two posts sharing accounts cannot deadlock.
- **The worker is one loop of bounded sections.** A tick runs publishing, token refresh, batch generation, housekeeping, webhooks and email concurrently under one deadline, each catching its own failure. Batch items are claimed with skip-locked rows plus a lease and an attempt count, so overlapping ticks never take the same item and a killed process is recovered when its lease expires. Claims are gated by the credit hold: when a credential owner has been refused on billing, its items are not claimed at all, bar one probe every five minutes.
- **A billing refusal never fails anything.** It sets or refreshes a hold on the credential owner actually used, every other outcome clears it, and the affected work waits with a notice naming billing as the cause.
- **Media requirements are provider-declared.** Instagram and TikTok declare media required; Facebook, Threads, Bluesky and X do not. The requirement is enforced by the shared validator used by both the scheduling gate and the publish engine, while per-platform size, format and aspect handling is done by the media planner, which adapts what it can and refuses what it cannot.
- **A generated image is an ordinary asset.** Image generation is configured independently of text generation, spends the project's own credential when it has one, takes the same credit-hold path on a billing refusal, is recorded in the usage ledger, and lands in the media library with provenance. Nothing but the person's prompt and a fixed real-people instruction is sent to the image provider.
- **Project isolation is structural.** Every project-owned read and write goes through the scoped data-access layer, which resolves membership and role on each call; a lint rule and a test keep raw database access out of routes, services, jobs and the API.

### Facts, and what is not verified

- Which providers require media comes from `docs/limits.md` and the provider capability declarations, not from memory: required for Instagram and TikTok, not required for Facebook, Threads, Bluesky and X.
- Period boundaries and daylight-saving behaviour are computed in the project's own time zone through the installed Temporal polyfill with explicit disambiguation, as every other scheduled time in the product already is.
- No live model or provider call is made by any test in this entry. Model behaviour is exercised through the same seams the existing generation tests use; anything needing real credentials is reported as verified with mocks only.
- Throughput wording in documentation is derived from the per-call latency already recorded in `docs/generator.md`. This entry measures nothing new against a live API.

## Decisions made while specifying

Everything below was decided here rather than left open, and every one of them belongs in `docs/decisions.md` as this entry's spec decisions (W1–W34).

### What a standing series is, and what it is called

- **W1 — "Standing series", a new word.** The product already shows the word *Series* for the in-request, 2–10-angle generation started from Generate. Reusing it for a thing that lives forever and runs in the background would make both unreadable. The new object is a **standing series** everywhere — screens, documentation and the decisions log — and the existing in-request one keeps the bare word *Series*. The new section under Batch jobs is titled **Standing series**.
- **W2 — A standing series is configuration, not a work list.** It holds what to generate and how often, and nothing about any particular post. Each time it fires it opens a **run**, and the run is the thing that carries positions, counts, outcomes and failures. This is what makes the engine reusable: `dated-series` adds a second way to decide when a run opens, and changes nothing else.
- **W3 — The stored shape deliberately mirrors a batch job.** The series carries the project, a name, a voice profile, the `template`/`templateFields` pair, the target account ids, the resolved approval and scheduling policy, an enabled flag, and `lastRunAt`/`nextRunAt`. Keeping the template pair even though nothing fills it yet (W4) is what lets `dated-series` feed per-occurrence fields in without a second migration.
- **W4 — No per-run data fields in this entry.** `templateFields` is empty for every series created here, so the template may contain no placeholders and one is refused at creation with the same wording a batch job uses for an unknown placeholder. The template is the per-post instructions and obeys the same length limits a job's instructions do.
- **W5 — A series also stores a brief.** The instructions template says *how* to write; the brief says *what the series is about*, and the planning call needs it. It is bounded like the existing brief.
- **W6 — A name is required and unique within a project.** Two standing series called "Weekly tips" in one project cannot be told apart in a list, a run history or a failure line. Names are 1–100 characters, trimmed, and unique per project, case-insensitively.

### Cadence

- **W7 — A cadence is a count and a period: N posts per day, week or month.** Nothing finer than a day and nothing coarser than a month: an hourly series is a rate-limit problem rather than a content plan, and a quarterly one is better expressed as a dated series.
- **W8 — N is 1 to 10 per period.** The upper bound matches the existing in-request series maximum, which is the largest set of distinct angles the planner is trusted to produce, and keeps one series from monopolising the worker.
- **W9 — Period boundaries are the project's local day, week or month.** Weeks start on Monday, months on the 1st, all in the project's time zone, resolved through Temporal with explicit disambiguation. A series created mid-period is first due at the *next* boundary, so enabling one does not immediately spend credit on a partial period.
- **W10 — At most one run per period, and no backfill.** `nextRunAt` is always a period boundary. When the worker has been down across several boundaries, the missed periods are *not* backfilled: the series records that it missed them and jumps to the current period. A content backlog that wakes up and dumps three weeks of posts into the queue is worse than one that admits it lost three weeks.
- **W11 — A new period closes a still-open run.** At most one run per series is open at a time. If the next boundary arrives while a run is still producing, that run is closed as incomplete, with its counts recorded, and the new period's run opens. Otherwise a slow or unsatisfiable series accumulates runs forever.
- **W12 — Pausing stops new runs and stops the open run producing more.** Posts already produced are untouched. Resuming sets `nextRunAt` to the next boundary — never to a missed one — so a series paused for a month does not fire the moment it is resumed.
- **W13 — Deleting a series keeps its posts.** Posts are real content; a configuration object should not be able to destroy them. Deleting removes the series and its run history and leaves every post it produced exactly where it is. Deletion is immediate and final, and requires the same permission as creating one.

### How a run produces the period's posts

- **W14 — A run of two or more posts plans its angles first, through the existing planning call.** This is the whole reason the existing series path is named in the brief: without it, five posts a week from one fixed instruction are five near-identical posts. A run of exactly one post skips planning and takes the single-post path, because the existing planner refuses a count below two.
- **W15 — The plan is stored on the run before any post is written.** A restart must not re-plan: the angles the run already committed to are the angles it finishes with, so a resumed run produces the posts it was going to produce rather than a fresh set.
- **W16 — The plan is told which angles the series has already used.** The most recent prior runs' angle titles (bounded to a small, fixed number of titles) are passed as titles to avoid, through the same prompt mechanism that already keeps angles distinct *within* one plan. A standing series that repeats itself every week is not worth running, and this is the smallest change that prevents it. The golden prompt tests are updated accordingly.
- **W17 — Each post of a run goes through the existing generation path unchanged.** Same prompt composition, same brand context and voice profile ordering, same output schema and one correction retry, same failure vocabulary, same usage ledger, same credit-hold wrapper. There is no series-specific prompt, no series-specific validation and no series-specific failure kind.
- **W18 — The voice profile's current version is taken at run time.** Editing a voice profile changes future posts and never rewrites past ones; each post records the version it actually used, as every generated post already does.
- **W19 — A position is produced at most once.** Each post a run writes is tied to that run and position by a uniqueness constraint. A writer that loses the race re-reads the winner and reports it, exactly as the in-request series already does for its positions, so overlapping ticks and restarts cannot produce two posts for one position.
- **W20 — A temporary failure retries on a later tick; a lasting one does not.** Timeouts, rate limits and unavailability reuse the existing attempt count and backoff and are retried within the run. A refusal or an unusable output is recorded as a failure for that position and the run moves on. The run closes when every position has a post, a lasting failure or a skip.

### Policy, queueing and the things that must not be routed around

- **W21 — Policies are authorised once, when the series is created or edited, and stored on it.** This is how batch jobs already work and it is the only honest option: the member who set a series to auto-approve may not be a member at all by the time it fires. Auto-approve plus add-to-queue needs the same explicit confirmation a job needs, and a member without the auto-approve permission cannot select it.
- **W22 — The one policy function decides every post, with no bypass.** A validation failure forces review even under auto-approve. This is intended behaviour, not a defect to work around: a standing series is exactly the case where nobody is watching, so a post that would be refused at publish time must stop and wait for a human.
- **W23 — Queued posts take real slots through the existing allocator, inside the policy transaction.** Two series of the same project firing in the same tick, or two workers, therefore cannot land on one occurrence: the loser walks to the next free one. A post whose account has no free occurrence inside the queue horizon stays as a draft with that reason recorded; it is not retried into a different policy.
- **W24 — A series never schedules at an explicit time.** It either leaves posts as drafts or queues them into the account's slots. Picking times is what slots are for.

### Media

- **W25 — A series declares one media source: none, a pool, or generate.** *Pool* draws from the project's media library, optionally narrowed by a tag. *Generate* makes one image per post through the declared image-generation contract. *None* attaches nothing.
- **W26 — A pooled image is reserved like a batch job's image.** One unused image per post, reserved inside the write so no other series, job or run can take the same asset, and videos are never eligible. An image the per-platform planner refuses outright counts as not satisfying the requirement.
- **W27 — A generated image uses a prompt stored on the series.** It is the person's own wording, bounded by the same prompt limit the image feature already enforces, and it is sent with the fixed real-people instruction and nothing else — no post text, no brand fields, no voice profile. Sending the generated post text to an image provider would break the rule the image entry set deliberately.
- **W28 — A post whose media requirement cannot be satisfied is skipped whole, with the reason recorded.** When any target account of the series requires media and the series cannot produce an image for that post — pool exhausted, pool empty, image generation not configured, image generation failed, planner refused the only candidate — that position is skipped, no post is written, and the reason names the account whose requirement failed. Skipping the whole post rather than dropping one target keeps the "never emit something that cannot publish" rule in one place and avoids silently producing a post that is missing the channel the series exists for. The consequence — a mixed series stops producing entirely when its pool runs dry — is made obvious in the interface rather than hidden.
- **W29 — A skip is not a failure.** It is a neutral, recorded outcome with its own reason, as an already-posted batch item already is, and it does not count an attempt or make a run "completed with failures".

### The worker pass

- **W30 — A new bounded section of the existing tick, not a new process.** It is claimed, leased, skip-locked, kill-safe and deadline-aware exactly like the batch section, it reports its own counts in the tick summary and heartbeat, and a failure in it cannot take down publishing. No queue, no Redis, no second loop, no session-level Postgres feature.
- **W31 — Its per-tick budget is its own and additive.** A separate, documented limit bounds how many series are claimed per tick and how many posts a claimed series may produce in one tick. It does not borrow the batch section's limit, because a quiet batch queue should not change how fast a series runs — but `docs/generator.md` must state plainly that enabling standing series raises the install's total concurrent model calls, and how to bound it.
- **W32 — Claims rotate, oldest-due first.** One series with ten posts a day must not starve nine others, and one project must not starve another.
- **W33 — A credit hold pauses a series cleanly, with no state to clear.** A held credential owner's series is not claimed at all; nothing is generated, no attempt is counted, no failure is recorded, `nextRunAt` is not advanced and the open run stays open. The existing probe restores it with nothing else done, and the interface names billing as the cause and says since when. A billing refusal reached mid-run behaves the same: the position goes back to be retried with no attempt counted.
- **W34 — A series that produces nothing three runs in a row pauses itself, with the reason.** A broken series — an unreadable key, an empty pool, a disconnected account — should stop asking rather than burn a provider bill every period and fill the failure list forever. The pause is visible, says why, and is undone by the same Resume control a person's pause is.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - An owner sets up a weekly series and it keeps producing (Priority: P1)

An owner of a project that already has a connected account, posting slots and a voice profile creates a standing series: a name, what it is about, the instructions, the voice profile, the accounts to post to, three posts a week, and whether those posts should go to review or be approved and queued. From then on, without anyone opening the app, the series produces three posts a week into the project.

**Why this priority**: This is the feature. Everything else in this entry exists to make this safe.

**Independent Test**: Create a series, advance the clock past the next period boundary, run the worker, and find the period's posts in the project with the policy that was configured — then advance a further period and find the next set, with different angles.

**Acceptance Scenarios**:

1. **Given** an enabled series of 3 posts a week whose next due time has passed, **When** the worker runs enough ticks to finish the run, **Then** exactly 3 posts exist for that period, each generated through the ordinary generation path, and the series records when it last ran and when it is next due.
2. **Given** that same series immediately after a completed run, **When** the worker runs again before the next boundary, **Then** no further post is produced and nothing about the series changes.
3. **Given** a series whose period has produced its posts, **When** the following period becomes due and runs, **Then** its angles are not the same as the previous period's.
4. **Given** a series of exactly 1 post a period, **When** it runs, **Then** one post is produced with no planning call made.
5. **Given** a series created halfway through a week, **When** the worker runs before the next boundary, **Then** nothing is produced and the series is shown as next due at the coming boundary.

---

### User Story 2 - Policy is applied, and a bad post still stops (Priority: P1)

A project under review-required gets posts waiting in Review. A project that has chosen auto-approve and add-to-queue gets posts already sitting in real posting slots. Either way, a post the product knows would be refused at publish time waits for a human instead of being queued.

**Why this priority**: An unattended generator that can queue an invalid post is worse than no generator. This is the behaviour the brief says must not be routed around.

**Independent Test**: Run the same series configuration under each policy pair and assert the review state, the queued-or-draft outcome and the recorded reason on each produced post; then force a validation failure and assert it went to review under auto-approve.

**Acceptance Scenarios**:

1. **Given** a series stored with review-required, **When** a run produces a post, **Then** the post is waiting in Review, is not approved and is not in any slot.
2. **Given** a series stored with auto-approve and add-to-queue, **When** a run produces a post that validates, **Then** the post is approved and each of its targets holds a real occurrence of its account's slots, with the decision and its reason recorded on the post.
3. **Given** a series stored with auto-approve and add-to-queue, **When** a run produces a post that fails content validation for one of its targets, **Then** the post is left in review, is not queued, and the recorded reason names the validation problem.
4. **Given** a series stored with auto-approve and leave-as-draft, **When** a run produces a post, **Then** the post is approved and remains a draft in no slot.
5. **Given** a member who may not auto-approve, **When** they attempt to create or edit a series with auto-approve by any route, **Then** the server refuses it regardless of what the interface offered.

---

### User Story 3 - Nothing is produced twice, whatever the worker does (Priority: P1)

Two workers tick at once; one is killed mid-run; the machine restarts; the same series is due in both. The project still ends up with exactly the period's posts, each one once.

**Why this priority**: Duplicate posts reach real audiences and cannot be taken back. The constitution already states that a missed post beats a duplicate post.

**Independent Test**: Drive two concurrent ticks against one due series and assert one run and one set of posts; then kill a run between positions, tick again, and assert the run resumes without re-planning and without a second post for any finished position.

**Acceptance Scenarios**:

1. **Given** one due series and two ticks running at the same time, **When** both attempt it, **Then** exactly one run exists for that period and no position has two posts.
2. **Given** a run interrupted after some of its posts were written, **When** a later tick picks it up, **Then** it continues from the first position without a post, keeps the angles it had already planned, and produces no second post for any completed position.
3. **Given** a run whose worker died while holding it, **When** its lease expires, **Then** a later tick recovers it and finishes it.
4. **Given** two enabled series of the same project that both queue into the same account's slots and both run in the same tick, **When** they finish, **Then** no two targets hold the same occurrence and every queued target has a distinct real slot time.
5. **Given** a tick whose deadline arrives mid-run, **When** it stops, **Then** the posts already written are intact, nothing is half-written, and the remainder is produced on a later tick.

---

### User Story 4 - A series that needs a picture gets one, or says why not (Priority: P2)

A series posting to Instagram cannot emit a text-only post. It either takes an unused image from a pool the owner configured, or generates one from a prompt the owner wrote, and when it can do neither it says so instead of producing something that cannot publish.

**Why this priority**: Instagram and TikTok are the channels a content backlog is most often for, and this is the case the image entry landed to make possible.

**Independent Test**: Run the same series against an Instagram account with a pool of two images and a cadence of three, and assert two posts with distinct images and one recorded skip naming the exhausted pool; repeat with generation configured and assert three posts each with its own generated asset.

**Acceptance Scenarios**:

1. **Given** a series targeting a media-required account with a pool of 3 unused images and a cadence of 3, **When** it runs, **Then** 3 posts are produced, each with a different image, and no image is also taken by another series or job.
2. **Given** the same series with only 1 unused image left in its pool, **When** it runs, **Then** 1 post is produced and the other 2 positions are recorded as skipped with a reason naming the exhausted pool and the account that required media.
3. **Given** a series set to generate images and a project with image generation configured, **When** it runs, **Then** each post carries its own newly generated asset, visible in the media library with its provenance, and the prompt sent carried the real-people instruction and nothing from the post text.
4. **Given** a series set to generate images in a project where image generation is not configured, **When** it runs, **Then** every position that needed media is skipped with that reason, no post is produced for them, and the series is not silently switched to another media source.
5. **Given** a series targeting only accounts that do not require media, with a media source of none, **When** it runs, **Then** text-only posts are produced and nothing is skipped.

---

### User Story 5 - A member can see what a series is doing, and stop it (Priority: P2)

Under Batch jobs there is a Standing series section. It lists each series, whether it is running or paused, what it posts and how often, when it last ran and when it is next due. Opening one shows its recent runs — what each produced, skipped and failed, and why. An owner or admin can pause, resume, edit or delete it.

**Why this priority**: An unattended generator nobody can inspect or stop is not shippable.

**Independent Test**: With a series that has one completed run containing a produced post, a skip and a failure, assert all three are visible with their reasons, and that pause stops the next period from firing while resume restores it.

**Acceptance Scenarios**:

1. **Given** a project with no standing series, **When** an owner opens Batch jobs, **Then** an empty state explains what a standing series is and offers to create one.
2. **Given** a series with recent runs, **When** a member who can view posts opens it, **Then** each run shows when it ran, how many posts it produced, how many it skipped and why, and each failure with its message, and each produced post is reachable.
3. **Given** an enabled series, **When** an owner pauses it, **Then** no later tick produces anything for it, the open run stops producing, and the list shows it paused.
4. **Given** a paused series, **When** an owner resumes it, **Then** it is next due at the coming period boundary and not at a boundary that passed while it was paused.
5. **Given** an editor, **When** they open the section, **Then** they can see the series and its runs but are offered no create, edit, pause, resume or delete control, and the server refuses each of those actions from an editor however it is requested.
6. **Given** a series that produced posts, **When** an owner deletes it, **Then** the series and its run history are gone and every post it produced is still in the project.

---

### User Story 6 - A broken or unpaid series waits quietly and recovers on its own (Priority: P3)

When the provider account runs out of credit the series waits rather than failing, and when credit returns it carries on with nothing for anyone to clear. When it is genuinely broken, it stops asking.

**Why this priority**: Without this, one unpaid invoice becomes a failure list nobody reads and a bill nobody expected.

**Independent Test**: Hold the credential owner, tick, and assert nothing was produced, nothing failed, no attempt was counted and the due time did not move; clear the hold, tick, and assert the run continues.

**Acceptance Scenarios**:

1. **Given** a due series whose credential owner is held on billing, **When** ticks run, **Then** nothing is generated, no failure is recorded, no attempt is counted, the due time does not advance, and the interface names billing as the cause and since when.
2. **Given** that series, **When** the hold clears, **Then** the next tick continues the run with no retry, reset or manual step.
3. **Given** a project whose stored provider key cannot be read, **When** a run attempts a post, **Then** the recorded failure is the existing fixed sentence for that condition and no credential text appears anywhere.
4. **Given** a series whose three most recent runs produced no post at all, **When** the next run would be due, **Then** the series has paused itself, the interface says why, and resuming it is one action.
5. **Given** a series whose target accounts have all been disconnected or removed, **When** it runs, **Then** it records that it had no usable target and produces nothing.

### Edge Cases

- A series is edited (accounts, cadence, policy, media source) while a run of it is open: the open run finishes under what it started with, and the change takes effect from the next period.
- The cadence is lowered from 5 to 2 after a run has already produced 4 posts: the open run is not truncated and no post is deleted; the next period produces 2.
- A target account is removed from the project between runs: the series drops it and records that it did, and if no usable target remains the run produces nothing and records why.
- The voice profile a series names is deleted: the series cannot run and says so, rather than silently falling back to the project default.
- A period boundary falls inside a daylight-saving transition: the boundary resolves to exactly one instant, with no run skipped and no run opened twice.
- The project's time zone is changed: the next boundary is computed in the new zone, and already-recorded run history is not retroactively relabelled.
- The queue horizon has no free occurrence for an account: the post stays an approved draft with that reason recorded, and the run does not retry it into a different policy.
- The same image would be taken by a batch job and a standing series in the same tick: one of them gets it and the other treats it as unavailable.
- Media storage is not configured at all: a series whose media source is pool or generate is refused at creation with the existing storage sentence, and an existing one skips with that reason.
- A tick's budget is too short for even one model call: the section does nothing and reports that, as the batch section already does.
- Two series of *different* projects queue into their own accounts concurrently: neither can see or affect the other's slots, posts, media or runs.
- No text provider is configured anywhere: no series is claimed and nothing is generated, exactly as no batch item is claimed today.

## Requirements *(mandatory)*

### Functional Requirements

#### The series itself

- **FR-001**: A project MUST be able to hold any number of standing series, each stored by a committed SQL migration with the project, a name, a brief, the instructions template and its declared field list, a voice profile, the target account ids, a cadence, a media source, the resolved approval and scheduling policy, an enabled flag, and the times it last ran and is next due. `pnpm db:check` MUST be green against the committed SQL (W2, W3).
- **FR-002**: A name MUST be 1–100 characters after trimming and MUST be unique within its project, case-insensitively; a duplicate MUST be refused with a message naming the conflict (W6).
- **FR-003**: The declared field list MUST be stored and MUST be empty for every series created by this entry; a template containing any placeholder MUST be refused at creation with the same wording a batch job uses for an unknown placeholder (W4).
- **FR-004**: The instructions template MUST obey the same length limit as a batch job's instructions, and the brief the same limit as the existing series brief; both MUST be validated before anything is stored (W4, W5).
- **FR-005**: A cadence MUST be a count of 1–10 posts and a period of day, week or month; any other count or period MUST be refused (W7, W8).
- **FR-006**: Target accounts MUST be 1–50 accounts of the same project, MUST obey the existing limit on how many distinct variant groups one generation may cover, and MUST be validated at creation and again at run time (W3).
- **FR-007**: A series MUST name exactly one voice profile of its own project; a series whose voice profile no longer exists MUST NOT run and MUST record that as the reason (edge case).
- **FR-008**: Creating, editing, pausing, resuming and deleting a series MUST each be recorded in the project's activity log, as other project configuration changes already are.

#### When a series fires

- **FR-009**: The next due time MUST always be a period boundary in the project's own time zone — the start of a local day, of a Monday-starting week, or of the 1st of a month — resolved through the project's time-zone handling with explicit daylight-saving disambiguation (W9).
- **FR-010**: A newly created or newly resumed series MUST first be due at the next boundary, never at one that has already passed (W9, W12).
- **FR-011**: A series MUST be considered due only when it is enabled and its next due time has passed; a series that is not due MUST produce nothing and MUST be left entirely unchanged (W10).
- **FR-012**: At most one run MUST exist per series per period, enforced by the database rather than by timing, so two overlapping ticks cannot open two runs for the same period (W10, W19).
- **FR-013**: Missed periods MUST NOT be backfilled: when one or more boundaries passed without a run, the series MUST record that it missed them and MUST become due for the current period only (W10).
- **FR-014**: At most one run per series MUST be open at a time; when a new period becomes due while a prior run is still open, the prior run MUST be closed as incomplete with its counts preserved before the new run opens (W11).
- **FR-015**: Each run MUST durably record when it opened, which period it is for, how many posts it was asked for, how many it produced, how many it skipped and with which reasons, how many failed and with which messages, and when it closed and with what outcome (W2).

#### Producing a period's posts

- **FR-016**: A run of two or more posts MUST plan that many distinct angles through the existing planning path before writing any post, and MUST store the plan on the run before the first post is written; a run of exactly one post MUST take the single-post path and MUST make no planning call (W14, W15).
- **FR-017**: A resumed or recovered run MUST reuse the plan it already stored and MUST NOT plan again (W15).
- **FR-018**: A planning call MUST be given the angle titles of the series' most recent prior runs, bounded to a small fixed number of titles, as titles to avoid, through the existing prompt mechanism for keeping angles distinct. The golden prompt tests MUST be updated to cover the new context, with and without prior runs (W16).
- **FR-019**: Each post MUST be generated through the existing generation path with no series-specific prompt, output schema, correction retry, failure kind or usage purpose semantics; brand context, voice profile ordering, platform rules and posting instructions MUST compose exactly as they do for a manual Generate (W17).
- **FR-020**: Each post MUST record the voice profile version actually used at run time; editing a voice profile MUST change later posts only (W18).
- **FR-021**: A position MUST produce at most one post, enforced by a uniqueness constraint on the run and position; a writer that loses the race MUST report the winning post rather than failing or writing a second one (W19).
- **FR-022**: A temporary failure (timeout, rate limit, unavailability, interruption) MUST be retried on a later tick under the existing attempt cap and backoff; a lasting failure (a refusal, an unusable output) MUST be recorded for that position and MUST NOT be retried automatically (W20).
- **FR-023**: Every generation failure MUST be recorded through the existing failure path, carrying the existing fixed message for its kind, and MUST be attributable to its series, run and position (W17).
- **FR-024**: Every model call a run makes MUST appear in the project's usage ledger with its provider, model, outcome and credential source, under the same rules as every other generation call; a call that never reached the provider MUST NOT appear (W17).
- **FR-025**: A run MUST close when every position has a post, a lasting failure or a skip, and MUST close with an outcome that distinguishes "produced everything asked for", "produced some", and "produced nothing" (W20).
- **FR-026**: No credential, provider error text or raw provider payload MUST reach any stored row, log line, error message or rendered screen anywhere in this feature.

#### Policy, approval and queueing

- **FR-027**: Approval and scheduling policy MUST be resolved and authorised against the acting member's role when a series is created or edited, stored on the series, and used unchanged by every later run with no further role check (W21).
- **FR-028**: Selecting auto-approve MUST require the auto-approve permission, and auto-approve together with add-to-queue MUST require the same explicit confirmation a batch job requires; the server MUST enforce both regardless of what any interface offered (W21).
- **FR-029**: Every post a run produces MUST have its policy applied by the one existing policy function. There MUST be no series-specific approval or queueing path, and no way for a series to approve or queue a post that function would not (W22).
- **FR-030**: A post whose target fails content validation MUST be left in review with the reason recorded, even under auto-approve; an account that is merely unavailable MUST NOT force review (W22).
- **FR-031**: A post set to queue MUST take real occurrences of its accounts' posting slots through the existing allocator, inside the same transaction that applies the policy, so that two series, two runs or two workers can never hold the same occurrence (W23).
- **FR-032**: A queued target with no free occurrence inside the queue horizon MUST remain a draft with that reason recorded, and MUST NOT be retried under a different policy (W23).
- **FR-033**: A series MUST NOT be able to schedule a post at an explicit time; its only scheduling choices are leave-as-draft and add-to-queue (W24).

#### Media

- **FR-034**: A series MUST declare one media source: none, a pool (optionally narrowed by a tag), or generate (W25).
- **FR-035**: With a pool, each post MUST take one unused image of the project's library matching the pool, reserved inside the write so no other series, run or batch job can take the same asset; videos MUST never be eligible (W26).
- **FR-036**: With generate, each post MUST get its own image through the declared image-generation contract, written into the media library as an ordinary asset with its provenance, and the prompt sent MUST be the prompt stored on the series plus the fixed real-people instruction and nothing else — no post text, no brand fields, no voice profile (W27).
- **FR-037**: The stored image prompt MUST obey the same prompt limit the image feature already enforces, and MUST be required whenever the media source is generate (W27).
- **FR-038**: When any target account requires media and the series cannot supply an image for a post — pool empty or exhausted, image generation not configured, image generation failed, or the per-platform planner refused the only candidate — that position MUST be skipped with a reason naming both the cause and the account whose requirement failed, and no post MUST be written for it (W28).
- **FR-039**: A skip MUST be a neutral recorded outcome: it MUST NOT count an attempt, MUST NOT be reported as a failure, and MUST NOT make a run's outcome "completed with failures" (W29).
- **FR-040**: Attached media MUST pass through the existing per-platform fit, variant and planner behaviour with no standing-series special case, and the existing limit on how many images a target set accepts MUST apply (W26).
- **FR-041**: When media storage is not configured, a series whose media source is pool or generate MUST be refused at creation with the existing storage sentence, and an existing such series MUST skip its positions with that reason rather than failing them (edge case).

#### The worker pass

- **FR-042**: Due series MUST be woken by a new bounded section of the existing worker tick, not by a new process, a queue, a broker or a second loop (W30).
- **FR-043**: A due series MUST be claimed with a skip-locked claim plus a lease, in the same manner batch work is claimed, so overlapping ticks never take the same series and a process killed mid-run is recovered when its lease expires with no duplicate and no lost run (W30, W19).
- **FR-044**: The section MUST be bounded: a documented limit on how many series are claimed per tick and how many posts one claimed series may produce in a tick, and it MUST stop before the tick deadline rather than overrunning it. Nothing MUST be left half-written when it stops (W31).
- **FR-045**: The section's own limits MUST be separate from the batch section's, and `docs/generator.md` MUST state that enabling standing series raises the install's total concurrent model calls and how to bound it (W31).
- **FR-046**: Claims MUST rotate so that one series and one project cannot starve others; the series due longest MUST be preferred (W32).
- **FR-047**: The section MUST report its own counts in the tick summary and heartbeat — series claimed, runs opened, posts produced, skipped, failed, retried, recovered, series held and series auto-paused — and a failure inside it MUST NOT affect publishing, token refresh, batch generation, housekeeping, webhooks or email (W30).
- **FR-048**: No section-level Postgres feature (advisory lock, listen/notify) MUST be used, and no provider or model call MUST happen inside a held transaction (constitution: engineering constraints).
- **FR-049**: When no text provider is configured for any project or for the install, no series MUST be claimed and the section MUST report that state without failing.

#### Credit holds and self-pausing

- **FR-050**: A series whose resolved credential owner is held on billing MUST NOT be claimed: nothing generated, no attempt counted, no failure recorded, the due time unchanged, and the open run left open. The existing probe MUST resume it with no retry, reset or manual step (W33).
- **FR-051**: A billing refusal reached mid-run MUST send that position back to be retried with no attempt counted and MUST set or refresh the hold on the credential owner actually used, through the same code as every other billing refusal (W33).
- **FR-052**: Both Batch jobs screens' existing billing notice MUST cover standing series too, naming billing as the cause, whether the held credential is the project's own or the install's, and since when (W33).
- **FR-053**: A series whose three most recent closed runs each produced no post MUST pause itself and record why; the interface MUST say so and MUST let an owner or admin resume it in one action (W34).

#### Pausing, resuming, editing and deleting

- **FR-054**: Pausing MUST stop further runs and MUST stop an open run producing further posts at the next safe point, leaving every post already produced untouched (W12).
- **FR-055**: Resuming MUST set the next due time to the coming boundary and MUST NOT fire for a boundary that passed while the series was paused (W12).
- **FR-056**: Editing a series MUST NOT change an open run: the open run finishes under the configuration it started with, and the change applies from the next period (edge case).
- **FR-057**: Deleting a series MUST remove the series and its run history and MUST leave every post it produced in the project, reachable and unchanged (W13).

#### Interface

- **FR-058**: A Standing series section MUST appear under the existing Batch jobs area, listing each series with its state (running, paused, or paused by the product with the reason), its cadence, its targets, when it last ran and when it is next due.
- **FR-059**: A series' own view MUST show its recent runs with, for each, when it ran, what it produced, what it skipped and why, and what failed with the existing message, and every produced post MUST be reachable from it.
- **FR-060**: Creating, editing, pausing, resuming and deleting MUST be available to owners and admins only, MUST NOT be offered at all to anyone else, and MUST be refused server-side regardless of what any interface showed or how the request was built.
- **FR-061**: A member who can view posts MUST be able to see the series list and run history; a member who cannot MUST see neither.
- **FR-062**: Every screen and control MUST follow the project's design system and UI conventions, be reachable and operable by keyboard with visible focus, have labelled controls, and have sensible empty, loading and error states. Destructive deletion MUST be confirmed.
- **FR-063**: Outcomes of create, edit, pause, resume and delete MUST be announced through the existing live-region pattern, and the forms MUST state the cadence bounds, the no-placeholder rule, the real-people rule where an image prompt is asked for, and that policy is authorised now and applied to every later run.
- **FR-064**: The section MUST explain, where a person can see it, that a validation failure sends a post to review even under auto-approve, so the behaviour reads as intended rather than as a fault.

#### Isolation, docs and scope discipline

- **FR-065**: Every read and write in this feature MUST go through the scoped data-access layer; a series, its runs, its posts, its media and its failures MUST be invisible and unreachable from any other project by any path, including the worker pass.
- **FR-066**: One-off Generate, the in-request series and the existing finite batch jobs MUST behave exactly as they do today. Any code this entry shares with them MUST be a refactor with no behaviour change, demonstrated by their existing tests staying green unchanged.
- **FR-067**: `docs/generator.md` MUST gain a standing-series section covering what one is, cadence and period boundaries, no backfill, policy authorisation, media sources and the media-required skip, idempotency and the per-tick bounds, billing behaviour, self-pausing, and the limits; and `docs/decisions.md` MUST record every decision W1–W34. Any new environment setting MUST be documented in `.env.example`.

### Key Entities

- **Standing series**: a project's standing instruction to keep producing posts. Holds its name, what it is about, the instructions and their (currently empty) field list, the voice profile, the target accounts, the cadence (count and period), the media source and any image prompt, the authorised approval and scheduling policy, whether it is enabled and — when the product paused it — why, and when it last ran and is next due.
- **Series run**: one period's work. Holds which series and which period it is for, the angle plan it committed to, how many posts it was asked for, what it produced, skipped and failed with reasons, its claim lease, and when and how it closed.
- **Run position**: one intended post within a run. Ends as produced (linked to exactly one post), skipped (with a reason) or failed (with a kind and the existing message). The link from run and position to a post is unique.
- **Post**: unchanged, except that one produced by a standing series can be traced back to its series, run and position.
- **Media asset**: unchanged. A pooled asset is reserved for the post that takes it; a generated one is an ordinary generated asset with its provenance.
- **Generation failure**: unchanged in shape, extended so a failure can name the series, run and position it came from.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An owner can set up a standing series once and, without opening the app again, find the configured number of new posts in the project every period, with the configured review and scheduling treatment, indefinitely.
- **SC-002**: Across any sequence of overlapping ticks, mid-run kills and process restarts, the number of posts a series has produced for a period never exceeds the number it was asked for, and no two posts exist for one position — asserted directly, not inferred from timing.
- **SC-003**: 100% of posts a series produces are indistinguishable from a manual Generate in how they were prompted, validated, recorded and policed — no screen, stored record or publishing decision differs because a post came from a series rather than from a person.
- **SC-004**: No post a series queues ever shares an occurrence with another post, including when two series of a project and two workers queue into the same account at once.
- **SC-005**: A post that fails content validation is never queued and never auto-approved, under any series configuration, including auto-approve with add-to-queue.
- **SC-006**: A series targeting a media-required account either produces a post with a usable image or produces nothing for that position and says why in words naming the cause and the account — it never produces a post that the publish path would refuse for missing media.
- **SC-007**: When the provider account has no credit, a standing series needs no human intervention: nothing fails, nothing is lost, the due time does not move, the cause is named on screen, and the first period after credit returns continues from where it stopped.
- **SC-008**: A worker outage spanning several periods never results in more than one period's posts being produced when it recovers.
- **SC-009**: An editor cannot create, edit, pause, resume or delete a standing series by any route, including a hand-built request; and no series, run, post, asset or failure of one project is reachable from another.
- **SC-010**: For any series, a member who can view posts can determine from one screen what it produces, when it last ran, when it will next run, and for each recent run what it produced, what it skipped and why, and what failed.
- **SC-011**: Enabling standing series changes nothing about one-off Generate, the in-request series or existing batch jobs: their existing tests pass unchanged.
- **SC-012**: Adding a second way to decide when a run opens — a date-pegged occurrence — requires no change to how a run produces posts, applies policy, queues, handles media, claims work or records outcomes.

## Assumptions

- Period boundaries are the start of a local day, a Monday-starting week, or the 1st of a month in the project's time zone. Nobody asked for a configurable week start or a chosen hour-of-day, and slots already decide what time of day a post goes out.
- A cadence of 1–10 posts per period is enough; the upper bound matches the existing distinct-angle maximum.
- Prior-run angle titles are supplied to the planner for a small fixed number of recent runs; the exact number is a plan-level choice bounded by prompt length.
- "Produced nothing" for the purposes of self-pausing means a closed run with zero posts; three such runs in a row is the threshold.
- A standing series is not exposed over the public API in this entry, and does not emit notifications or webhooks of its own; its posts emit whatever a post already emits.
- Run history is retained under the project's existing housekeeping conventions rather than forever; the exact retention is a plan-level choice consistent with how generation failures are already kept.
- Series work is not pushed to open browsers in real time; the Batch jobs screens reflect current state when loaded, as they already do.
- Accounts whose provider declares media required are Instagram and TikTok today; the behaviour is driven by the declaration, so a future provider needs no change here.

## Dependencies

- `brand-profile-fields` (landed): brand context in generation prompts.
- `image-generation` (landed): the implemented `ImageGenerator`, image configuration and resolution, image credit-hold behaviour, and generated assets in the media library — required by the generate media source.
- Existing on `main`: the generation core and its series path, the single policy function, the slot allocator, the scoped data-access layer, the worker tick and its claim/lease/backoff machinery, the credit-hold gate and probe, the usage ledger, the media planner and per-platform constraints, the project activity log.
- A text provider must be configured, for the install or for the project, for any series to run; media storage must be configured for the pool and generate media sources.

## What this entry does not do

- **No date-pegged occurrences.** Anniversaries, an occurrence from a spreadsheet, lead time, leap days and missed-window handling belong to `dated-series`, which adds a second way to decide when a run opens on the engine defined here.
- **No change to one-off Generate, the in-request series, or finite batch jobs**, beyond refactoring shared code with no behaviour change.
- **No public API, MCP or webhook surface** for standing series.
- **No notifications or email** about a series' runs, skips or failures beyond what a post already produces and what the Batch jobs screens show.
- **No explicit-time scheduling**, no per-post overrides, no editing a run's plan, and no re-running a closed run.
- **No backfill** of periods missed while the worker was down.
- **No cross-period deduplication of post text**; angle titles of recent runs are avoided, but Docket does not compare produced copy.
- **No video**: a pooled asset is an image, and no video is generated or attached.
- **No per-series provider, model, credential, rate limit or spend cap.**
