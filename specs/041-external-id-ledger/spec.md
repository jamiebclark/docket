# Feature Specification: External item ID ledger

**Feature Branch**: `041-external-id-ledger`

**Created**: 2026-10-10

**Status**: Draft

**Input**: User description: "External item ID ledger: let an API caller tag an item with a stable externalId from the source system, and have Docket refuse to generate a second post for an externalId it has already turned into a post. Applies to POST /api/v1/generate and to API-source job items (create + append). Backed by a new table unique on (project_id, source_key, external_id), written in the same transaction as the post. Ingest silently skips already-seen ids and reports how many were skipped. Purpose: the source system stops having to track which records it already posted, removing the fragile write-back that currently causes duplicate posts. Out of scope: polling/fetching from a source endpoint, and reposting when a source record changes."

## Why this exists

A source system (a CMS, a sheet, a bespoke backend) holds records it wants posted. Today it must remember which records it already sent to Docket and write that fact back to its own store. When that write-back fails — a crashed run, a timeout after Docket already answered, a re-run over the same backlog — the record is sent again and a duplicate post appears.

Docket already de-duplicates *retries of one request* through the `Idempotency-Key` header, but that protection is per API key and expires after seven days, so it cannot answer the question the source system actually has: "has this record of mine ever become a post?"

This feature lets Docket answer that question permanently. The caller tags each submission with the record's own stable id; Docket keeps a ledger of ids it has turned into posts and refuses to make a second post for an id already in it. The source system can then re-send its whole backlog at any time and stop tracking anything.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Post a source record exactly once (Priority: P1)

An integration calls "generate a post" for one of its records and tags the call with that record's own id. The first call generates and saves a post. Every later call for the same id — a re-run hours or months later, from a new API key, after the integration lost its own notes — returns the post that already exists instead of making a second one, and costs nothing in model spend.

**Why this priority**: This is the whole point of the feature and the smallest useful slice. With only this, an integration that posts one record at a time can delete its write-back entirely.

**Independent Test**: Submit a generate request tagged with a record id; submit the identical request again, and again from a different API key. Exactly one post exists, both later calls report that the record was already posted and name that post, and no model call is made on the later calls.

**Acceptance Scenarios**:

1. **Given** a project with no ledger entry for record `glen-42`, **When** a caller requests generation tagged with external id `glen-42`, **Then** a post is created and the ledger records that `glen-42` produced it.
2. **Given** `glen-42` already produced a post, **When** the same caller repeats the request with any brief, accounts or policy, **Then** no new post is created, no model is called, and the answer names the existing post and marks it as already posted.
3. **Given** `glen-42` already produced a post, **When** a *different* API key in the same project submits `glen-42`, **Then** the result is the same — the ledger is a property of the project, not of the key.
4. **Given** `glen-42` already produced a post and that post was later deleted, **When** `glen-42` is submitted again, **Then** no new post is created: the id stays consumed.
5. **Given** a generation attempt tagged `glen-43` that fails before a post is saved (unusable model output, no model configured), **When** `glen-43` is submitted again, **Then** generation is attempted normally, because a failed attempt claims nothing.
6. **Given** two identical requests tagged `glen-44` arriving at the same moment, **When** both are processed, **Then** exactly one post exists and the loser reports the winner's post.

---

### User Story 2 - Hand Docket a backlog and let it skip what it already posted (Priority: P2)

An integration sends a batch of items to a generation job, each tagged with its record id. Docket accepts the items it has not seen, silently drops the ones already in the ledger, and tells the caller how many it dropped. The caller can therefore re-send its entire backlog on every run without checking anything first.

**Why this priority**: Batch is how the real integration works, but it only makes sense once single-record claiming (P1) exists, because it is the same ledger.

**Independent Test**: Create an API-source job with 10 tagged items and let it run; then append the same 10 items plus 5 new ones. The response reports 5 added and 10 skipped, the job gains exactly 5 items, and 15 posts exist in total.

**Acceptance Scenarios**:

