# Feature Specification: Generation jobs, batch mode and item sources

**Feature Branch**: `008-generation-jobs`

**Created**: 2026-10-04

**Status**: Draft

**Input**: User description: "Build generation jobs and batch mode on top of the generator core. Before specifying, read docs/build-prompt.md ('Generation jobs', 'Three modes' -> Batch, 'Approval policy', 'Quality bar'), .specify/memory/constitution.md, the docket-ui skill and docs/decisions.md, and build on the generator entry's LLM layer, generation core and approval/scheduling policy service. Must deliver: generation_jobs and generation_job_items (project-scoped, registered with the scope-enforcement test). An ItemSource interface with two sources now — media library selection (by filter, tag, or 'not yet used in a post', with used-media tracking guaranteeing no duplicates even across concurrent jobs) and uploaded CSV (each row an item; its columns available to the job's instructions template, validated on upload) — and the interface shaped so the public-api entry can add an API-submitted source without changes here. A job references a voice profile (version pinned at job creation), instructions/template, target accounts, approval policy and scheduling policy (defaults from the project, overrides limited by role; auto_approve + add_to_queue is an explicit, clearly labelled choice; any post failing platform validation goes to review). Series generation from the generator entry moves onto jobs if that simplifies the code (log the decision). Processing inside runTick with the same claim/lease/advance pattern as publishing: a small bounded number of items per tick (configurable), each item independent so one failure never fails the job, item-level status/output post/error, retry failed items without duplicating posts (idempotent per item), cancel a running job, and job completion status. Measure real LLM call latency against the tick budget when a key is configured and record the numbers (or state they are unmeasured). Jobs UI: create a job from the media library (including a one-click 'generate for all unused images') or a CSV upload, progress counts (queued/running/done/failed) with links to resulting posts, retry failed items, cancel. Tests: item isolation, retry without duplicates, no duplicate posts for the same media across jobs, policy honouring incl. validation failure forcing review, cancel, lease recovery after a killed tick; LLM calls faked. Must NOT do: API keys, /api/v1 endpoints, API-submitted item source, idempotency keys, webhooks, OpenAPI and docs/n8n.md (all in the next entry, public-api); failures view and deployment docs (hardening)."

## Context and sources

- Product behaviour: `docs/build-prompt.md`: "Generator" → "Three modes" item 3 (Batch), "Generation jobs" and "Approval policy"; "Deployment" (`runTick()` stays bounded, well under 30 seconds, and is safe to run concurrently and to kill mid-run); "Scheduler rules" (claim with skip-locked plus a lease); and "Quality bar" (one failed item does not fail the job, retries do not duplicate posts, policies are honoured). The API-submitted item source and API idempotency keys in the brief belong to the next entry, `public-api`.
- What already exists and what this feature reuses rather than reimplements (constitution IV):
  - **Generation core** (`docs/decisions.md` 007): it builds the prompt from a voice profile version plus instructions and inputs plus each target platform's capabilities. It validates structured output, retries once with the errors, then records a failure. It stores the prompt, provider, model, profile version, inputs, usage and latency in the post's generation metadata. Each job item calls this core. Nothing in it is duplicated per caller.
  - **Approval policy service** (007 FR-024 to FR-026): it decides the review state from the approval policy, the scheduling policy and the validation result. It queues through the existing slot allocation service. It refuses an `auto_approve` override from an editor and requires explicit confirmation of `auto_approve` + `add_to_queue`. Jobs use it unchanged.
  - **Media "used" tracking**: media assets already record when they were first used in a post, and the media library already has an "Unused" filter and tags. Saving a generated post already marks its media used.
  - **Scheduler tick** (`docs/decisions.md` 002): `runTick()` runs independent sections concurrently under one time budget (`SCHEDULER_TICK_BUDGET_SECONDS`, default 20, at most 25). Each section claims work with skip-locked plus a lease and recovers expired leases. A failing section never fails the others.
  - **Series** (007 FR-023): one brief, then an edited plan of up to 10 angles, then one post per angle. Writing is driven by the screen while the person waits, and is idempotent per angle position.
