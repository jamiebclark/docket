# Implementation Plan: Public API to retry, bulk-retry and resolve failed and ambiguous targets

**Branch**: `016-api-retry-resolve` | **Date**: 2026-10-07 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/016-api-retry-resolve/spec.md`

## Summary

Three new public API operations expose the recovery services that 012 and 015 finished. An automation reacting to `post.failed` can then act on its own.

**Operations.** Each operation makes one call to an existing service and maps the result (research P1, P2, P9, P10):

- `POST /posts/{postId}/targets/{targetId}/retry` (`retryPostTarget`) calls `retryTarget`;
- `POST /posts/{postId}/targets/{targetId}/resolve` (`resolvePostTarget`) calls `resolveAmbiguous`;
- `POST /targets/retry-failed` (`retryFailedTargets`) calls `retryAllFailed`.

They share these properties:

- they live in a new `src/server/api/operations/targets.ts` with the tag `Recovery`;
- they need `write_posts` (D2) and are idempotent;
- their request and response schemas are strict and shared, in `src/lib/api/schemas.ts`.

**Small additive service changes.** None changes UI behaviour:

- **Pairing (P3).** An optional `{ postId }` on `withLockedTarget`, `retryTarget` and `resolveAmbiguous` returns `404` for a target on another post. The check runs before any write.
- **Refusal reasons (P4).** `ConflictError` gains an optional `reason`. It is set at the existing throw sites (`publishing`, `not_failed`, the three blocked keys, `already_resolved`, `cannot_publish`). `mapServiceError` puts it in `409` `details.reason`.
- **Attribution (P5, P6).** `actorRefs(scope)` is the one helper, with `attemptActor`/`resolverColumns` built on it. It never writes `""`, which fixes the creator-deleted 500. Two nullable columns record the key, `publish_attempts.actor_api_key_id` and `post_targets.resolved_by_api_key_id`, each with a project-composite FK. They arrive in the committed migration `0010_api_key_attribution`.
- **Attempt log (P7).** Entries made by a key show "API key {name}" or "Removed API key". `toAttemptViews` resolves the name, and a pure `attemptActorLabel` renders it on the Failures page and the post page.
- **Idempotency (P8).** Single retry and resolve use the default mode: the effect, the webhook rows and the stored answer commit together. Bulk uses a new `self_commit` mode, which behaves like `generate`, so 015's per-target transactions are kept.
- **Bulk message (P15).** `retryAllMessage(…, { continueWith: "call" })` ends with "Call again with a new Idempotency-Key to continue."

**OpenAPI (P11).** Operations can declare `examples` on the request and on each response status. The three operations do so for 200/400/401/403/404/409/422/429.

**Docs (P14).**

- a "Recover failed posts" recipe in `docs/n8n.md`, plus the new 409 reasons in its errors table;
- an API note in `docs/failures.md`;
- `## 016` in `docs/decisions.md`, written in this phase.

No new dependency, no new permission value, no new webhook event, and no change to retry, bulk or resolve semantics.

## Technical Context

**Language/Version**: TypeScript 5 (strict) on Node 24 LTS.

**Primary Dependencies**: all already installed.

- **Next.js 16.3.8**: only two server-component pages change, each one expression. The existing `src/app/api/v1/[[...path]]` route is untouched. Read `node_modules/next/dist/docs/01-app/` before editing pages (AGENTS.md).
- **`zod` 4.6.5**: `z.strictObject` and nested `z.discriminatedUnion`, probed in this phase (research F16).
- **`zod-openapi` 6.0.2**: `examples` on media-type objects, probed in this phase.
- **Drizzle ORM 0.45.3 / drizzle-kit 0.31.11**: used for the two columns and the generated migration.

**Storage**: PostgreSQL.

- New: `publish_attempts.actor_api_key_id` and `post_targets.resolved_by_api_key_id`, both nullable `uuid` with composite FKs to `api_keys(project_id, id)`.
- Writes through the existing services: `post_targets`, `publish_attempts`, `posts.status`, webhook delivery rows and `api_idempotency`.

Details are in [data-model.md](./data-model.md).

**Testing**: Vitest against real Postgres (run-scoped databases), with the mock provider, the `atTime` clock and `tests/helpers/api.ts`. Five new API integration files, five extended suites and one new unit file. The map is in [quickstart.md](./quickstart.md). No live calls.

**Target Platform**: the existing web container (the API route) on local Docker Compose and Neon. It uses no session-level Postgres features: only row locks, savepoints and FKs.

