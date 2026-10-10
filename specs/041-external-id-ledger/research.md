# Phase 0 — Research: External item ID ledger

**Feature**: 041-external-id-ledger | **Date**: 2026-10-10 | **Spec**: [spec.md](./spec.md)

Everything here was read out of this repository's code, schema and installed packages. No platform
API is involved, so `docs/research/*.md` has nothing to say about this entry. There are no
`NEEDS RESEARCH` items and no `NEEDS DEPENDENCY` items: the whole feature is Postgres, Drizzle and
Zod, all already installed.

## Findings (read from the code)

**F1 — `generateSingle` already has the exact shape this feature needs.**
`src/server/services/generation/single.ts` reads `scope.posts.findByRequestId(requestId)` *before* any
model call and returns `existingResult(post)` when one is found; the save runs in
`scope.transaction(...)`; a unique violation is caught, the winner re-read by request id, and returned
as an existing result. `existingResult` already sets `existing: true` on `GenerateResult`. The ledger
is the same pattern with a different key, so FR-013, FR-014 and FR-015 reuse it rather than invent one.

**F2 — `saveGeneratedPost` is the single write path for every generated post.**
`generation/save.ts` is called by `single.ts`, `series.ts` and `jobs/runner.ts`, always inside the
caller's transaction. It is therefore the only place where "a post exists" becomes true, which makes it
the only correct home for the claim insert (FR-007). Series and the app composer simply pass nothing.

**F3 — both ingest paths are already one transaction with the item insert.**
`jobs/create.ts` `write()` and `jobs/append.ts` `write()` each open `scope.transaction`, lock the job
(append) and the named images, filter items, then call the shared `insertItems`. A ledger filter drops
into the same place as the existing reserved/used/deleted media filter, with no new transaction.

**F4 — `insertItems` numbers positions from the sum of every status.**
`const base = counts.queued + counts.running + counts.done + counts.failed + counts.cancelled;` A new
item status that is not added to that sum would reuse a position and break
`generation_job_items_job_position_uq`.

**F5 — the item status vocabulary is enumerated in six places.**
`schema/jobs.ts` (`generationJobItemStatus`), `dal/jobs.ts` (`emptyCounts`), `jobs/create.ts` (F4),
`jobs/read.ts` (`listJobItems` filter plus the default counts literal), `api/operations/jobs.ts`
(`itemsQuery.status`), and `jobs/status.test.ts`. The UI adds `FilterTabs` on the job page and
`StatusBadge`'s table.

**F6 — three existing filters already behave correctly for a new terminal status.**
`generation_job_items_active_media_uq` is partial on `status IN ('queued','running','failed')`, so a
`skipped` item holds no image (FR-018). `JobItemsRepo.retryFailed` filters `status = 'failed'`, so a
skipped item is never retried (FR-022 holds without new code). `cancelForJob` touches
`('queued','failed','running')`, so cancelling a job leaves skipped items alone.

**F7 — job status is derived in exactly one function.**
`jobs/status.ts` `deriveJobStatus` is the only writer (`refreshJobStatus`). `completed_with_failures`
is chosen by `counts.failed > 0`, so a skipped item does not make a job look failed (FR-021) as long as
`JobCounts` learns the new status and `worked` counts it as work done.

**F8 — the runner's recovery path is keyed on "does a post exist for this item".**
`dal/job-claims.ts` decides `kind: "finish"` by counting posts with that `generation_job_item_id`, and
`jobs/runner.ts` catches a unique violation around `saveGeneratedPost` and re-reads
`posts.findByJobItemId`. A late skip is the same decision with one more question asked of the ledger.

**F9 — `ApiPost` is shared by the public API and webhook post events.**
`views/post.ts` `toApiPost` is called from `views/load.ts` (API reads) and `webhooks/emit.ts`
(`post.published`, `post.failed`). Adding a field to `PostSchema` therefore also adds it to webhook
bodies, and `EmitRepos` (`Pick<ProjectScope, "webhooks"|"posts"|"targets"|"accounts"|"media">`) plus
`createSchedulingRepos` must gain the new repository so the scheduler can build the body.