- Already installed: `csv-parse` (`docs/decisions.md` #19). No new runtime dependency is expected.

**Tension found while specifying (recorded for planning):** the model call timeout defaults to 90 seconds (`LLM_TIMEOUT_SECONDS`, allowed range 10 to 600). The generator also makes up to two calls per post (one correction retry). A tick's whole budget is at most 25 seconds. So one item's generation, run as the generator runs it today, cannot be guaranteed to fit inside one tick. This spec requires item processing to respect the tick budget (FR-020, FR-021). It also requires the real numbers to be measured and reported (FR-031). Planning must choose how. Two options: give job model calls a timeout that fits the budget, or make the correction retry a separate step on a later tick. Either way the decision is logged.

**NEEDS RESEARCH**: none. This feature calls no new external API. Model-call facts come from `docs/research/llm-and-storage.md` through the existing LLM layer.

## Decisions made while specifying

Each one is a judgement call. It will be appended to `docs/decisions.md` and can be reversed.

- **Media is reserved when the job is created, not when the item runs.** Creating a job reserves each selected image for that job's item. While an image is reserved by an active item, or once it has been used in a post, the "unused" selection excludes it everywhere, including in a job being created at the same moment. A cancelled item releases its reservation, so its image becomes unused again. A failed item keeps its reservation so it can be retried. *Why*: "generate for all unused images" must never produce two posts for the same image, even when two jobs are started at once.
- **Selections by filter or tag skip already-used images by default.** The person can tick "Include images already used in posts" to reuse them on purpose. An image reserved by another active job item is always skipped, and the skip is reported.
- **Cancel discards in-flight work.** An item running when its job is cancelled does not save its post. *Why*: someone cancelling an `auto_approve` + `add_to_queue` job wants nothing further queued.
- **Cancelled is final.** A cancelled job cannot be resumed. Its unprocessed images go back to "unused", so a new job can pick them up.
- **Policies are resolved and authorised once, at job creation**, with the creator's role at that moment. Every item applies them. If the creator later leaves the project, the job keeps running, and any owner or admin can cancel it.
- **CSV items are text-only in this entry.** A row's columns feed the instructions template. Attaching media per row (by id or URL) is left to a later entry. Registering media by URL arrives with `public-api`.
- **Moving series onto jobs is a plan-level decision.** Series may become a kind of job if that simplifies the code. If it does, the series screen still shows the plan and the posts in plan order, and FR-023 from 007 still holds: one post per angle, idempotent per angle, and one angle's failure never blocks the others. The choice and its reasons are logged in `docs/decisions.md` either way.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Generate one post per image from the media library (Priority: P1)

An editor opens the media library and picks images. The picks can be checked by hand, chosen by the current filter or tag, or taken as all images not yet used in a post. They choose "Generate posts" and fill in a short job form. The form has the voice profile (the project default is preselected), an instructions template, the target accounts, and the approval and scheduling policies (the project defaults are preselected). They start the job. Docket creates one job item per image and returns at once. The scheduler then works through the items in the background. Each finished item links to the post it produced.

**Why this priority**: This is the batch mode that replaces the owner's old n8n loop. It proves the job engine, the item source interface, background processing and the reuse of the generator core and policy service.

**Independent Test**: Seed four images, one of them already used in a post, and use a scripted fake model. Create a job from "all unused images", then run ticks until no item is pending. Confirm the job has three items, each image was given to the model, and three posts exist. Each post has origin "generated", its image attached, one target per selected account, and generation metadata naming the job, the item and the pinned voice profile version. Confirm the job is "completed" and the three images now count as used.

**Acceptance Scenarios**:

1. **Given** a selection of N images, **When** the job is started, **Then** a job with N items is created in the "queued" state and no model call is made while the person waits.
2. **Given** a queued job, **When** ticks run, **Then** each tick processes at most the configured number of items, and each processed item records its status, its output post and any error.
3. **Given** a job created with voice profile version 3, **When** the profile is edited to version 4 before every item has run, **Then** every item of that job still generates with version 3.
4. **Given** the instructions template "Write a post about this photo. Mention {{tags}}.", **When** an item runs, **Then** the instructions sent to the model contain that item's tags in place of the placeholder.
5. **Given** a job whose items have all finished, **When** the job is viewed, **Then** its status is "completed", or "completed with failures" if any item failed, and it shows when it finished.

---

### User Story 2 - Items are independent, retryable and never duplicated (Priority: P1)

Some items fail. The model may refuse, time out or return unreadable output twice, or an image may have been deleted. The rest of the job carries on. The editor sees which items failed and why. They retry one failed item or all failed items. A retry never produces a second post for an item that already has one. A tick killed partway through is picked up by a later tick without losing or duplicating work.

**Why this priority**: The brief's quality bar names these exact guarantees. Without them a batch of 200 images is not trustworthy.

**Independent Test**: Use a fake model scripted to fail item 2 of 5. Run ticks until done. Confirm items 1, 3, 4 and 5 have posts and the job is "completed with failures". Retry item 2 with the fake now succeeding, and confirm exactly one post exists for it. Retry it again and confirm nothing changes. Then simulate a killed tick: claim an item, let its lease expire without finishing, run another tick, and confirm the item finishes once with one post.

**Acceptance Scenarios**:

1. **Given** a five-item job where item 2's generation fails, **When** ticks run, **Then** items 1, 3, 4 and 5 still produce posts and only item 2 is "failed", with a plain-language error.
2. **Given** a temporary failure (timeout, rate limit, provider unavailable), **When** the item fails, **Then** it is retried automatically with backoff up to a fixed number of attempts before it is marked "failed".
3. **Given** a lasting failure (refused, unreadable output after the generator's own retry, image deleted, no target account left), **When** the item fails, **Then** it is marked "failed" at once without automatic retries.
4. **Given** a failed item, **When** a member chooses "Retry", **Then** it returns to "queued", the job returns to "running", and the next ticks process it.
5. **Given** an item that already has an output post, **When** a retry is requested or the item is claimed again for any reason, **Then** no new model call is made and no second post is created.
6. **Given** an item claimed by a tick that was killed before finishing, **When** its lease expires and a later tick runs, **Then** the item is processed again and ends with at most one post.
7. **Given** a tick killed after the item's post was saved, **When** a later tick recovers the item, **Then** it is recognised as done with that post, and no model call or second post is made.

---

### User Story 3 - "Generate for all unused images" never duplicates, even across jobs (Priority: P1)

The owner clicks "Generate for all unused images" on the media library. A job form opens with every unused image already selected and the defaults filled in. Confirming starts the job. Two jobs started at the same moment, from two tabs or by two members, never cover the same image. An image in one job is not offered as unused to another.

**Why this priority**: The brief says this action "is one click and never produces duplicates". A duplicate post across a filled calendar is the failure the owner most wants to avoid.

**Independent Test**: Seed ten unused images. Start two "all unused images" jobs concurrently, many times over. Confirm the two jobs' items together cover each image exactly once and no image is in both. Run all ticks and confirm exactly ten posts, one per image. Then cancel a job that has unprocessed items. Confirm those images show as unused again and a third job picks them up.

**Acceptance Scenarios**:

1. **Given** ten unused images, **When** two "all unused images" jobs are created concurrently, **Then** each image belongs to exactly one of them, and a job left with no images is refused with "No unused images left to generate for".
2. **Given** an image reserved by an active job item, **When** the media library's "Unused" filter is shown, **Then** the image is not listed as unused, and it shows that it is waiting in a job.
3. **Given** a selection by tag that includes an image already used in a post, **When** the job form is shown, **Then** it states how many matched images are already used and excludes them, unless "Include images already used in posts" is ticked.
4. **Given** a selection that includes an image reserved by another active job, **When** the job is created, **Then** that image is skipped and the confirmation states how many images were skipped and why.
5. **Given** a job cancelled with unprocessed items, **When** the cancel completes, **Then** those items' images are released and appear as unused again.
6. **Given** the media library has no unused images, **When** the page is shown, **Then** the "Generate for all unused images" action says there are none and does not open a job.

---

### User Story 4 - Generate one post per row of a CSV (Priority: P2)

An editor opens Jobs → New from CSV and uploads a file with a header row, for example `product,price,url`. Docket checks the file at once. It reports the row count and the column names, and shows any problems with their row and column. The editor writes an instructions template using the columns, such as "Announce {{product}} at {{price}}. Link: {{url}}", and sees a preview of the first row's rendered instructions. Starting the job creates one item per row. Each item's instructions are the template filled in from that row.

**Why this priority**: CSV is the second item source the brief names. It proves the item source interface is not specific to media.

**Independent Test**: Upload a valid three-row CSV and a template using two of its columns. Start the job, run ticks, and confirm three posts whose prompts contain each row's values. Then upload invalid files (no header, duplicate or empty column names, too many rows, too large, not UTF-8, no data rows) and confirm each is refused with a specific message before any job exists. Then use a template naming a column that does not exist, and confirm the job is refused with the unknown column named.

**Acceptance Scenarios**:

1. **Given** a valid CSV, **When** it is uploaded, **Then** Docket shows the number of rows, the column names and a preview of the first rows before any job is created.
2. **Given** a CSV with a problem (no header row, an empty or duplicate column name, a row with more fields than the header, more rows than the limit, a file over the size limit, or text that is not UTF-8), **When** it is uploaded, **Then** it is refused with a message naming the problem and, where it applies, the row number.
3. **Given** a template that references `{{missing}}`, **When** the job is started, **Then** it is refused with "Unknown column: missing", and the available columns are listed.
4. **Given** a row whose value for a referenced column is empty, **When** its item runs, **Then** the placeholder is replaced with nothing, and the preview warns beforehand that some rows have empty values for referenced columns.
5. **Given** CSV cell values containing text such as "ignore previous instructions", **When** an item runs, **Then** the values reach the model as material to write about, kept apart from the instructions, as the generator already does for pasted source text.

---

### User Story 5 - Watch progress, cancel a job and honour the policies (Priority: P2)

On the Jobs screen a member sees each job with its source, creator, policies, status and counts of queued, running, done and failed items. A job's page lists its items. Each row has the image thumbnail or CSV row, the status, a link to the resulting post (with that post's review state) and any error. The counts update while the job runs. A member can cancel a running job. Posts are approved, put in review or queued according to the job's policies. Any post failing platform validation always lands in review.

**Why this priority**: The brief asks for visible progress with links to posts and for cancel. Policy honouring is a named quality-bar test.

**Independent Test**: Run a job under each of the four policy combinations with a fake model, including one item whose output breaks a platform rule. Confirm each post's review state and scheduling. Confirm the invalid post is in review and unscheduled under every policy. Separately, cancel a job mid-run. Confirm no further items are processed, an item running at the moment of cancel saves no post, and the counts and status read "cancelled".

**Acceptance Scenarios**:

1. **Given** a job with `review_required`, **When** its items finish, **Then** every resulting post is in review and none is scheduled.
2. **Given** a job with `auto_approve` + `leave_as_draft`, **When** an item's post passes validation, **Then** it is approved and not scheduled.
3. **Given** a job with `auto_approve` + `add_to_queue`, **When** an item's post passes validation, **Then** it is approved and each target takes its account's next free slot. Posts from one job take slots in item order.
4. **Given** any job policy and an item whose post fails platform validation (for example Instagram with no image, or text over a limit after the generator's retry), **When** the item finishes, **Then** the post is saved in review with its problems listed, is not scheduled, and the item counts as done.
5. **Given** an editor creating a job, **When** they override the approval policy to `auto_approve` and the project default is not `auto_approve`, **Then** the server refuses with "Only owners and admins can auto-approve" and no job is created.
6. **Given** `auto_approve` + `add_to_queue` is chosen, **When** the form is shown, **Then** it is presented as its own clearly labelled option. The option says posts will be approved and put into the queue with no one reviewing them, and it must be confirmed before the job starts. The job page shows the same label.
7. **Given** a running job, **When** a member chooses "Cancel job" and confirms in a dialog naming the job, **Then** queued and failed items become "cancelled" and their images are released, any item running at that moment saves no post and becomes "cancelled", already-done items and their posts are kept, and the job status becomes "cancelled".
8. **Given** a job page open while the job runs, **When** items finish, **Then** the counts and item rows update without a manual reload, and the change is announced politely to screen readers.

---

### Edge Cases

- **Generation not configured** (no model provider set): creating a job is refused with the existing "Generation is not configured" message. If configuration disappears while jobs exist, their items stay queued without being marked failed, and the job page says generation is not configured.
- **Image deleted after the job was created**: that item fails with "Image deleted", without a model call. Other items continue.
- **Target account removed during a job**: later items generate only for the remaining targets. If no target account remains, the item fails with "No target accounts left". An account needing reconnection does not block generation, because publishing reports it later as it does today.
- **Voice profile archived after the job was created**: items keep using the pinned version.
- **Account with no posting slots under `add_to_queue`**: the post is approved, that target stays unscheduled with the existing "This account has no posting slots" message, and the item counts as done.
- **Job limits**: a job holds at most 500 items. A larger selection or CSV is refused with the limit stated, so the person can split it.
- **Empty selection or empty CSV**: refused before any job exists.
- **Large job next to a small one**: claims rotate across jobs, so a 500-item job does not hold up another job in the same or another project until it finishes.
- **Concurrent ticks**: two ticks never process the same item at once.
- **Retry while running**: retrying an item that is queued, running or done changes nothing.
- **Retry on a cancelled job**: refused; cancelled is final.
- **Cancel twice, or cancel a finished job**: the second cancel, or a cancel of a completed job, changes nothing and says so.
- **Instagram target with media-less CSV items**: the job form warns before starting that Instagram needs an image and CSV items have none. If the person continues, each post fails Instagram's validation and goes to review, as in the generator.
- **Role removed mid-job**: the job continues with the policies authorised at creation. Any owner or admin can cancel it.
- **A tick nearly out of time**: no new item is started unless the remaining budget can cover its model call. It waits for the next tick instead.

## Requirements *(mandatory)*

### Functional Requirements

**Jobs and items**

- **FR-001**: The system MUST record generation jobs. A job belongs to one project and records:
  - its item source kind and a summary of the source (for example "12 unused images" or "products.csv, 40 rows");
  - its voice profile and the version pinned at creation;
  - its instructions template;
  - its target accounts;
  - its requested and resolved approval and scheduling policies;
  - its creator and creation time;
  - its status: `queued`, `running`, `completed`, `completed_with_failures` or `cancelled`;
  - when it was cancelled or finished.
- **FR-002**: The system MUST record one job item per source item. An item records:
  - its job and its position in the job;
  - its source payload: the field values available to the template and any media it carries;
  - its status: `queued`, `running`, `done`, `failed` or `cancelled`;
  - its attempt count;
  - when it may next run;
  - its output post, if any;
  - its last error kind and message;
  - its start and finish times.
- **FR-003**: Jobs and items, and any media reservation record, MUST be project-owned. They are reached only through the scoped data-access layer, with membership and role checked on the server for every request, and they are registered with the scope-enforcement test.
- **FR-004**: A job's status MUST be derived from its items. It is `queued` until an item starts, then `running` while any item is queued or running, then `completed` when every item is done, or `completed_with_failures` when none is pending and at least one failed. It is `cancelled` once cancelled. Retrying a failed item of a finished job returns the job to `running`.

**Item sources**

- **FR-005**: Items MUST come from item sources behind one interface. A source:
  - validates its input;
  - declares the fields its items offer to the instructions template;
  - produces a list of items, each with field values and optional media;
  - may reserve resources (media) atomically with job creation.

  Adding a source (the `public-api` entry's API-submitted source) MUST need only a new source and its registration. No changes are needed to job processing, the job schema or the job screens.
- **FR-006**: The **media library source** MUST select images by:
  - explicit pick;
  - the media library's current filter or tag;
  - "all images not yet used in a post".

  Each item carries one image and offers the template the fields `alt_text`, `tags` and `filename`. The image is also given to the model as image input, as the generator does.
- **FR-007**: Used-media tracking MUST guarantee that no image gets two generated posts from jobs unless a person explicitly chose to include already-used images. An image counts as used when a post uses it, and as reserved while an active (queued, running or failed) job item holds it.
  - The "unused" selection excludes used and reserved images.
  - Reservation is atomic with job creation and backed by a database guarantee, so concurrent job creations cannot reserve the same image.
  - A cancelled item releases its reservation.
- **FR-008**: The **CSV source** MUST accept an uploaded UTF-8 file (a leading byte-order mark is allowed) with a header row. Each data row becomes one item, and each column is a template field named by its header.
- **FR-009**: The CSV MUST be validated on upload, before a job exists. The checks are:
  - the size limit (1 MB);
  - at least one data row;
  - at most 500 data rows;
  - non-empty, unique column names (compared without regard to case or surrounding spaces) that are usable as placeholders;
  - no row with more fields than the header;
  - valid UTF-8 and well-formed quoting.

  Fully blank rows are skipped. Each problem MUST be reported with its row number where one applies. Values are kept as text.

**Template and inputs**

- **FR-010**: The instructions template MUST support `{{field}}` placeholders for the source's declared fields. Starting a job with a placeholder that names an unknown field MUST be refused, naming the field and listing the available ones. An empty value renders as nothing. The job form MUST preview the rendered instructions for the first item without calling the model.
- **FR-011**: Each item's generation MUST go through the existing generation core with:
  - the job's pinned voice profile version;
  - the rendered template as the one-off instructions;
  - the item's field values as source material, kept separate from instructions;
  - the item's media;
  - the job's target accounts' capabilities.

  The saved post MUST have origin "generated" and the generator's full generation record, plus the job and item it came from.

**Policies**

- **FR-012**: A job's approval and scheduling policies MUST default to the project's defaults. Overrides are resolved and authorised once, at creation, by the existing policy service: an editor cannot choose `auto_approve` unless it is the project default, and `auto_approve` + `add_to_queue` requires explicit confirmation. The resolved policies are stored on the job.
- **FR-013**: Each item's post MUST be passed to the existing approval policy service with the job's resolved policies. A post with blocking validation problems always goes to review and is never scheduled, whatever the policy.
- **FR-014**: Under `add_to_queue`, auto-approved posts MUST take slots through the existing slot allocation service, with the same no-double-booking guarantee. A job's posts take slots in item order, as far as the claim order allows.

**Processing**

- **FR-015**: Job items MUST be processed by a new, independent section of `runTick()`, using the publishing section's pattern:
  - claim due items with skip-locked plus a lease;
  - do the slow model work outside any held transaction;
  - persist the outcome under a check that the lease is still held.

  A failure in this section MUST NOT fail the tick's other sections.
- **FR-016**: Each tick MUST process at most a configurable number of items in total. The setting defaults to a small number (2), has a documented allowed range, and is validated at startup and listed in `.env.example`.
- **FR-017**: Each item MUST be independent. An error while processing one item, including an unexpected exception, MUST be recorded on that item only. It MUST NOT stop other items in the same tick, and it MUST NOT fail the job.
- **FR-018**: Processing MUST be idempotent per item. An item's post is saved, and linked to the item, in one transaction, and the database guarantees at most one output post per item. An item that already has an output post is finished without a model call. This holds for retries, lease recovery and concurrent ticks.
- **FR-019**: An item whose lease expired without an outcome (a killed tick) MUST be recovered by a later tick:
  - if it has an output post, it is marked done;
  - otherwise it is returned to queued and counts as an attempt.

  No model call is ever ambiguous in the publishing sense, because saving a post is local and atomic.
- **FR-020**: Item processing MUST keep the tick within its time budget. No item starts unless the remaining budget can cover its worst-case model time, and model calls made for job items are bounded so they end before the budget does. If the existing correction retry cannot fit, it MUST be deferred to a later tick rather than overrun the budget. That deferred retry is still the generator's single retry, not an extra one.
- **FR-021**: The lease on a claimed item MUST outlast the longest time its processing can take, so a live tick's item is never recovered from under it.
- **FR-022**: Temporary model failures (`timeout`, `rate_limited`, `unavailable`) MUST be retried automatically with exponential backoff, up to a fixed attempt cap (default 3), and then marked failed. Lasting failures (`refused`, `invalid_output` after the generator's retry, `auth`, `bad_request`, image deleted, no target accounts left) MUST be marked failed at once. If generation is not configured, items stay queued without being counted as attempts.
- **FR-023**: Claims MUST rotate fairly across jobs (oldest waiting job first, one item per job per round) so a large job cannot starve other jobs.

**Retry and cancel**

- **FR-024**: A member who can generate MUST be able to retry one failed item, or all failed items of a job. Retrying resets the item to queued with a fresh attempt budget. Retrying an item that is not failed, or any item of a cancelled job, changes nothing and says why.
- **FR-025**: A member who can generate MUST be able to cancel a job that is queued or running. Cancelling:
  - marks queued and failed items cancelled;
  - releases their media reservations;
  - makes any item running at that moment save no post (the save checks, in the same transaction, that the job is not cancelled);
  - keeps done items and their posts;
  - sets the job to `cancelled`.

  Cancelling a cancelled or finished job changes nothing and says so.

**Screens** (all follow the `docket-ui` skill: keyboard usable, labelled fields, explicit loading, empty, error and populated states, status as text plus colour, project time zone on every time)

- **FR-026**: The **Jobs** screen (left nav "Jobs") MUST list the project's jobs, newest first. Each row shows its source summary, creator, created time, policies (with the unreviewed-queue label when it applies), status and counts of queued, running, done, failed and cancelled items. The list is paginated beyond 50 jobs. The empty state offers "New job from media" and "New job from CSV".
- **FR-027**: A **job page** MUST show:
  - the job's settings: voice profile name and pinned version, template, target accounts and policies;
  - its counts and status;
  - an items table with, per item: its position, a label (thumbnail and alt text, or CSV row number and first column value), status, attempt count, a link to the resulting post and that post's review state, and the error message for failed items.

  The page offers "Retry" per failed item, "Retry all failed" and "Cancel job" (confirmed in a dialog that names the job). While the job is queued or running, the counts and rows MUST refresh automatically every few seconds. The refresh stops once the job is finished.
- **FR-028**: The **media library** MUST offer:
  - "Generate posts" for the checked images, and for the current filter or tag;
  - a single "Generate for all unused images" action that opens the job form with every unused image selected and the project defaults filled in, so that confirming starts the job.

  The library MUST show images reserved by an active job as "In a job", linking to it.
- **FR-029**: The **job form** (shared by both sources) MUST show:
  - the item count;
  - for media: how many images were excluded as already used and the "Include images already used in posts" option, plus how many were skipped as reserved by another job;
  - the voice profile (default preselected);
  - the template with its available fields and a preview of the first rendered item;
  - the target accounts (with the existing Instagram-needs-an-image warning when it applies);
  - the policy picker, with the clearly labelled, confirmed `auto_approve` + `add_to_queue` option reused from Generate.
- **FR-030**: The **CSV upload** (New job from CSV) MUST show the validation result. That is either the row count, the column names and the first five rows, or every problem with its row number. The job form follows from it.

**Measurement and docs**

- **FR-031**: When a real model key is configured where implementation runs, a live check MUST run job items through the configured provider. It records the measured per-call latency (with and without an image), compares it with the tick budget and the item limit per tick, and puts the numbers in the phase report and `docs/decisions.md`. Without a key, both MUST state "latency: unmeasured; live path verified with mocks only".
- **FR-032**: `docs/generator.md` MUST gain a section on jobs. It covers the item sources and their template fields, the CSV rules, the per-tick item limit and its setting, retry and cancel behaviour, and the media reservation rule. Every judgement call MUST be appended to `docs/decisions.md`. That includes the choice about moving series onto jobs.

### Key Entities *(include if feature involves data)*

- **Generation job**: a project-owned request to produce one post per item from one source. It holds the voice profile version pinned at creation, the instructions template, the target accounts, the requested and resolved policies, its status and its timestamps.
- **Generation job item**: one unit of work in a job. It holds its position, its source payload (template field values and optional media), its status, attempts, next-run time, lease, output post and last error. It has at most one output post.
- **Item source**: a kind of input that validates its input, declares its template fields and produces items, and may reserve resources. There are two now (media library selection, CSV upload) and a third later (API-submitted).
- **Media reservation**: the hold an active job item places on an image so that no other job item can take it. It is released when the item is cancelled. It becomes part of the image's "used" history once the item's post is saved.
- **Generated post** (existing): gains a link to the job and item it came from, inside the generator's existing generation record.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Starting a job of 100 images takes the person at most two actions from the media library ("Generate for all unused images", then confirm). It returns in under 3 seconds, with no model call while they wait.
- **SC-002**: Across repeated concurrent creations of "all unused images" jobs over the same images, 0 images are reserved by two jobs. After every item is processed, there is exactly one post per image.
- **SC-003**: In a job where some items fail, 100% of the non-failing items produce posts and the job is never marked failed as a whole.
- **SC-004**: Retrying any item any number of times, recovering killed ticks, and running ticks concurrently produce 0 duplicate posts: at most one post per item in every test.
- **SC-005**: 0 posts that fail platform validation are approved or queued automatically, across the full matrix of policies and passing or failing items.
- **SC-006**: Every tick that processes job items finishes within the configured tick budget in the test suite, including when the fake model is slow.
- **SC-007**: After cancel, 0 further posts are saved for that job, including from an item that was running at the moment of cancel.
- **SC-008**: An invalid CSV is refused with every problem listed, with row numbers, before any job exists. A valid one shows its columns and preview in under 2 seconds for a 500-row file.
- **SC-009**: A running job's page reflects finished items within 10 seconds without a manual reload.
- **SC-010**: Real model latency against the tick budget is either measured and recorded with numbers, or explicitly reported as unmeasured. It is never assumed.

## Assumptions

- The generator core, the approval policy service, the slot allocation service, the media variant pipeline and the scheduler tick from entries 002 to 007 behave as recorded in `docs/decisions.md`. This feature calls them and does not change their behaviour, beyond the small generic extensions planning identifies, each of which is logged.
- Who may act: creating, retrying and cancelling jobs needs the same rights as generating a post (owners, admins and editors). Viewing jobs needs the right to view posts.
- Limits: 500 items per job, a 1 MB CSV with 500 data rows, 2 items per tick by default and 3 automatic attempts for temporary failures. These are interim values. Each is one constant or setting, logged in `docs/decisions.md`.
- Template placeholders use `{{name}}` with no logic (no conditionals or loops). Field names are matched without regard to case.
- Media items offer `alt_text`, `tags` (comma-separated) and `filename`. CSV items are text-only in this entry.
- Item order sets queue order for `add_to_queue` only as far as claim order allows. Strict ordering across ticks is not guaranteed when items fail and are retried.
- Progress refresh uses periodic reloading of server-rendered data. No push channel is added.
- Out of scope (later entries): API keys, `/api/v1` endpoints, the API-submitted item source, idempotency keys, webhooks (including "job finished"), OpenAPI, `docs/n8n.md` (all `public-api`); the failures view and deployment docs (`hardening`); image generation; video; per-row media in CSV.
