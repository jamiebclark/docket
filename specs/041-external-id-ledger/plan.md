# Implementation Plan: External item ID ledger

**Branch**: `041-external-id-ledger` | **Date**: 2026-10-10 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/041-external-id-ledger/spec.md`

## Summary

A source system tags each submission with its own record id; Docket keeps a permanent, per-project
ledger of ids that have produced a post and refuses to make a second post for an id already in it. The
source system can then re-send its whole backlog and delete its write-back.

**One new table.** `external_item_claims`, primary key `(project_id, source_key, external_id)`, carrying
the post that consumed the id and when (research D1). Never updated, never released, never pruned.

**One write path.** `saveGeneratedPost` — already the only place a generated post is written (F2) —
takes an optional `external: { sourceKey, externalId }` and inserts the claim in the caller's
transaction, so a post without its claim, or a claim without its post, cannot exist (FR-007, D3).

**Three read paths that refuse a second post.**

- `generateSingle` asks the ledger after the idempotency check and before the voice, the accounts and the
  model, and answers with the existing post when the id is claimed (FR-013, FR-014, D4);
- job ingest (`createJob` and `appendItems`) drops already-claimed ids and later duplicates inside the
  call through one shared `dropAlreadyPosted`, reporting how many it dropped (FR-016, FR-017, D6);
- the job runner checks the ledger before its model call and treats a lost claim at save time as a skip,
  so an item claimed between ingest and execution ends `skipped` rather than failed (FR-021, D9).

**Races are resolved by re-reading, not by error strings.** Both `catch (unique violation)` paths now ask
the ledger first and the old key (request id / job item) second, which needs no constraint name and
survives a renamed index (FR-015, D7).

**One new terminal item status.** `generation_job_items.status` gains `skipped`, which the existing
partial indexes and filters already treat correctly — no reservation, no retry, no cancel, and not a
failure when the job's outcome is decided (F6, F7, D8, D10).

**Visibility.** `Post` gains `source: { key, externalId } | null` (also in `post.*` webhook bodies),
`JobItem` gains `externalId` and a `skipped` object with a plain-language reason and the post that had
already been made, `JobCounts` gains `skipped`, and the job page shows a neutral **Skipped** badge,
counter and filter tab (FR-023–FR-025, D11).

No new dependency, no new infrastructure, no new API endpoint, no new permission and no new API error
code. Out of scope and deliberately absent: releasing a consumed id, backfilling existing posts, a
"have you posted this?" lookup, and tagging CSV or media job items (D13).

## Technical Context

**Language/Version**: TypeScript 5 (strict) on Node 24 LTS.

**Primary Dependencies**: all already installed; nothing added.

- **Drizzle ORM 0.45.3 / drizzle-kit 0.31.11** — the new table, the `posts` unique, the new column and
  the enum value, in one generated SQL migration.
- **Zod 4.6.5** — `externalIdSchema` and `sourceKeySchema` at every boundary; `apiSourceMetaSchema`
  replaces an existing `as` cast on `generation_jobs.source_meta`.
- **`pg` / `pg-protocol` 1.16.1** — only through the existing `isUniqueViolation`; the design does not
  read `DatabaseError.constraint` (research F11, D7).
- **Next.js 16.3.8** — three existing server components and one table component change (badge, counter,
  tab, cell). Read `node_modules/next/dist/docs/01-app/` before touching them (AGENTS.md).

**Storage**: PostgreSQL. New: `external_item_claims`. Changed: `posts` (one unique constraint),
`generation_job_items` (`external_id` column, `skipped` enum value). `generation_jobs.source_meta` gains
a `sourceKey` key with no schema change. Full detail in [data-model.md](./data-model.md).

**Testing**: Vitest against real Postgres (run-scoped databases), with the fake LLM
(`tests/helpers/fake-llm.ts`), the `atTime` clock, `tests/helpers/jobs-env.ts` and
`tests/helpers/api.ts`. Seven new test files and nine extended suites; the map is in
[quickstart.md](./quickstart.md). No live calls anywhere.

**Target Platform**: the existing web container and worker, on local Docker Compose and on Neon. Uses
only row locks and foreign keys — no advisory locks, no `LISTEN`, nothing session-level.

**Project Type**: single Next.js web app plus worker, the layout of 001–040.

**Performance Goals** (SC-003, SC-008):

- a duplicate generate costs one indexed `SELECT` and zero model calls, answering in read time;
- an ingest call of any size costs one extra `SELECT` for the whole call;
- a job item costs one extra `SELECT` before the model and one extra `INSERT` at save;
- a post read costs one extra indexed `SELECT`;
- all lookups hit the ledger's primary key or `external_item_claims_post_idx`, so a project with
  ~100,000 claims behaves like an empty one.

**Constraints**:

- the claim and the post commit together or not at all (FR-007), and nothing else may insert a claim;
- the ledger check happens before any model call (FR-014);
- no lock is taken on a not-yet-existing claim: ingest is advisory and the runner is authoritative;
- skipped items reserve no image and consume no item allowance (FR-018);
- `deriveJobStatus` stays the only writer of a job's status, and a skip is never a failure (FR-021);
- untagged submissions behave exactly as today, in the app and the API (FR-005);
- the `Idempotency-Key` protocol is untouched (F16);
- no secret, key hash or `Idempotency-Key` value in any new response, row, view or log line.

**Scale/Scope**:

| Area | New | Edited |
|---|---|---|
| Schema / migration | `drizzle/0019_external_item_ledger.sql` | `schema/posts.ts`, `schema/jobs.ts`, `db/project-owned.ts` |
| DAL | `dal/external-claims.ts` | `dal/scope.ts`, `dal/jobs.ts` (`JobCounts`) |
| Shared lib | `lib/jobs/skipped.ts` | `lib/validation/api.ts`, `lib/api/schemas.ts` |
| Services | `services/jobs/claims.ts` | `generation/save.ts`, `generation/single.ts`, `generation/series.ts`, `jobs/create.ts`, `jobs/append.ts`, `jobs/status.ts`, `jobs/read.ts`, `jobs/runner.ts`, `jobs/sources/{api,types,csv,media}.ts`, `views/post.ts`, `views/load.ts`, `views/job.ts`, `webhooks/emit.ts`, `scheduler/generation.ts` |
| API | — | `operations/generate.ts`, `operations/jobs.ts` |
| App | — | `jobs/[jobId]/page.tsx`, `jobs/[jobId]/JobItemsTable.tsx`, `components/ui/StatusBadge.tsx` |
| Docs | — | `docs/n8n.md` (new section), `docs/generator.md` (§ Jobs), `docs/decisions.md` (`## 041`) |

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle / constraint | How this plan complies | Status |
|---|---|---|
| I. Verified facts over memory | No platform API is involved, so `docs/research/` has nothing to contribute. Every behaviour relied on is cited from this repository's own code (findings F1–F19), and the one library fact used — `DatabaseError.constraint` — was read from the installed `pg-protocol` types and then deliberately *not* depended on (D7). Next is touched only in existing server components, against the installed docs. No `NEEDS RESEARCH`, no `NEEDS DEPENDENCY`. | PASS |
| II. Nothing is "working" unless it ran | Every FR and SC maps to a real-Postgres test in quickstart.md, including atomicity (interrupted save), the two races, the 8-day/rotated-key case and the documented `http` blocks. The browser check is listed separately, last, and is not claimed as proof. No provider or model is called for real. | PASS |
| III. Project isolation is enforced in one place | The ledger is reached only through `scope.externalClaims`; `createExternalClaimsRepo` pins `project_id` on every query, the table is registered in `project-owned.ts`, and the global scope recorder fails the suite on an unpinned query. Its FK to `posts` is **project-composite**, so a claim can never name another project's post. Services and operations import no DAL client (the `api-imports` lint rule). The permissions are the existing `generate` / `manage_jobs`, checked by `need()` inside the transaction. | PASS |
| IV. One service layer, many callers | One claim insert (`saveGeneratedPost`), one ingest filter (`dropAlreadyPosted`) shared by create and append, one skip-reason sentence (`lib/jobs/skipped.ts`) shared by the API and the app, one status derivation (`deriveJobStatus`). The UI, the API and the runner all go through the same services; nothing is duplicated per caller. | PASS |
| V. Providers are plug-ins; a missed post beats a duplicate post | No provider folder, scheduler, composer or publish path changes. The feature *is* principle V applied to generation: a consumed id is never released, a deleted post does not free its id, and an ambiguous outcome (a claim lost mid-save) resolves to "do nothing" rather than "post again". | PASS |
| VI. Boring, few dependencies | No runtime or dev dependency, no queue, no cache, no background job. One additive migration; one new table with four columns. The new terminal status reuses the existing item machine rather than adding a parallel one. | PASS |
| VII. Secrets never leak | Nothing here touches credentials. New responses carry ids, counts, instants and user-facing sentences only; the runner's log line keeps its fixed vocabulary (`outcome=skipped`) and carries no caller data; the `no-secrets` suites are extended to the new responses and rows. | PASS |
| Neon / transaction-mode pooler | Row locks and foreign keys only; the ingest filter takes no lock at all. No advisory locks, no `LISTEN`. Migrations run on the direct URL as today. | PASS |
| Scheduler constraints | `runTick()` gains two indexed queries per item and no new work: the pre-check runs outside any transaction, and the claim insert is inside the save transaction that already exists. No model, storage or sharp work is added inside a held transaction. A kill mid-run leaves the item `running` with an expired lease, exactly as today, and the claim either committed with the post or not at all. | PASS |
| Times in UTC, Temporal with explicit DST | `claimed_at` is `timestamptz` written from the DAL clock; no wall-time maths and no new time formatting. | PASS |
| Accessibility / `docket-ui` | The UI change is one badge (text plus tone, never colour alone), one counter in the existing `dl`, one filter tab and one table cell, all in existing patterns. The `docket-ui` skill is read before the UI task; the browser check covers keyboard and focus. | PASS |
| Commits, docs and decisions | This phase commits its own artifacts. `docs/decisions.md` gains `## 041` and `docs/n8n.md` a tagging section (with a test that replays it), `docs/generator.md` the skipped item state. Conventional Commits with explicit paths. | PASS |