**F10 — `posts` has no `unique (project_id, id)`.**
`schema/posts.ts` has only the primary key on `id`. `generation_jobs`, `generation_job_items` and
`voice_profiles` all declare `unique("…_project_id_uq").on(projectId, id)` precisely so children can
hold a project-composite foreign key. A composite FK from the ledger to `posts` needs that unique added.

**F11 — a Postgres unique violation does carry the constraint name, but we do not need it.**
`node_modules/.pnpm/pg-protocol@1.16.1/.../messages.d.ts` declares `constraint: string | undefined` on
`DatabaseError`, and the repo's `isUniqueViolation` already digs through `e.cause` for `code`. Two
unique indexes can now fire in the same transaction (the post's request id and the claim), so the
recovery path must tell them apart — see D7.

**F12 — posts are only ever soft-deleted.**
`dal/posts.ts` exposes `softDelete` and no delete; the only hard delete is the `projects` cascade. A
`post_id` FK with `ON DELETE CASCADE` therefore never loses a claim in normal operation (FR-010) and
still lets a project be deleted cleanly, whereas `RESTRICT` would risk failing inside that cascade.

**F13 — `generation_jobs.source_meta` is already the home for per-source job metadata.**
`jobs/sources/api.ts` returns `meta: { open: input.open === true }` and `create.ts` reads it back as
`(prepared.meta as { open?: boolean }).open === true`. The job's source namespace belongs there, which
keeps FR-003 to zero new columns on `generation_jobs`.

**F14 — `planSeriesSchema` is derived from `generateSingleSchema` by `omit`.**
`generation/series.ts`: `generateSingleSchema.omit({ requestId: true }).extend({ count })`. Any field
added to the single schema is inherited by series planning unless it is omitted too.

**F15 — `regeneratePost` rewrites the same post row.**
`generation/regenerate.ts` reloads the post, re-runs the model and updates that row; it never inserts a
post. A claim pointing at a regenerated post keeps pointing at the right post, so regeneration needs no
change and cannot free or move an id.

**F16 — the `Idempotency-Key` protocol needs no change.**
`api/idempotency.ts` claims the key, and `idempotencyMode: "generate"` runs the operation outside the
idempotent transaction, relying on the post's `generation_request_id` to link a replay to its post. The
ledger check lives inside the service, below that, so the two layers compose exactly as the spec's
"Tagged and keyed" edge case requires.

**F17 — error mapping already covers the shapes this feature needs.**
`api/errors.ts` maps `ValidationIssuesError` to `400 validation_failed` with the issue list, and
`ConflictError` to `409 conflict` with `details.reason` when `reason` is set (added by 016). No new API
error code is needed.

**F18 — `docs/limits.md` is a provider-publish-limit inventory.**
`tests/integration/docs/limits-inventory.test.ts` matches its tables against
`providers/*/capabilities`. The external-id and source-key lengths are request-validation limits, not
provider limits, so they do not belong in that table and will not break that test.

**F19 — only the first six sections of `docs/n8n.md` are executed by a test.**
`tests/integration/docs/n8n-flow.test.ts` slices the file at `## 7. Recover failed posts` and replays
the fenced `http` blocks before it. A new guide section is therefore documentation only unless a test
replays it (constitution II).

## Decisions

**D1 — One table, `external_item_claims`, with the natural key as its primary key.**
Primary key `(project_id, source_key, external_id)`, which *is* the uniqueness the spec asks for, so no
surrogate id and no second index to keep in step. `post_media` sets the precedent for a natural
composite primary key. Alternatives rejected: a surrogate `id` plus a unique index (one more index, no
caller needs the id); storing claims as a column on `posts` (cannot express "claimed id whose post was
deleted", and no uniqueness across a namespace).

**D2 — The source namespace is a lowercase slug, default `"default"`.**
`sourceKeySchema`: trimmed, 1–64 characters, `^[a-z0-9][a-z0-9._:-]*$`. Lowercase-only because a
namespace is a label the integrator chooses once, and `CMS` vs `cms` silently splitting a ledger would
be a trap; external **ids** stay byte-exact (spec assumption) because they are other systems' keys.
`"default"` is a literal constant, not derived from the API key, so key rotation cannot split a ledger
(FR-011).

**D3 — The claim is inserted by `saveGeneratedPost`, from an optional `external` argument.**
One write path, one transaction, no caller can save a post and forget the claim (FR-007, constitution
IV). `generateSingle` passes the request's id; the job runner passes the item's id and the job's
namespace; series and the composer pass nothing.

**D4 — Generate asks the ledger before anything expensive.**
After `generateSingleSchema.parse` and the permission check, and before `takeVoice`, the account load
and `runGeneration`: look up the claim, and on a hit return `existingResult(post)` (FR-014, SC-003). The
existing `findByRequestId` check stays and runs first, so a keyed retry still replays.

**D5 — An already-posted generate answers `200` with the post and `alreadyPosted: true`; a deleted post
answers `409`.**
The spec's assumption asks for 200 with a marker rather than an error, and 200-vs-201 already carries
the signal for callers that look at the status line. `GeneratedSchema` gains `alreadyPosted: boolean`,
true on both existing paths (request-id replay and ledger hit). When the claimed post has been
soft-deleted there is no post to answer with, so the service throws `ConflictError` with
`reason: "already_posted_post_deleted"`, mapped to `409 conflict`, which keeps FR-010 ("a deleted post
does not free its id") visible instead of silently re-posting.

**D6 — Ingest filters inside the existing write transaction and reports a count.**
`createJob` and `appendItems` fetch the claims for the call's external ids in one indexed query, drop
claimed ids and later duplicates of the same id (first occurrence wins, FR-017), and return
`skippedAlreadyPosted`. The filter runs **before** the `JOB_ITEMS_MAX` check so skipped items never eat
the allowance (FR-018). A non-open create whose every item is skipped throws `ValidationIssuesError`
(code `already_posted`, field `source.items`), mapped to `400`, naming the count (FR-020); an open one
is created empty and stays open.

**D7 — Unique-violation recovery re-reads state; it never reads the constraint name.**
Two unique indexes can fire in one transaction now (F11). Rather than branch on `error.constraint` — a
string only as stable as a migration's index name, and one Drizzle may wrap — the catch block asks the
database what is true: look the claim up first (the permanent, stronger fact), then the request id
(generate) or the job item (runner). A rollback means any claim we then see is someone else's.
Alternative rejected: branching on `constraint`, which would need a test pinning index names and would
behave differently under a renamed index.

**D8 — A new terminal item status `skipped`, with no reason column.**
The only reason an item is skipped is "this record was already posted", and the winning post is
reachable from the claim, so the sentence is composed in the view layer from `external_id` plus the
claim row rather than frozen into a text column at write time. That keeps one wording in one place
(FR-024, FR-025) and adds one column (`external_id`) instead of two.

**D9 — A late skip is detected twice: cheaply before the model, authoritatively at save.**
The runner checks the ledger after it has its voice and accounts and before `runGenerationStep`, which
saves the model call in the common case; and `saveGeneratedPost`'s claim insert is the authority, so a
claim that lands during the model call still ends as a skip through D7's recovery (FR-021).

**D10 — `JobCounts` gains `skipped`, and `deriveJobStatus` treats it as work done, not failure.**
`counts.failed > 0` stays the only route to `completed_with_failures`; `worked` gains
`counts.skipped > 0` so a job whose only outcome was skips still reads as finished rather than queued.

**D11 — A post reports its source as one nested object.**
`PostSchema` gains `source: { key, externalId } | null`, which keeps it clearly apart from
`Target.externalId` (the *platform's* id for a published post) — the spec's naming assumption. It is
`null` for every untagged post, including every post made in the app (US3.3). Webhook post bodies gain
the same field (F9).

**D12 — The job's namespace lives in `source_meta`, inherited by appends.**
`{ open, sourceKey }`, parsed with a Zod schema instead of a cast (F13). Append reads the job row it
already locks, so an appended item inherits the namespace with no extra read and no way to disagree
with the job's other items (FR-003).

**D13 — No release, no backfill, no "have you posted this?" endpoint.**
Restated from the spec's out-of-scope so the implement phase does not add them. Also: no scheduled
pruning, because the ledger's permanence is the feature (FR-011).

**D14 — Ids are stored trimmed and compared byte-exact.**
Zod trims at the boundary and enforces 1–200 characters (FR-004); a check constraint
(`btrim(external_id) = external_id`) makes the invariant true in the database too, so a future caller
cannot write an untrimmed twin of an existing id.
