# Phase 1 — Quickstart: validating the external item ID ledger

**Feature**: 041-external-id-ledger | **Date**: 2026-10-10

How to prove this entry works. Shapes and rules are in [contracts/](./contracts/) and
[data-model.md](./data-model.md) — this file is only the run guide.

## Prerequisites

- Node 24 LTS, pnpm, dependencies already installed (pipeline phases cannot reach the registry).
- Postgres reachable at `DATABASE_URL`; Vitest creates run-scoped databases
  (`tests/setup/test-databases.ts`) and migrates them, so the new migration must be committed before
  the suite will pass.
- No model credentials needed: the generation tests use `createFakeLlm` (`tests/helpers/fake-llm.ts`),
  and the API tests use `tests/helpers/api.ts` (`api`, `createKey`). No live calls (constitution II).
- Nothing in this entry needs storage, ffmpeg or a provider credential.

```bash
pnpm db:generate            # once, after the schema edits: writes drizzle/0019_*
pnpm db:check               # schema and migrations in step
```

## Test map

Every functional requirement and success criterion below is proved by a real-Postgres test. New files
are marked **NEW**.

### The ledger itself

| File | Proves |
|---|---|
| **NEW** `tests/integration/generation/external-id.test.ts` | FR-001, FR-006, FR-007, FR-008, FR-013, FR-014: a tagged generate makes a post and a claim; a second call returns the same post, `existing: true`, and the fake model records **zero** calls; the claim names the post and its `claimedAt`. |
| **NEW** `tests/integration/generation/external-id-race.test.ts` | FR-015, SC-005: N `generateSingle` calls for one unclaimed id started together → exactly one post, the rest answered as existing, zero errors. |
| **NEW** `tests/integration/generation/external-id-atomic.test.ts` | FR-007, FR-009: a save that throws after the post insert leaves neither post nor claim; a model failure (`invalid_output`, no model configured) leaves the id unclaimed and the next call generates. |
| **NEW** `tests/integration/limits/external-id-validation.test.ts` | FR-004, FR-005, D2: blank, whitespace-only, 201-character and malformed-`sourceKey` inputs are refused with the field named; an untagged request writes no claim; `Glen-42` and `glen-42` are two records; the same id in two `sourceKey`s both post; the same id in two projects both post (FR-012, spec edge cases). |

### Jobs — ingest

| File | Proves |
|---|---|
| `tests/integration/jobs/create.test.ts` (extended) | FR-016, FR-020: `skippedAlreadyPosted` on create; a non-open job with everything skipped is refused naming the count; an open one is created empty and stays open. |
| **NEW** `tests/integration/jobs/external-id-ingest.test.ts` | FR-016–FR-019, SC-002: 10 items then the same 10 plus 5 → `added: 5`, `skippedAlreadyPosted: 10`, item count 15, 15 posts; one call containing an id twice keeps one and counts one skipped; an invalid item still refuses the whole call; 500 already-posted plus 3 new is accepted (the limit is counted after skipping). |
| `tests/integration/jobs/reservation.test.ts` (extended) | FR-018: a skipped item's image is left unreserved and another job can take it. |

### Jobs — running

| File | Proves |
|---|---|
| **NEW** `tests/integration/jobs/external-id-late-skip.test.ts` | FR-021, FR-022, AS 2.7: an item whose id is claimed after ingest ends `skipped`, with no post; the job finishes `completed`, not `completed_with_failures`; `retry-failed` does not pick it up; its image is free; a claim that lands *during* the model call still ends as a skip (D7/D9 — forced by claiming the id from a second connection between the model call and the save). |
| `tests/integration/jobs/cancel.test.ts` (extended) | Cancelling a job leaves `skipped` items alone (F6); a cancelled or permanently failed item's id is re-submittable (AS 2.8). |
| `src/server/services/jobs/status.test.ts` (extended) | FR-021, D10: `deriveJobStatus` with `skipped` counts — finished, not failed; `worked` true when only skips happened. |

### Visibility