**Gate result**: PASS. Complexity Tracking has nothing to justify.

**Post-design re-check (after Phase 1)**: PASS, unchanged. The design adds:

- one table, one column, one enum value, one unique constraint (all additive);
- one DAL repository with four read/write methods;
- one optional argument on `saveGeneratedPost`, two optional fields on `generateSingleSchema`, one
  optional field on `apiItemSchema` and one on `apiSourceSchema`;
- one shared ingest filter and one shared wording helper;
- one counter on `JobCounts` and one on `GenerationCounts`.

No existing rule gains a second implementation, no existing caller changes behaviour when it sends
nothing new, and the 007/008/009 suites guard that.

## Project Structure

### Documentation (this feature)

```text
specs/041-external-id-ledger/
├── plan.md              # This file
├── research.md          # Phase 0: findings F1–F19, decisions D1–D14
├── data-model.md        # Phase 1: the table, the migration, validation, state transitions, volumes
├── quickstart.md        # Phase 1: test map, how to run it, walk-throughs
├── contracts/
│   ├── http-api.md      # request and response additions, status matrices, OpenAPI
│   └── services.md      # DAL repo, service signatures, flows, UI, invariants
├── checklists/
│   └── requirements.md  # from /speckit-specify
└── tasks.md             # Phase 2 (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
drizzle/
├── 0019_external_item_ledger.sql          # NEW (generated): enum value, posts unique, item column, ledger table
└── meta/0019_snapshot.json, _journal.json
src/
├── lib/
│   ├── api/schemas.ts                     # Post.source, JobItem.externalId/skipped, JobCounts.skipped, CreatedJob
│   ├── validation/api.ts                  # externalIdSchema, sourceKeySchema, DEFAULT_SOURCE_KEY, apiItem/apiSource/apiSourceMeta
│   └── jobs/
│       ├── skipped.ts                     # NEW pure: alreadyPostedReason(externalId)
│       └── skipped.test.ts                # NEW
├── server/
│   ├── db/
│   │   ├── schema/posts.ts                # + unique (project_id, id)
│   │   ├── schema/jobs.ts                 # + external_id, + 'skipped' status, + its check
│   │   ├── schema/external-claims.ts      # NEW table (exported from schema/index.ts)
│   │   └── project-owned.ts               # + external_item_claims
│   ├── dal/
│   │   ├── external-claims.ts             # NEW ExternalClaimsRepo
│   │   ├── scope.ts                       # + externalClaims (also in createSchedulingRepos)
│   │   └── jobs.ts                        # JobCounts.skipped, emptyCounts
│   ├── scheduler/generation.ts            # GenerationCounts.skipped
│   ├── api/operations/
│   │   ├── generate.ts                    # externalId/sourceKey in, alreadyPosted out, 409 response
│   │   └── jobs.ts                        # source.sourceKey, items[].externalId, skippedAlreadyPosted, status=skipped
│   └── services/
│       ├── generation/
│       │   ├── save.ts                    # optional external → claim insert (the one write path)
│       │   ├── single.ts                  # ledger pre-check, schema fields, unique-violation recovery
│       │   └── series.ts                  # omit the new fields from planSeriesSchema
│       ├── jobs/
│       │   ├── claims.ts                  # NEW dropAlreadyPosted (shared by create and append)
│       │   ├── create.ts                  # filter, skippedAlreadyPosted, all-skipped refusal, insert external_id
│       │   ├── append.ts                  # filter before the limit and the media checks
│       │   ├── status.ts                  # skipped in derive and in insertItems' base
│       │   ├── read.ts                    # JobItemView.externalId/skipped, status filter
│       │   ├── runner.ts                  # pre-check skip, save-time skip, counts
│       │   └── sources/{types,api,csv,media}.ts   # SourceItem.externalId, sourceKey in meta
│       ├── views/{post,load,job}.ts        # Post.source, JobItem mapping
│       └── webhooks/emit.ts                # EmitRepos + externalClaims; post body carries source
└── app/p/[projectSlug]/jobs/[jobId]/
    ├── page.tsx                            # Skipped counter + Skipped filter tab
    └── JobItemsTable.tsx                   # Skipped badge, Detail column
src/components/ui/StatusBadge.tsx           # skipped → "Skipped", neutral
tests/
├── integration/generation/external-id.test.ts                # NEW
├── integration/generation/external-id-race.test.ts           # NEW
├── integration/generation/external-id-atomic.test.ts         # NEW
├── integration/limits/external-id-validation.test.ts         # NEW
├── integration/jobs/external-id-ingest.test.ts               # NEW
├── integration/jobs/external-id-late-skip.test.ts            # NEW
├── integration/docs/external-id.test.ts                      # NEW
└── (extended) integration/jobs/{create,cancel,reservation,ui,no-secrets}.test.*,
    integration/api/{endpoints/generate,endpoints/jobs,openapi,scope-enforcement,idempotency-generate}.test.ts,
    integration/webhooks/*, integration/generation/no-secrets.test.ts,
    src/server/services/jobs/status.test.ts
docs/
├── n8n.md                                  # "9. Post each record once" (+ the test that replays it)
├── generator.md                            # § Jobs: the skipped item state
└── decisions.md                            # ## 041 (written in this phase)
```

**Structure Decision**: the existing single-app layout, unchanged. The ledger is a DAL repository like
every other project-owned table; its rules live in `src/server/services/`; the shapes and the wording
live in `src/lib/` so the app and the API share them. Nothing new is introduced at the top level.

## Complexity Tracking

No violations. Nothing to justify.
