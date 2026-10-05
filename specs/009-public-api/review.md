# Review: Public API, API keys, idempotency, webhooks and OpenAPI (009), re-review after remediation

This is a **re-review**, so it is scoped. The constitution says a re-review "checks ONLY that each earlier finding is fixed and that the files changed by the remediation introduced no regression". The first review is in git at `e02ca1d`/`66d6acb`. It swept every category over the full 168-file feature diff and found five MAJOR findings (F1–F5) and seven MINOR (F6–F12).

The feature has already been merged to `main` (PR #14, merge `a50f8ba`). Its branch tip is `b2192e9` (`origin/009-public-api`), on base `8236798`. The 010 hardening entry has since landed on top of it. This review covers:

- **Remediation diff, read in full:** 7 commits and 14 files, `66d6acb..b2192e9`.
  - `3ad09bb` (F1): `src/server/services/jobs/{append,create}.ts`, `tests/integration/api/endpoints/jobs.test.ts`
  - `a78e16e` (F2): `src/server/dal/media.ts`, `src/server/services/media.ts`, `tests/integration/api/endpoints/media.test.ts`
  - `851ce38` (F3): `src/server/api/openapi.ts`, `src/server/api/operations/generate.ts`, `tests/integration/api/openapi.test.ts`
  - `f3415a7` (F4): `src/server/api/operations/jobs.ts`, `src/server/services/jobs/read.ts`, `src/server/services/views/{job,load}.ts`, `tests/integration/api/endpoints/jobs.test.ts`, `tests/lint/api-imports.test.ts`
  - `ea1781c` (F5): `docs/decisions.md`
  - `23f8692` and `b2192e9`: `src/server/net/safe-fetch.ts`. These two body-timeout fixes came after the first review.
- **Present state on `main`, checked:** each of the files above as it is now. `git diff b2192e9 main` shows that 010 changed only `handle.ts`, `safe-fetch.ts`, `media.ts` and `webhooks/*` in the 009 area. I also checked whether F6–F12 are still open on `main`.
- **Not re-reviewed:** the rest of the 168-file feature diff. The first review covered it, and the constitution's re-review rule excludes new lines of inquiry.

**Probes:**
- I ran `pnpm vitest run tests/lint/api-imports.test.ts tests/integration/api/openapi.test.ts tests/integration/api/endpoints/jobs.test.ts tests/integration/api/endpoints/media.test.ts` on `main`: 4 files and 62 tests passed. These files hold the regression tests for F1–F4.
- I checked that every constant F5 names in `docs/decisions.md` exists in the file it names (18 of 18, by `git grep` at `b2192e9`).
- I did not re-run the full suite, lint, typecheck or build, per the constitution's review rule. I could not read CI for PR #14 because `gh` could not reach `api.github.com` from the sandbox (TLS verification failure).

## Verdict

The remediation holds. Each of the five MAJOR findings is fixed where it was found. Each fix has a regression test that fails on the old behaviour, and none of the changed files breaks anything I could find:

- **F1:** `appendItems` now runs the same `assertRenderedFits` helper as `createJob`.
- **F2:** `getMedia` reads the reservation.
- **F3:** every declared error status keeps the shared Error schema.
- **F4:** the three job read operations go through the job services, with a lint rule that blocks direct repo access.
- **F5:** `docs/decisions.md` now has the spec-time decisions, the interim limits with their files, the `url_*` codes and a *Reverse* line for every plan.md generic change.

Nothing blocks the merge (it has already been merged).

What remains:
- The seven MINOR findings from the first review are still open on `main`.
- `tasks.md` still shows the five remediation tasks unticked, though their work is committed (F13).
- The F4 refactor added a few more queries per job item on the API item list (F14).
- It also left two job-summary builders side by side (N15).

None of these is MAJOR or a BLOCKER. They belong with the hardening follow-ups.

## Findings

- [x] MAJOR F1 — `appendItems` skips the rendered-instructions limit that `createJob` enforces. **Resolved.**
      where:  src/server/services/jobs/append.ts:36, src/server/services/jobs/create.ts:51, src/server/services/jobs/create.ts:59-75, tests/integration/api/endpoints/jobs.test.ts:121-130
      why:    The check is now one exported helper, `assertRenderedFits`, called by both `checkTemplate` (create) and `appendItems`. The append call comes after `prepareApiItems`, before `insertItems` and inside the job-row lock, so a refusal adds nothing. The issue names `items.<i>`. The new test sends a 12,000-character field, which is under `JOB_ITEM_DATA_MAX` but renders over 10,000. It expects 400 `validation_failed` naming `items.1`, and `itemCount` 0 afterwards. That test would have failed before the fix.
      traces: FR-028, FR-031, US4 AS6

- [x] MAJOR F2 — `GET /media/{mediaId}` always reports `reservedByJobId: null`. **Resolved.**
      where:  src/server/dal/media.ts:74, src/server/dal/media.ts:214-221, src/server/services/media.ts:264-265, tests/integration/api/endpoints/media.test.ts:151-164
      why:    `MediaRepo.reservedJobFor` reuses the list's `reservedJobExpr` under `mine(id)`, so the list and the single read now share one reservation rule. The test reserves one of two images through a real `createJob` and checks both ids: the reserved image returns the job id and the free one returns `null`.
      traces: FR-019

- [x] MAJOR F3 — error responses an operation declares itself have no shared Error schema in `openapi.json`. **Resolved.**
      where:  src/server/api/openapi.ts:49-60, src/server/api/openapi.ts:76-79, src/server/api/operations/generate.ts:26-31, src/server/api/operations/generate.ts:47-48, tests/integration/api/openapi.test.ts:116-135
      why:    For a declared status ≥ 400, `buildOperation` now calls `errorResponse(status, ownDescription, headers)`. The operation's text replaces only the description lead, and the Error schema, the `Codes:` list, `X-Request-Id`, `Idempotent-Replayed` and `Retry-After` (429/503) all stay. `errorStatuses` still drops declared statuses, so nothing is emitted twice. `generatePost`'s 200 and 201 share `GeneratedSchema`. The new test walks every response ≥ 400 of every operation and asserts the `$ref`, the codes and the headers.
      traces: FR-043, US6 AS2, SC-009

- [x] MAJOR F4 — job read operations call DAL repos directly, and T052's service additions for them are never used. **Resolved.**
      where:  src/server/api/operations/jobs.ts:66, src/server/api/operations/jobs.ts:133, src/server/api/operations/jobs.ts:154, src/server/services/views/job.ts:36-61, src/server/services/jobs/read.ts:86-105, tests/lint/api-imports.test.ts:13, tests/lint/api-imports.test.ts:44-47
      why:    The three operations now call the read services:
      - `listJobs` with `limit+1`/`offset`, which stays within the services' `max(500)` because `PAGE_LIMIT_MAX` is 100;
      - `listJobItems`, which now does the 404 check through `getJobRow`;
      - `getJobItem`.

      They map the results with `toApiJobSummaryFromList` and `toApiJobItem(JobItemView)`. `views/load.ts`'s duplicate `loadApiJobItems`/`loadApiJobItem`/`loadApiJobSummaries` are deleted. `JobListItem` gained `createdByKey`, `startedAt` and `itemCount` so the API shape loses nothing, and the job list screen's existing fields are unchanged. The new lint rule fails on `scope.<repo>.` in any operation file. The added assertions check that the single item equals its list entry, and that the summary has `itemCount`, `counts`, `createdBy.type` and `startedAt`.
      traces: FR-044, Constitution IV

- [x] MAJOR F5 — `docs/decisions.md` leaves out the 009 spec-time decisions and the interim constants. **Resolved.**
      where:  docs/decisions.md:372-385, docs/decisions.md:387-397, docs/decisions.md:399, docs/decisions.md:403-419
      why:    The 009 section now has:
      - all 12 spec-time decisions with *What* and *Reverse*;
      - each interim limit with its constant and file (18 constants, all present at the named path);
      - the four `url_*` codes;
      - the validator dependency;
      - 15 numbered generic changes, each with a *Reverse* line, including the F2 and F4 additions.
      traces: FR-045, spec Assumptions, Constitution "Docs"

- [ ] MINOR F6 — `POST /media/from-url` answers 500 for a valid URL whose last path segment contains a bare `%`. **Still open on `main`.**
      where:  src/server/services/media-from-url.ts:35
      why:    Unchanged since the first review. `decodeURIComponent(last)` throws `URIError` (for example on `…/photo%ZZ.png`), which maps to 500 `internal_error`.
      owed:   try/catch around the decode, falling back to the raw segment or `"image"`.
      traces: FR-018

- [ ] MINOR F7 — temporary URL-fetch failures are stored and replayed for 7 days, and the n8n guide does not say what to do. **Still open.**
      where:  src/server/api/errors.ts:61-62, docs/n8n.md
      why:    `url_timeout` and `url_fetch_failed` are still 400, so they are stored under the idempotency key. The two safe-fetch commits (`23f8692`, `b2192e9`) make stalled downloads report `url_timeout` reliably, which makes this path *more* likely to be hit, not less.
      owed:   map the temporary codes to an unstored 5xx, or document in `docs/n8n.md` §4 that they need a new key.
      traces: FR-045, US3 AS5

- [ ] MINOR F8 — stored image objects are left orphaned when the idempotent transaction rolls back after the media row was written. **Still open.**
      where:  src/server/api/operations/media.ts:41-48
      why:    `commit` still discards the prepared objects only when its own savepoint throws, not when the outer transaction rolls back.
      owed:   as in the first review: clean up on any outcome other than a committed 2xx.
      traces: contracts/services.md "Media"

- [ ] MINOR F9 — the webhook event's `data.createdBy` differs from the `GET` shape it should mirror. **Still open.**
      where:  src/server/services/webhooks/emit.ts:38, src/server/services/webhooks/emit.ts:64, src/server/services/views/load.ts:51-61
      why:    `emitEvent` still sets `createdBy` to `{ type: "api_key", name: "API key" }` or to `null`, while `GET` returns the key's or member's name.
      owed:   share one creator lookup, or document that `createdBy` in events is coarse.
      traces: FR-036

- [ ] MINOR F10 — a `/generate` takeover keeps the record id, so a different or expired request can return an earlier post. **Still open.**
      where:  src/server/api/idempotency.ts:61, src/server/api/operations/generate.ts:63
      why:    Unchanged. The generation request id is still derived from the idempotency record id alone.
      owed:   derive it from the lock token or the body hash as well, or re-insert under a new id on takeover.
      traces: FR-015

- [ ] MINOR F11 — the webhook and close-job server actions have no rows in the action × role matrix. **Still open.**
      where:  tests/integration/actions-authz.test.ts:130, src/app/p/[projectSlug]/settings/webhooks/actions.ts:32-103, src/app/p/[projectSlug]/jobs/actions.ts:74
      why:    The matrix still covers only the API-key actions. 010 touched this file without adding webhook or `closeJobAction` rows.
      owed:   add a `manage: true` case for each webhook action, and a case for `closeJobAction`.
      traces: US1 AS2, FR-041

- [ ] MINOR F12 — the tick summary log line leaves out webhook and housekeeping counts. **Still open.**
      where:  src/server/scheduler/loop.ts:23-27
      why:    `summaryLine` still prints only publishing and generation counts.
      owed:   append `webhooks_sent`, `webhooks_failed`, `webhooks_retried` and the purge counts.
      traces: FR-038, contracts/webhooks.md

- [ ] MINOR F13 — `tasks.md` shows the five remediation tasks unticked, though their fixes are committed and merged
      where:  specs/009-public-api/tasks.md:222-226
      why:    T075–T079 are `- [ ]`, but commits `3ad09bb`, `a78e16e`, `851ce38`, `f3415a7` and `ea1781c` implement exactly those tasks, and `66d6acb` marked F1–F5 resolved in review.md. A `spec-run --resume`, or any reader of `tasks.md`, sees five open tasks for work that is done. That could start an implement pass that redoes merged changes. This review may not re-tick existing tasks.
      owed:   tick T075–T079 in `specs/009-public-api/tasks.md`, citing the commits above. This is a bookkeeping edit; no code is needed.
      traces: tasks.md Phase 11

- [ ] MINOR F14 — the F4 refactor makes the API's job-item list do two or three queries per item instead of one
      where:  src/server/services/jobs/read.ts:197-200, src/server/api/operations/jobs.ts:133
      why:    `toItemView` loads the media asset (`getIncludingDeleted`) and builds its view, then looks up the post (`findByJobItemId`), one item at a time. The deleted `loadItem` did only the post lookup. A full page (`limit=100`, so 101 rows fetched) now costs up to about 200 sequential-per-item round trips inside `Promise.all`, plus thumbnail URL building. That is about twice the old cost. Responses stay correct, so nothing breaks, but a big n8n status poll pays for it.
      owed:   batch the per-item reads in `listJobItems`: `media.getMany` and a `posts.findByJobItemIds`, then map. This is for the hardening entry.
      traces: FR-044 (refactor side effect)

- NOTE N15 — Two builders of `ApiJobSummary` now exist side by side:
  - `toApiJobSummary(JobRecord, …)` is used by `GET /jobs/{id}` and the webhook `job.finished` body, through `loadApiJob`/`toApiJob` (`src/server/services/views/job.ts:5`, `src/server/services/views/load.ts:64-69`).
  - `toApiJobSummaryFromList(JobListItem)` is used by `GET /jobs` (`src/server/services/views/job.ts:36`).

  The creator lookups also differ: `jobCreator` at `src/server/services/views/load.ts:51` versus `keyNames`/`creatorNames` at `src/server/services/jobs/read.ts:52-63`. Today they agree: key first, then member, with "Deleted key" and "Former member" as fallbacks. Both builders return the typed `ApiJobSummary`, so a schema change fails to compile in both. `loadApiJob`'s comment explains why it does not use `getJob`: that service carries screen-only data. This is noted for whoever next changes the job shape, not as a defect.
- NOTE N16 — `toApiJobItem` now takes `error` from `JobItemView`, so a `done` item that once failed reports `error: null` (`src/server/services/jobs/read.ts:210`). Before the refactor it reported the stale last error. The new behaviour matches the job screen and reads as "the item's current error". No test or doc relied on the old behaviour.
- NOTE N17 — The two safe-fetch commits after the first review (`src/server/net/safe-fetch.ts:169-182`, `199-214`) are sound:
  - The request timer is cleared when the headers arrive, and the body read keeps its own deadline.
  - A fired deadline is reported as `url_timeout`, whatever error the destroyed stream surfaces.
  - Redirect and non-2xx responses are still drained with `res.resume()`.
  - 010 has since reworked this file further; I did not review 010's changes here.

## Coverage

Scoped to the earlier findings and the files the remediation changed, per the constitution's re-review rule. The first review's full FR/SC/US/edge-case sweep is in git (`66d6acb:specs/009-public-api/review.md`) and gave 43 satisfied and 5 partial out of 48 FRs. The five partials were exactly F1–F5.

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Earlier MAJOR findings (F1–F5) re-verified | 5 | 5 resolved | 0 | 0 | 0 |
| FRs those findings traced to (FR-019, FR-028, FR-043, FR-044, FR-045) | 5 | 5 | 0 | 0 | 0 |
| Functional requirements, whole spec (carried from first review + this re-check) | 48 | 48 | 0 | 0 | 0 |
| User-story scenarios previously partial (US4 AS6, US6 AS2) | 2 | 2 | 0 | 0 | 0 |
| Constitution principle IV (no duplicated logic per caller), previously partial | 1 | 1 | 0 | 0 | 0 |
| Earlier MINOR findings (F6–F12) re-checked on `main` | 7 | 0 fixed | — | — | 7 still open |
| Remediation files checked for regressions | 14 | 14 (one perf side effect, F14) | — | — | — |

## What I could not check

- **CI on PR #14 and implement's own gate output** for the remediation commits. `gh` could not reach `api.github.com` from the sandbox. I ran only the four targeted test files above (62 tests, all passing on `main`), not the full suite, lint, typecheck or build.
- **The live items still owed by the owner** from the first review:
  - a real n8n run against a deployed Docket (T050, SC-010, quickstart §9);
  - real webhook receivers (TLS, slow receivers, DNS errors);
  - the settings screens in a browser;
  - behaviour under Neon's transaction pooler.
- **The F14 query cost under load:** inferred from the code, not measured.
- **010's later changes to 009 files** (`handle.ts`, `safe-fetch.ts`, `media.ts`, `webhooks/*`): these belong to 010's own review, not this one.