1. **Given** a project whose ledger holds none of the submitted ids, **When** a caller creates an API-source job with 10 tagged items, **Then** 10 items are created and the response reports 0 skipped.
2. **Given** 10 of 15 appended ids are already in the ledger, **When** the caller appends all 15, **Then** 5 items are added, the response reports 10 skipped, and the skipped ids produce no items, no model calls and no posts.
3. **Given** a single ingest call that contains the same external id twice, **When** it is accepted, **Then** one item is created for that id and the other occurrence is counted as skipped.
4. **Given** every appended id is already in the ledger, **When** the caller appends them, **Then** the call succeeds reporting 0 added and N skipped, and the job is unchanged.
5. **Given** a create request for a job that is not left open and every one of its items is already in the ledger, **When** the caller submits it, **Then** no job is created and the caller is told the request was refused because all N items were already posted.
6. **Given** a job item carrying an image and an id already in the ledger, **When** the item is skipped at ingest, **Then** the image is left free for another job rather than reserved by a skipped item.
7. **Given** an item that passed ingest but whose id is claimed by another submission before the item runs, **When** the item is processed, **Then** it ends without creating a post, is reported as skipped rather than failed, and the job still finishes as completed rather than completed-with-failures.
8. **Given** items whose job is cancelled, or whose generation failed permanently, **When** the same ids are submitted again, **Then** they are accepted, because only a saved post claims an id.

---

### User Story 3 - Trace a post back to the record it came from (Priority: P3)

Someone looking at a post, a job item, or the ledger can see which source record it came from, and someone looking at a skipped item can see that it was skipped because its record was already posted.

**Why this priority**: Not needed for correctness, but without it a duplicate-suppression decision is invisible and an operator cannot confirm which backlog records have landed.

**Independent Test**: Generate a post tagged with a record id, read the post back through the API, and confirm the source and record id appear. Append a duplicate item, read the job item back, and confirm the skip is visible with a plain-language reason.

**Acceptance Scenarios**:

1. **Given** a post generated for external id `glen-42`, **When** the post is read through the API, **Then** it reports the source namespace and `glen-42`.
2. **Given** an item skipped because its id was claimed while queued, **When** the job's items are listed in the API or shown in the app, **Then** that item reads as skipped with a reason naming the already-posted record, and it is not styled or counted as a failure.
3. **Given** an untagged post, **When** it is read back, **Then** the source fields are absent/null and nothing in the response suggests a ledger entry exists.

---

### Edge Cases

- **Same id, different source namespace**: two source systems feeding one project each submit id `17`; both post, because the ledger is keyed by namespace as well as id.
- **Same id, different projects**: two projects submit `glen-42`; both post, because the ledger never reaches across projects.
- **Untagged submissions**: a submission with no external id behaves exactly as it does today — nothing is claimed, nothing is skipped.
- **Id shape**: an empty, whitespace-only or over-long id is refused with a validation error naming the field; ids are compared exactly, so `Glen-42` and `glen-42` are two different records.
- **Tagged and keyed**: a submission carrying both an `Idempotency-Key` and an external id obeys both — a retry of that exact request replays the stored answer, and a different request carrying an already-posted id is answered from the ledger.
- **Deleted post**: the id stays consumed and the ledger still names the post that consumed it, even once that post is gone from the app.
- **Item limit**: skipped items never count towards a job's maximum item count, so a backlog re-send of 500 already-posted records plus 3 new ones is accepted.
- **Open job created with every item skipped**: the job is created empty and stays open, because an open job is allowed to have no items yet.
- **A job's own earlier item**: two items in the *same* job carrying the same id — the second ends skipped once the first has produced a post.
- **Ledger growth**: the ledger is append-only and is never pruned on a schedule; it must stay cheap to check as it reaches hundreds of thousands of rows per project.

## Requirements *(mandatory)*

### Functional Requirements

**Tagging**