**Project Type**: a single Next.js web app plus worker. The layout is the same as 001–015.

**Performance Goals**:

- A single retry or resolve costs one service transaction, plus the idempotency claim and the stored-answer update.
- Bulk performance is 015's (about 2–3 s measured for 100 requeues, SC-008 ≤ 10 s). The API adds one claim and one store.
- A call counts once against the key's rate limit.

**Constraints**:

- No wrapper transaction around bulk (FR-014).
- Pairing is checked before any write (FR-013).
- No `5xx` for any documented outcome (FR-012).
- No secret, hash, `last4` or `Idempotency-Key` value in any response, attempt summary or view (FR-026).
- Member and engine writes are unchanged (FR-022).

**Scale/Scope**:

| Area | New | Edited |
|---|---|---|
| API | `operations/targets.ts`, `operations/issues.ts` | `operations/index.ts`, `posts.ts` (import `toIssue`), `types.ts`, `errors.ts`, `idempotency.ts`, `openapi.ts` |
| Shared lib | `src/lib/failures/attempt-actor.ts` | `src/lib/api/schemas.ts`, `retry-all-text.ts` |
| Services and DAL | — | `dal/errors.ts`, `dal/scope.ts`, `dal/attempts.ts`, `posts/locked.ts`, `posts/retry.ts`, `posts/index.ts` (`resolveAmbiguous`), `failures.ts` |
| Schema | migration `0010` | `schema/attempts.ts`, `schema/posts.ts` |
| Pages | — | 2 (one expression each) |
| Docs | — | `n8n.md`, `failures.md`, `decisions.md`, README clause |

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle / constraint | How this plan complies | Status |
|---|---|---|
| I. Verified facts over memory | No platform facts. Every behaviour cited is read from the code (research F1–F18). Zod nested discriminated unions and zod-openapi `examples` were probed with the installed versions. Next is touched only in two server pages, against the installed docs. No `NEEDS RESEARCH`. | PASS |
| II. Nothing is "working" unless it ran | Every FR-030 item maps to a real-Postgres integration test (quickstart). The F12 defect gets a regression test (creator deleted → 200, not 500). The manual walk-through is listed separately and not claimed. | PASS |
| III. Project isolation in one place | The operations use only `ProjectScope` and services, with no DAL or raw DB import (the `tests/lint/api-imports.test.ts` rule). Path ids are declared `resourceParams` and covered by the cross-project scope test. Pairing returns 404 inside the scoped transaction. New key columns have **project-composite** FKs, so an attempt can never reference another project's key. A foreign `accountId` matches nothing (015 D8). `write_posts` → `post: ['schedule']` is checked by the pipeline and again by the service under the lock. | PASS |
| IV. One service layer, many callers | Each operation calls exactly one existing service (FR-002), and no retry, resolve, slot, gate or lock logic is copied. Refusal reasons come from the existing predicates (`retryBlockedKey`). The bulk message reuses `retryAllMessage`. Attribution has one helper (`actorRefs`) for every write. | PASS |
| V. Providers are plug-ins; ambiguous never auto-retried | No provider change. Retry refuses `ambiguous` (`409 not_failed`). Resolve needs an explicit caller decision. The recipe tells automations never to retry ambiguous targets. | PASS |
| VI. Boring, few dependencies | No new runtime or dev dependency, and no infrastructure. One additive migration of two nullable columns. | PASS |
| VII. Secrets never leak | Responses carry ids, statuses, instants, reasons and user-facing sentences only. Attempt summaries are unchanged. The view shows the key's **name** only, never `last4` or the hash. The secret-scan test is extended to the new responses, rows and page. Unexpected errors keep the generic body and the `redact()` log. | PASS |
| Neon / transaction-mode pooler | Row locks, savepoints and FKs only. No advisory locks, no `LISTEN`. | PASS |
| Scheduler constraints | `runTick` is untouched. The API path takes the same post → targets lock order as the UI. The tick never waits (`SKIP LOCKED`). No provider call happens in any of these transactions. | PASS |
| Times in UTC, Temporal with explicit DST | Instants arrive with explicit offsets and are compared and stored in UTC. `scheduledAtLocal` comes from the existing `plannedTime`. No new time maths. | PASS |
| Accessibility / `docket-ui` | The only UI change is the actor label text in two existing table cells. | PASS |
| Commits, docs and decisions | This phase commits the plan artifacts and the `docs/decisions.md` `## 016` section with explicit paths. Docs updates are planned (P14). | PASS |

