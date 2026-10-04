# Implementation Plan: Generation jobs, batch mode and item sources

**Branch**: `008-generation-jobs` | **Date**: 2026-10-04 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/008-generation-jobs/spec.md`

## Summary

Docket gains **generation jobs**: one post per item from a source, processed in the background by a new section of `runTick()`. Everything sits on the 007 generator core, approval policy service and slot allocation, with no second copy of any of them (constitution IV).

- **Data**: `generation_jobs` and `generation_job_items`, both project-owned and registered with the scope test, plus `posts.generation_job_item_id` ([data-model.md](./data-model.md)). All of it is in one migration, `0005`.
  - A **partial unique index** on active items' `media_asset_id` is the media reservation.
  - A partial unique index on the post's item link guarantees **at most one post per item**.
- **Item sources** sit behind one `ItemSource` interface and a registry ([contract](./contracts/services.md#item-sources)).
  - The **media library** source takes a pick, a filter or tag, or "all unused".
  - The **CSV** source uses `csv-parse` (installed). It checks UTF-8, the header, the line-numbered problems and the 1 MB / 500-row limits.
  - The `public-api` entry adds an API source with one file and one registry line. Item insertion is already an append (`insertItems`).
- **Creation** returns at once with no model call.
  - Policies are resolved and authorised once through the existing `resolvePolicies`.
  - The voice version is pinned.
  - The template is checked for unknown fields.
  - Images are reserved atomically: rows are locked, re-checked and inserted, with the index as backstop. Concurrent "all unused" jobs therefore never share an image.
- **Processing** ([contracts/runner.md](./contracts/runner.md)) follows the publishing pattern:
  - claim jobs and then items with `SKIP LOCKED`, rotating across jobs by `last_claimed_at`;
  - lease with `SCHEDULER_LEASE_SECONDS`;
  - run the model **outside** any transaction;
  - save under a job lock plus a lease-token check, then apply the existing policy service behind a cancel guard.

  At most `GENERATION_TICK_MAX_ITEMS` (default 2, range 1–10) items run per tick, concurrently. Each is isolated, and each has temporary and lasting failure classes, backoff and 3 attempts.
- **The budget tension** (spec): every job model call's `timeoutMs` is capped at the time left in the tick minus a 3 s save reserve. No item starts with less than an 8 s window. The generator's single correction retry is **deferred** to a later tick when it cannot fit. This goes through a new step API in the core; `runGeneration` behaves as before (research D1–D2).
- **Cancel** discards in-flight work: a cancelled job's running item saves no post, and a saved-but-unqueued post stays in review. **Retry** resets failed items. **Recovery** finishes items that already have a post without a model call.
- **Screens**:
  - Jobs list;
  - job page with live counts (a 5 s `router.refresh()` while active), per-item links and review state, retry and cancel;
  - the shared job form, reusing `PolicyPicker` and its labelled, confirmed unreviewed-queue option;
  - CSV upload with the validation result;
  - media library selection, "Generate for all unused images", and "In a job" badges.
- **Series stays in-request**. It shares a newly extracted `saveGeneratedPost` with single and jobs (research D24, logged).
- **Latency**: `pnpm llm:check` gains a jobs report. The planning environment has no key, so it is currently "latency: unmeasured; live path verified with mocks only".

**No new dependency.**

## Technical Context

**Language/Version**: TypeScript 5 (strict) on Node 24 LTS (`>=24.10 <25`; planning probes ran on 24.16).

**Primary Dependencies**: all already installed (decision #19). **Nothing new.**

- `csv-parse` 7.0.3, `csv-parse/sync` `parse` with `bom`, `info`, `relax_column_count` and `skip_empty_lines`. `CsvError` codes and `info.lines` were read from the installed `.d.ts` and probed (research F1).
- The Node built-in `TextDecoder("utf-8", { fatal: true })` checks UTF-8 (F2).
- The existing LLM layer (`openai` 7.27.0, `@anthropic-ai/sdk` 0.131.0) is now also bundled into `worker.mjs`. The bundle and load were probed (F3).
- Drizzle ORM 0.45.3 (`drizzle-orm/node-postgres`), Zod 4.6.5, and Next.js 16.3.8 Server Actions and server components (`router.refresh()`, F5). Read `node_modules/next/dist/docs/01-app/` before writing UI (AGENTS.md).

**Storage**: PostgreSQL 17 via Drizzle, with one migration (`0005`).

- New tables: `generation_jobs` and `generation_job_items`.
- New column: `posts.generation_job_item_id`.
- New enums: `generation_job_status`, `generation_job_item_status` and `generation_job_item_error`.
- No existing enum changes.

See [data-model.md](./data-model.md).

**Testing**: Vitest against real Postgres (the existing harness, with per-worker database clones).

- The fake LLM gains `delayMs` and honours `timeoutMs` and `signal`.
- New `tests/integration/jobs/*.test.ts` files, mapped in [quickstart.md](./quickstart.md).
- Unit tests sit beside the code: template, CSV, core step and prompt snapshot.
- `actions-authz.test.ts` gains rows, and the scope registry gains two tables.
- The two lint tests that encode old boundaries are updated: `generation-imports` and `section-placeholders`.
- **No live LLM calls.**

**Target Platform**: the existing `node:24-slim` image.

- `worker` now bundles the LLM layer and the generation services, because jobs run in the tick (research D12).
- `docker-compose.yml` already passes the same `.env` to `worker`.

**Project Type**: the single Next.js app (`src/app`, `src/components`, `src/server`, `src/providers`, `src/lib`).

**Performance Goals**:

- SC-001: a job of 100 to 500 items is created in under 3 s. This takes one locked selection plus one multi-row insert, with no model call and no variant building.
- SC-006: every tick ends within its budget. Job calls end by `deadline − 3 s`. Image preparation and variant warm-up are bounded by `withinBudget` and release the item when they overrun.
- SC-008: a 500-row CSV validates in under 2 s, because the parse is pure and synchronous.
- SC-009: the job page refreshes every 5 s while active.
- Throughput at the defaults is about 120 items an hour (2 per tick, a 60 s interval). This is documented.

**Constraints**:

- `runTick()` stays bounded (budget at most 25 s), safe to run concurrently and safe to kill.
- No model, storage or sharp call happens inside a held transaction.
- Claims use `SKIP LOCKED` with no advisory locks (the Neon pooler).
- Consistent lock order: job, then item, then media (share), then the new post. The policy guard takes post, then job (share) (research D9).
- Secrets never reach the item rows, logs or the browser: error text is fixed sentences only.
- Limits:
  - 500 items per job;
  - CSV of 1 MB and 500 rows, with each row at most 50,000 characters;
  - template of 2,000 characters, rendered to at most 10,000;
  - 3 automatic attempts, with backoff from 60 s doubling to at most 15 min;
  - 2 items per tick.

  Each limit is one constant or setting, logged.

**Scale/Scope**:

- Personal and team use: a handful of projects, jobs of up to 500 items, and a few concurrent jobs.
- **Out of scope**: API keys, `/api/v1`, the API-submitted source, idempotency keys, webhooks, OpenAPI and `docs/n8n.md` (all `public-api`); the failures view and deployment docs (`hardening`); per-row CSV media; image generation.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Pre-research | Post-design | How the design complies |
|---|---|---|---|
| I. Verified facts over memory | PASS | PASS | csv-parse options, error codes and `info.lines`; `TextDecoder` fatal mode; esbuild bundling of the SDKs; `LlmRequest.timeoutMs`; `router.refresh()`. All were read from installed `.d.ts` files and docs **and probed** (research §1). No external API is new. |
| II. Nothing "working" unless it ran | PASS | PASS | The fake LLM drives every test. Latency is measured by `pnpm llm:check` or reported as "unmeasured; verified with mocks only" (D27). The planning environment has no key (F6). |
| III. Isolation in one place | PASS | PASS | Both tables are registered in `project-owned.ts`. They are reached through new scoped repos (`scope.jobs`, `scope.jobItems`). Composite FKs pin the job, items, voice version and posts to one project. The tick uses `crossProject` claims plus `forJobRunner`, a scope pinned to the project, as `forSchedulerProject` is (002 FR-008, research D11). Roles are checked in services. |
| IV. One service layer, many callers | PASS | PASS | One core (with a step API; `runGeneration` unchanged), one `saveGeneratedPost` (extracted from single and series), one `resolvePolicies` and `applyApprovalPolicy` (plus an optional guard), and one `queueTargetsInTx` slot allocation. The UI and the tick call the same `services/jobs` functions that `public-api` will call. |
| V. Providers are plug-ins | PASS | PASS | Platform rules come from capabilities and `validate()` through the registry. No provider folder changes. |
| VI. Boring, few dependencies | PASS | PASS | No new runtime dependency and no infrastructure: csv-parse is pre-installed, and the tick is the queue. |
| VII. Secrets never leak | PASS | PASS | Item errors are fixed sentences (`llmFailureMessage` and our own list). Log lines carry ids and outcomes, passed through `redact()`. No key reaches the prompt record, item rows or responses. A no-secrets test extends 007's to job items. |
| Engineering: `runTick()` bounded, concurrent-safe, kill-safe; `SKIP LOCKED` plus a lease; no provider call in a held transaction | PASS | PASS | Research D1, D3–D6, D9 and D13, and [contracts/runner.md](./contracts/runner.md). The lease is at least 60 s, more than the 25 s maximum budget plus the 3 s reserve. Model, storage and sharp work run between transactions. |
| Engineering: UI via the `docket-ui` skill | PASS | PASS | [contracts/ui.md](./contracts/ui.md): four states per view, text plus colour badges, labelled fields, a confirm dialog naming the job, project time zone, keyboard-only flows, and polite live announcements. |
| Workflow: tests per the quality bar (job item isolation, idempotency) | PASS | PASS | Quickstart §2–§7 covers isolation, retry without duplicates, no duplicates across jobs, the policy matrix including the forced review, cancel, and lease recovery after a killed tick. All model calls are faked. |

**Result**: no violations, so Complexity Tracking is empty. Two existing guard tests change because their premise changes, and each change is logged:

- `generation-imports` forbade the LLM in the worker because generation ran only in requests;
- `section-placeholders` listed `jobs`.

## Project Structure

### Documentation (this feature)

```text
specs/008-generation-jobs/
├── plan.md              # This file
├── research.md          # Phase 0: facts F1–F7, decisions D1–D28
├── data-model.md        # Phase 1: tables, indexes, metadata additions, state transitions
├── quickstart.md        # Phase 1: runnable validation guide
├── contracts/
│   ├── services.md      # item sources, create/preview/manage/read, core step API, save helper, policy guard, DAL additions
│   ├── runner.md        # tick section, claim, runner scope, item processing, errors, logging
│   └── ui.md            # routes, states, forms, media library changes, server actions
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks; not created here)
```

### Source Code (repository root)

```text
src/server/db/schema/jobs.ts                  # generation_jobs, generation_job_items, 3 enums (new)
src/server/db/schema/{posts,index}.ts         # + posts.generation_job_item_id, FK, unique index
src/server/db/project-owned.ts                # + 2 tables
drizzle/0005_*.sql (+ meta)

src/server/dal/jobs.ts                        # JobsRepo, JobItemsRepo (new)
src/server/dal/job-claims.ts                  # claimDueJobItems (crossProject), forJobRunner (new)
src/server/dal/scope.ts                       # wire scope.jobs / scope.jobItems; export forJobRunner
src/server/dal/media.ts                       # list(): reservedByJobId, unused excludes reserved; listIdsForSelection, lockForReservation, reservedAmong, usedAmong
src/server/dal/posts.ts                       # insert generationJobItemId; findByJobItemId

src/server/services/jobs/{index,create,manage,read,status,runner}.ts            # (new)
src/server/services/jobs/sources/{types,index,media,csv}.ts (+ csv.test.ts)     # (new)
src/server/services/generation/core.ts (+ core-step.test.ts)   # runGenerationStep; runGeneration unchanged
src/server/services/generation/prompt.ts (+ snapshot)          # itemData section
src/server/services/generation/save.ts                         # saveGeneratedPost (extracted) (new)
src/server/services/generation/{single,series}.ts              # call saveGeneratedPost (behaviour unchanged)
src/server/services/generation/policy.ts                       # applyApprovalPolicy opts.guard
src/server/services/generation/regenerate.ts                   # carry itemFields
src/server/services/media.ts                                   # MediaView.reservedByJobId; unused count for the media page

src/server/scheduler/generation.ts             # runGenerationJobs section (new)
src/server/scheduler/{index,config,loop}.ts    # third section; job config fields; summary line
src/server/env.ts (+ env.test.ts)              # GENERATION_TICK_MAX_ITEMS 1–10, default 2
src/server/startup/index.ts                    # log when the budget cannot fit a job item
src/worker.ts                                  # one log line when generation is not configured
src/lib/jobs/template.ts (+ test)              # placeholders, render with ⟦ ⟧ (new)
src/lib/validation/jobs.ts                     # createJobSchema, mediaSelectionSchema, itemPayloadSchema (new)
src/lib/validation/generation.ts               # record: mode job_item, job link, itemFields; instructions max 10,000

src/app/p/[projectSlug]/jobs/{page,loading,actions}.tsx|ts                # list + actions (new)
src/app/p/[projectSlug]/jobs/new/{page,loading}.tsx, JobForm.tsx          # media job form (new)
src/app/p/[projectSlug]/jobs/new/csv/page.tsx, CsvJobForm.tsx             # CSV upload + form (new)
src/app/p/[projectSlug]/jobs/[jobId]/{page,loading}.tsx, JobItemsTable.tsx, CancelJobDialog.tsx, RetryButtons.tsx (new)
src/app/p/[projectSlug]/media/{page.tsx, MediaSelection.tsx}              # selection, generate actions, In a job
src/app/p/[projectSlug]/[section]/page.tsx                                # deleted
src/components/media/MediaCard.tsx                                        # checkbox slot, In a job badge
src/components/ui/AutoRefresh.tsx                                         # router.refresh() while active (new)
src/components/ui/StatusBadge.tsx                                         # job and item statuses

scripts/llm-check.ts (+ test)                   # jobs report / unmeasured line
tests/helpers/fake-llm.ts                       # delayMs, timeoutMs/signal
tests/helpers/factories.ts                      # job/item factories, images, CSV builders
tests/integration/jobs/{create,reservation,processing,policy,isolation,idempotency,recovery,cancel,fairness,budget,no-secrets}.test.ts, ui.test.tsx
tests/integration/actions-authz.test.ts         # rows
tests/lint/{generation-imports,section-placeholders}.test.ts   # updated boundaries
.env.example, README (Jobs), docs/generator.md (Jobs section), docs/decisions.md (008 entries)
```

**Structure Decision**: the existing single Next.js app layout.

- Job logic lives in `src/server/services/jobs/` (constitution IV), with item sources in `sources/`.
- The tick section lives in `src/server/scheduler/generation.ts`, beside `publishing.ts`.
- Data access uses new repositories in `src/server/dal/` (constitution III).
- UI routes replace the `jobs` placeholder.

## Generic changes to existing code

Each change is small and keeps existing behaviour. Each is recorded in `docs/decisions.md` with how to reverse it.

1. **`runGenerationStep`** (research D2): the core is split into one-call steps, with an optional `timeoutMs` and deferred retry. `runGeneration` composes them, so its behaviour is unchanged and `core.test.ts` passes untouched.
2. **Prompt `itemData`** (D20): one optional section. With `null` it is byte-identical, and the existing snapshot passes.
3. **`saveGeneratedPost`** (D24): the shared post-save body is extracted from `generateSingle` and `writeSeriesPost`, with `createdByUserId` and the link explicit. The existing single and series tests pass untouched.
4. **`applyApprovalPolicy` `opts.guard`** (D9): an optional callback inside the policy transaction. Existing callers pass nothing.
5. **Media "unused"** (D16): the library's Unused filter also excludes images reserved by an active job item, and rows carry `reservedByJobId`.
6. **Generation record schema** (D20, D21): `mode: "job_item"`, optional `job` and `inputs.itemFields`, and `inputs.instructions` max raised to 10,000 (form schemas keep 2,000).
7. **Worker bundle boundary** (D12): the worker now includes the LLM layer, and the lint test is rewritten.
8. **`[section]` placeholder route deleted** (D25): its lint test is updated.
9. **`regeneratePost`** carries `itemFields` (D21).
10. **`runTick()`** gains a third section, `generation`, with its own heartbeat. `TickSummary` gains `generation`.

## Spec notes for later phases

- **"Row number"** (FR-009) is reported as the file line number from csv-parse's `info.lines`, which is what an editor shows (research D17).
- **"Kept separate from instructions"** (FR-011, Story 4 scenario 5): substituted values are marked `⟦ ⟧` inside the rendered instructions and also given in an `<item_data>` block, with a fixed sentence telling the model they are data (D20). Logged.
- **Media reservation record** (FR-003, FR-007): no separate table. The active item row and the partial unique index are the reservation (D15).
- **`incomplete`** is not in FR-022's list. It is treated as lasting, like `invalid_output` (D7).
- **Job items write no `generation_failures` rows**: the item holds its last error, and the failures view is `hardening` scope (D7).
- **Series is not moved onto jobs** (D24). This is logged in `docs/decisions.md`, as the spec requires.
- **Live latency** is unmeasured at planning time (F6). The implement phase runs `pnpm llm:check` once and records its output (FR-031). The risk if real calls exceed about 17 s is stated in research §9.
- **Delivery order** for `/speckit-tasks`:
  1. migration, schema and DAL repos, with scope registration;
  2. pure modules (template, CSV parser) and the record schema changes;
  3. core step API, prompt `itemData`, the `saveGeneratedPost` extraction and the policy guard, with existing tests green;
  4. item sources and `createJob`, `previewJob` and `insertItems`, plus the reservation and concurrency tests (P1);
  5. claim, runner scope, the runner and the tick section, plus env and config (P1: Stories 1 and 2);
  6. retry, cancel and recovery tests (P1 and P2);
  7. policy matrix and fairness;
  8. screens: media library actions, the job form, the Jobs list and the job page (P1 and P2), with the CSV upload (P2);
  9. bundle and lint boundary updates, and `llm:check` jobs;
  10. docs (`docs/generator.md` Jobs section, README, `.env.example`, `docs/decisions.md`) and the final gates.

## Complexity Tracking

No constitution violations, so there is nothing to justify.