| File | Proves |
|---|---|
| `tests/integration/api/endpoints/generate.test.ts` (extended) | `alreadyPosted` on 201 and 200; the `409 conflict` with `details.reason: "already_posted_post_deleted"` after the post is deleted (FR-010); `Post.source` on the read-back (FR-023); `source: null` for an untagged post (US3.3). |
| `tests/integration/api/endpoints/jobs.test.ts` (extended) | FR-024: `JobItem.externalId`, `status: "skipped"`, `skipped.reason`/`.postId`, `error: null`; `?status=skipped`; `JobCounts.skipped`. |
| `tests/integration/jobs/ui.test.tsx` (extended) | FR-025: a skipped item renders the "Skipped" badge with a neutral tone and its reason in the Detail column, is not styled or counted as a failure, and offers no retry action. |
| `tests/integration/api/openapi.test.ts` (extended) | FR-026: `externalId`, `sourceKey`, `alreadyPosted`, `source`, `skipped` and the new `409` appear in the generated document with descriptions. |
| `tests/integration/webhooks/*` (extended) | F9: a `post.published` body carries `source`, and a `job.finished` body carries `counts.skipped`. |

### Isolation, idempotency and secrets

| File | Proves |
|---|---|
| `tests/integration/api/scope-enforcement.test.ts` (extended) | FR-012: a key for another project sees nothing of this project's ledger; the global scope recorder proves every claim query is project-pinned. |
| `src/server/db/project-owned.test.ts` | The new table is registered exactly once. |
| `tests/integration/api/idempotency-generate.test.ts` (extended) | The spec's "Tagged and keyed" case: a retry of the exact request replays the stored answer; a *different* request carrying an already-posted id is answered from the ledger; FR-011/SC-004: the ledger still holds 8 days later (`atTime` clock) and after the original key is revoked and replaced. |
| `tests/integration/jobs/no-secrets.test.ts`, `tests/integration/generation/no-secrets.test.ts` (extended) | No credential appears in the new responses, rows, log lines or views. |

### Docs

| File | Proves |
|---|---|
| **NEW** `tests/integration/docs/external-id.test.ts` | FR-026 and constitution II: the fenced `http` blocks of the new `docs/n8n.md` section are replayed against the real API and produce the documented statuses and bodies (F19 — the existing `n8n-flow` test stops before section 7). |

### Performance

SC-008 is asserted inside `tests/integration/jobs/external-id-ingest.test.ts`: with ~1,000 pre-seeded
claims for the project (enough to exercise the index; 100,000 rows would make the suite slow for no extra
signal), a 100-item append completes well inside the existing per-test budget and issues **one** claim
query, asserted by counting statements through the scope recorder.

## Running it

Per task, only what the task touched:

```bash
pnpm vitest run tests/integration/generation/external-id.test.ts
pnpm vitest run tests/integration/jobs            # the jobs suite
pnpm typecheck                                    # when types changed
pnpm lint <changed files>
```

Once, at the end of the implement phase (the final pass):

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm db:check                                     # the schema changed
pnpm build                                        # server/client boundaries and API route touched
```

Do not run the full suite or `pnpm build` after every task (constitution § Quality gates).

## End-to-end walk-through (API, no browser)

With the app running (`pnpm dev`) and a key holding `generate` and `manage_jobs`:

1. `POST /api/v1/generate` with `{"brief": "…", "accountIds": ["…"], "externalId": "glen-42"}`
   → `201`, `alreadyPosted: false`, and `post.source = { key: "default", externalId: "glen-42" }`.
2. Repeat the same call with a *different* brief and no `Idempotency-Key`
   → `200`, `alreadyPosted: true`, the same `post.id`, and no new generation in the activity list.
3. Revoke the key, make a new one, repeat → still `200` with the same post (FR-011).
4. Delete that post in the app, repeat → `409` with `details.reason: "already_posted_post_deleted"`.
5. `POST /api/v1/jobs` with `source.kind: "api"`, `open: true`, `sourceKey: "walkthrough"` and three
   tagged items → `201`, `skippedAlreadyPosted: 0`.
6. `POST /api/v1/jobs/{id}/items` with the same three plus two new → `201`, `added: 2`,
   `skippedAlreadyPosted: 3`.
7. Let the tick run, then `GET /api/v1/jobs/{id}/items` → the five items are `done`, each with its
   `externalId`; the job's `counts.skipped` is 0 and its status is `running` (still open).

## Manual browser check (last, and optional)

Park this until every automated task is done; it needs a human at a browser and must never block the
implement loop. On the job page of a job that has a late-skipped item, confirm: the item shows a neutral
**Skipped** badge, the Detail column explains which record was already posted and links to that post,
the Skipped counter is present, the Skipped tab filters to it, no retry button is offered, and the page
is fully keyboard-navigable with visible focus (constitution § Accessibility, `docket-ui`).