**Gate result**: PASS. Complexity Tracking has nothing to justify.

**Post-design re-check (after Phase 1)**: PASS, unchanged. The design adds:

- no second implementation of any rule;
- one optional parameter on three service functions (`opts.postId`);
- one optional property on `ConflictError`;
- one idempotency mode name with the existing `generate` behaviour;
- one optional parameter on `retryAllMessage`;
- two nullable, project-pinned columns.

All existing callers compile and behave unchanged, and the 012/015 suites guard that.

## Project Structure

### Documentation (this feature)

```text
specs/016-api-retry-resolve/
├── plan.md              # This file
├── research.md          # Phase 0: findings F1–F18, decisions P1–P15
├── data-model.md        # Phase 1: migration, attribution values, actor view, transitions, reasons
├── quickstart.md        # Phase 1: test map, final pass, manual walk-through
├── contracts/
│   ├── http-api.md      # the three operations: requests, 200 alternatives, 409 reasons, OpenAPI
│   └── services.md      # ConflictError reason, pairing opts, actorRefs, views, idempotency mode, operations
├── checklists/
│   └── requirements.md  # from /speckit-specify
└── tasks.md             # Phase 2 (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
drizzle/
├── 0010_api_key_attribution.sql          # NEW (generated): two columns + two composite FKs
└── meta/0010_snapshot.json, _journal.json
src/
├── lib/
│   ├── api/schemas.ts                    # + Retry/Resolve/RetryFailed request & result schemas
│   └── failures/
│       ├── attempt-actor.ts              # NEW pure: AttemptActor type, attemptActorLabel
│       ├── attempt-actor.test.ts         # NEW
│       └── retry-all-text.ts             # retryAllMessage(…, { continueWith })
├── server/
│   ├── api/
│   │   ├── errors.ts                     # ConflictError.reason → details.reason
│   │   ├── idempotency.ts                # "self_commit" handled like "generate"
│   │   ├── openapi.ts                    # request/response examples
│   │   └── operations/
│   │       ├── targets.ts                # NEW: retryPostTarget, resolvePostTarget, retryFailedTargets
│   │       ├── issues.ts                 # NEW: toIssue, toWarning (shared with posts.ts)
│   │       ├── posts.ts                  # imports toIssue/toWarning
│   │       ├── types.ts                  # idempotencyMode, examples
│   │       └── index.ts                  # registers targetOperations
│   ├── db/schema/{attempts,posts}.ts     # actorApiKeyId, resolvedByApiKeyId + FKs
│   ├── dal/
│   │   ├── errors.ts                     # ConflictError opts { field?, reason? }
│   │   ├── scope.ts                      # actorRefs, attemptActor, resolverColumns; actorColumns on actorRefs
│   │   └── attempts.ts                   # AttemptEntry.actorApiKeyId
│   └── services/
│       ├── failures.ts                   # toAttemptViews: api_key actor
│       └── posts/
│           ├── locked.ts                 # withLockedTarget opts.postId
│           ├── retry.ts                  # reasons, attemptActor, retryTarget opts
│           └── index.ts                  # resolveAmbiguous: reasons, resolverColumns, attemptActor, opts
└── app/p/[projectSlug]/
    ├── failures/page.tsx                 # attemptActorLabel
    └── posts/[postId]/page.tsx           # attemptActorLabel
tests/integration/
├── api/endpoints/
│   ├── retry-target.test.ts              # NEW
│   ├── resolve-target.test.ts            # NEW
│   ├── retry-failed-targets.test.ts      # NEW
│   ├── recovery-idempotency.test.ts      # NEW
│   └── recovery-attribution.test.ts      # NEW
├── api/scope-enforcement.test.ts         # + 3 fixtures
├── api/openapi.test.ts                   # + examples assertions for the 3 ops
├── security/secret-scan.test.ts          # + the 3 ops, rows and page
└── failures/attempts.test.ts             # + api_key actor views
docs/
├── n8n.md                                # "7. Recover failed posts" + 409 reasons
├── failures.md                           # "Through the API"
└── decisions.md                          # ## 016 (written in this phase)
```

**Structure Decision**: the existing single-app layout. The API adapter lives beside the other operation modules. Shared shapes and wording live in `src/lib/` so the pages and the API share them. Every rule stays in `src/server/services/`.

## Complexity Tracking

No violations. Nothing to justify.