- **FR-001**: An API caller MUST be able to tag a generate request with an external id — the stable identifier of the record in the caller's own system.
- **FR-002**: An API caller MUST be able to tag each item of an API-source job with an external id, both in the items supplied when the job is created and in items appended to an open job.
- **FR-003**: A caller MUST be able to say which source system an id belongs to (a source namespace), declared once per job for job items and per request for generate requests; when it is not given, a single default namespace is used.
- **FR-004**: External ids MUST be validated at the boundary: present, non-blank after trimming, and no longer than 200 characters; an invalid id MUST be refused with a validation error naming the offending field (and, for a batch, the item's position).
- **FR-005**: Tagging MUST be optional everywhere; untagged requests and items keep today's behaviour exactly, with no ledger entry and no duplicate suppression.

**Claiming**

- **FR-006**: Docket MUST keep a per-project ledger of external ids that have produced a post, unique on the combination of project, source namespace and external id.
- **FR-007**: A ledger entry MUST be recorded atomically with the post it belongs to — either both are stored or neither is — so that a post whose id was never claimed, or a claimed id with no post, cannot exist, even if the run is interrupted at any point. (The feature request names the mechanism: the entry is written in the same database transaction as the post.)
- **FR-008**: A ledger entry MUST record which post consumed the id and when, so a consumed id can be traced to its post.
- **FR-009**: An id MUST be claimed only by a saved post. Attempts that end in a model failure, a validation refusal, a cancelled job or a crashed run MUST leave the id unclaimed and re-submittable.
- **FR-010**: A ledger entry MUST survive deletion of the post that consumed it: a deleted post does not release its id. (Constitution principle V — a missed post beats a duplicate post.)
- **FR-011**: Ledger entries MUST never expire or be pruned, and MUST remain in force after the API key that created them is rotated, revoked or deleted.
- **FR-012**: The ledger MUST be project-scoped: an id claimed in one project MUST have no effect on, and MUST never be visible to, any other project — including to a caller holding a key for a different project. (Constitution principle III governs how that scoping is enforced.)

**Refusing a second post — generate**

- **FR-013**: When a generate request carries an external id already in the ledger, Docket MUST NOT create a second post and MUST NOT call the model; it MUST answer with the existing post, marked as already posted so the caller can tell it apart from a freshly generated one.
- **FR-014**: The ledger check MUST happen before any model call, so a duplicate submission costs no model spend and no generation failure record.
- **FR-015**: When two submissions race for the same unclaimed id, exactly one post MUST be created; the other submission MUST answer with that post as an already-posted result rather than failing.

**Refusing a second post — job items**

- **FR-016**: At ingest (job creation and item append), Docket MUST silently drop items whose external id is already in the ledger — no item row, no model call, no error — and MUST report the number dropped in the response alongside the number added.
- **FR-017**: Within a single ingest call, the first occurrence of an external id MUST be kept and later occurrences of the same id MUST be dropped and counted as skipped.
- **FR-018**: Skipped items MUST NOT consume a job's item-count allowance and MUST NOT reserve any image they referenced.
- **FR-019**: Ingest MUST remain all-or-nothing for *invalid* items (a malformed item still refuses the whole call); skipping an already-seen id is not a validation failure and MUST NOT refuse the call.
- **FR-020**: When a job that is not left open would be created with every one of its items skipped, the request MUST be refused with an error that states how many items were already posted, because such a job would have no work to do.
- **FR-021**: When an item's id is claimed between ingest and the moment the item runs, the item MUST finish without a post, in a terminal state that reads as skipped and names the record that was already posted, and MUST NOT be counted as a failed item when the job's overall outcome is decided.
- **FR-022**: A skipped item MUST NOT be retried by the failed-item retry path, since there is nothing to retry.

**Visibility**

- **FR-023**: A post created for a tagged submission MUST expose its source namespace and external id when read through the API.
- **FR-024**: A job item MUST expose its external id when read through the API, and a skipped item MUST expose a plain-language reason.
- **FR-025**: Skipped items MUST render in the existing job item views as a distinct, non-alarming state — not as an error — following the app's existing state and accessibility conventions.
- **FR-026**: The public API reference and the integration guide MUST document how to tag submissions, what a duplicate answer looks like, which failures leave an id re-submittable, and that a deleted post does not free its id.

### Key Entities

- **External item claim (the ledger entry)**: the record that one source record has become a post. Identified by project + source namespace + external id, which is unique; carries the post that consumed it and when it was consumed. Created only with a post, never released.
- **Source namespace**: a short caller-chosen label for the system an id came from, so two source systems feeding one project cannot collide on numeric ids. One default namespace is used when the caller does not name one.
- **Generate request (existing)**: gains an optional external id and source namespace.
- **Generation job (existing, API source)**: gains a declared source namespace that applies to all of its items, present and appended.
- **Generation job item (existing)**: gains an optional external id and a skipped terminal state.
- **Post (existing)**: becomes traceable to the source record that caused it.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Submitting the same tagged source record 100 times, in any mix of single submissions and batches, produces exactly 1 post and 0 duplicates.
- **SC-002**: An integration can re-send its full backlog of 500 records, of which 490 were already posted, and get exactly 10 new posts with 490 reported as skipped, without consulting or updating any state of its own.
- **SC-003**: A duplicate submission consumes 0 model calls and 0 model spend, and is answered within the time of an ordinary read rather than a generation.
- **SC-004**: Duplicate suppression still holds 8 days after the first post and after the original API key has been replaced — both cases where today's request-retry protection has lapsed.
- **SC-005**: 10 simultaneous submissions of the same untagged-until-now record result in exactly 1 post, with the other 9 answered as already posted and 0 errors.
- **SC-006**: 100% of posts created from tagged submissions can be traced back to their source record, and 100% of skipped items state why they were skipped.
- **SC-007**: The source system's "already posted" write-back can be switched off with no duplicate posts observed over a full week of normal runs, including at least one deliberately interrupted run.
- **SC-008**: Checking and claiming ids adds no perceptible delay to ingest: a 100-item batch is accepted in the same order of time as today, with a ledger holding 100,000 entries for the project.

## Assumptions

- **Field naming**: the caller-facing field is `externalId`, as the request specifies, alongside an optional source namespace field. Docket already uses `externalId` for a *platform's* id (an account's page id, a published post's id on the network); these are different objects, so the names coexist, but prose, docs and internal naming must keep "source record id" and "platform id" clearly apart.
- **Default namespace**: when a caller does not declare a source namespace, a single fixed default is used, so the simple one-source case needs no extra field. The namespace is not derived from the API key, because key rotation must not break de-duplication (FR-011).
- **Namespace is per job, not per item**: all items of one job come from one source system, so the namespace is declared once at job creation and inherited by appended items.
- **Duplicate generate answers 200 with the existing post**, consistent with how the endpoint already answers a replayed request, rather than an error status — the caller's intent ("make sure this record is posted") is satisfied, and the marker in the body lets a caller that cares distinguish the two.
- **Ids are compared byte-exact** (case- and whitespace-sensitive after trimming). Normalising case would silently merge records in systems with case-sensitive keys.
- **No release mechanism**: there is no API or UI to free a consumed id in this entry. If a project ever needs to re-post a record, that is a separate, deliberate feature.
- **Scope of sources**: the ledger applies to `POST /api/v1/generate` and API-source jobs only. CSV and media job sources, and posts composed in the app, are untagged and unaffected.
- **Existing idempotency is unchanged**: the `Idempotency-Key` protocol keeps its current behaviour and retention; the ledger is a second, permanent, project-wide layer that composes with it.
- **A new terminal item state is acceptable**: reporting a late skip needs a state that is neither done nor failed; existing job-status derivation and the job item views must learn about it.
- **Volume**: a project is assumed to accumulate up to the order of 100,000 ledger entries; the design need not plan for sharding or archival beyond that.

## Out of Scope

- Polling or fetching records from a source endpoint — Docket is still push-only; the caller submits.
- Re-posting, updating or re-generating when a source record changes. An id that has posted once stays posted, whatever happens to the record behind it.
- Releasing, re-using or editing a consumed external id, in the API or the app.
- Tagging CSV-source or media-source job items, or posts composed in the app.
- Reporting to the caller *which* ids were skipped (only how many), or an endpoint to ask "have you posted this id?" ahead of submitting.
- Backfilling ledger entries for posts that already exist from earlier runs.
