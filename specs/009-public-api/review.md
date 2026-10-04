# Review: Public API, API keys, idempotency, webhooks and OpenAPI (009)

Reviewed 167 changed files against `8236798` (merge-base with `origin/main`). Two commits (`7810557`, `4d25520`) hold only the spec, plan and design docs. The implementation is **uncommitted in the working tree**: 58 modified tracked files and 99 untracked files. So this review compares the present working tree against the base (`git diff 8236798` plus the untracked files), not `base...HEAD`. See N13.

- **Read in full:**
  - `src/server/api/**`
  - `src/app/api/v1/[[...path]]/route.ts`
  - `src/server/dal/{api-keys,idempotency,webhooks}.ts`, and the diffs of `dal/{scope,errors,accounts,clock,index,jobs}.ts`
  - `src/server/services/{api-keys,media-from-url}.ts` and `services/webhooks/{emit,deliver,endpoints,sign}.ts`
  - `services/jobs/{append,sources/api}.ts`, and the diffs of `jobs/{create,manage,status,read,runner,index}.ts`
  - `services/views/{post,job,account,media,load}.ts`
  - the diffs of `services/{media,posts/index,posts/status,posts/cancel,queue/index,generation/*}.ts`
  - `src/server/net/safe-fetch.ts`
  - `src/server/scheduler/{webhooks,housekeeping}.ts`, and the diffs of `scheduler/{index,config,credentials,token-refresh,publishing}.ts`
  - `src/lib/validation/api.ts`, `src/lib/auth-gate.ts`, `src/server/auth/access.ts`
  - the settings `api-keys` and `webhooks` pages and `actions.ts`, the settings layout, and the job page and actions diffs
  - `docs/n8n.md`, the 009 section of `docs/decisions.md`, the README and `.env.example` diffs
  - the tests `tests/integration/api/{idempotency,scope-enforcement,openapi}.test.ts`, `tests/integration/docs/n8n-flow.test.ts`, `tests/lint/api-imports.test.ts`, the `actions-authz.test.ts` diff, and `tests/integration/webhooks/settings.test.ts`
- **Sampled:**
  - `drizzle/0006_abnormal_chamber.sql` (constraints and checks only)
  - `src/lib/api/schemas.ts`
  - the client components (`CreateKeyForm`, `ApiKeysPanel`, `WebhooksPanel`, `EndpointDetail`, `DeliveryLog`, the dialogs)
  - the remaining test files (by name and case count)
- **Not reviewed:**
  - `drizzle/meta/0006_snapshot.json` (generated)
  - `pnpm-lock.yaml` (generated)

**Probe run:** a throwaway Vitest file in `$TMPDIR` builds the OpenAPI document and lists error responses that have no body schema. It backs F3. I did not re-run the full suite, lint, typecheck or build (constitution: review reads implement's gates and does not repeat them). I could not see implement's own gate output. T073 is ticked, but nothing is committed or pushed, so CI has not run on this code.

## Verdict

The feature largely satisfies the spec, and its core is sound:

- Keys are hashed, shown once and carry five permissions.
- One operation table drives the router, the OpenAPI document and the scope test.
- Idempotency claims a row first under a unique index, then commits the effect and the stored result together.
- Webhook events are written in the changing transaction and sent by a bounded, leased tick section.
- The P1 stories (keys, retried writes, the n8n flow) work as specified and are tested against real Postgres. Every endpoint has an idempotency key, every operation is in the operation-driven scope test, and the documented n8n requests are executed twice by a test.

The defects are at the seams between passes:

- the job-append path (T052) skips a render-length check that `createJob` (008) enforces;
- `GET /media/{id}` never fills the reservation field that FR-019 asks for;
- error responses that an operation declares itself replace the shared Error schema in the OpenAPI document;
- the job read operations bypass the job services, leaving T052's service additions unused;
- `docs/decisions.md` does not record the spec-time decisions and interim constants that the spec says it will.

None is a BLOCKER. All five MAJOR findings are small fixes. I would run one remediation pass over them and merge. The MINOR items can go to the hardening entry.

## Findings

- [x] MAJOR F1 — `appendItems` skips the rendered-instructions limit that `createJob` enforces, so appended items can store generation records that break their own schema
      where:  src/server/services/jobs/append.ts:35-41, src/server/services/jobs/create.ts:42-60, src/server/services/jobs/create.ts:110, src/lib/validation/generation.ts:9,17, src/server/services/review.ts:93, src/server/services/views/post.ts:44
      why:    `createJob` runs `checkTemplate`, which refuses any item whose rendered instructions exceed `JOB_RENDERED_INSTRUCTIONS_MAX` (10,000). `appendItems` calls `prepareApiItems` (up to 50,000 characters per item) and `insertItems`, but never makes that check. A realistic case: an open job with the template "Write about {{body}}", fed blog bodies of about 12,000 characters through `POST /jobs/{id}/items`. Each item is accepted with 201. The runner then renders instructions longer than 10,000 characters (`runner.ts:253`), sends them to the model, and saves a `GenerationRecord` whose `inputs.instructions` fails `generationInputsSchema`. Its consumers parse with `safeParse` and silently lose the record: the review queue shows no brief or voice (`review.ts:93`), and the API post's `generation` is `null` (`views/post.ts:44`). Sending the same items as `items` on `POST /jobs` is refused with 400. The same input gets two different results depending on which call carries it.
      owed:   extract the per-item render-length loop of `checkTemplate` into a shared helper, call it in `appendItems` before `insertItems`, and refuse with `ValidationIssuesError` naming `items.<i>`. Add a `jobs.test.ts` case: an append with an oversized rendered item → 400 and nothing added.
      traces: FR-028, FR-031 ("as for a CSV row"), US4 AS6

- [x] MAJOR F2 — `GET /media/{mediaId}` always reports `reservedByJobId: null`
      where:  src/server/services/media.ts:257-264, src/server/services/media.ts:88-92, src/server/services/views/media.ts:16, src/server/api/operations/media.ts:87-89
      why:    `getMedia` calls `toView(row, inUse)` and never passes the third argument, so `reservedByJobId` takes its default `null`. Only `listMedia` reads the reservation, through the DAL list's `reservedJobExpr`. An image held by an active job item is therefore reported as unreserved on the single-asset endpoint. A client that checks an image there before `POST /jobs/{id}/items` then gets an unexpected 409 `media_reserved`. FR-019 names "job reservation" as part of the `GET /media/{id}` response. No API test checks this field (the only checks are `tests/integration/jobs/dal.test.ts:42` and `reservation.test.ts:46`, both on the list).
      owed:   in `getMedia`, look up the active reservation (for example a one-id `reservedJobFor` on the media repo, or reuse the list's `reservedJobExpr`) and pass it to `toView`. Add an assertion in `tests/integration/api/endpoints/media.test.ts` that a reserved image returns its job id.
      traces: FR-019

- [x] MAJOR F3 — error responses an operation declares itself have no shared Error schema in `openapi.json` (25 of them)
      where:  src/server/api/openapi.ts:62, src/server/api/openapi.ts:68-77, src/server/api/operations/posts.ts:71-72, src/server/api/operations/generate.ts:49-52, src/server/api/operations/jobs.ts:80-82
      why:    `errorStatuses` drops every status listed in `op.responses` (`set.delete(s)`). `buildOperation` then emits those entries with only a description, and no `content` unless the operation gave a schema, which none does for its error statuses. The probe found 25 such responses, for example `POST /posts` 400 and 404, `POST /generate` 400, 422 and 503, every `GET …/{id}` 404, and `POST /jobs/{jobId}/items` 400 and 409. They therefore lose the Error schema, the list of codes in the description and, for 503, the `Retry-After` header. US6 AS2 requires that "every operation lists its error responses using the shared error schema". `openapi.test.ts:92-94` checks only 401, 403, 429 and 500, so the suite passes. Separately, `generatePost`'s 200 ("the post this request already made") has no body schema.
      owed:   for status ≥ 400, merge the operation's description into `errorResponse(status)` instead of replacing it (keep the Error schema, the codes and the headers). Give the generate 200 the same schema as its 201. Extend `openapi.test.ts` to assert that every response with status ≥ 400 references `#/components/schemas/Error`.
      traces: FR-043, US6 AS2, SC-009

- [x] MAJOR F4 — job read operations call DAL repos directly, and T052's service additions for them are never used
      where:  src/server/api/operations/jobs.ts:63, src/server/api/operations/jobs.ts:130, src/server/services/jobs/read.ts:199-207, src/server/services/jobs/read.ts:73-85, src/server/services/views/load.ts:82-102, src/server/services/jobs/read.ts:181-196
      why:    FR-044 requires that operations "call a service and map its result". `listJobs` reads `scope.jobs.list(...)` and `listJobItems` reads `scope.jobs.get(...)` straight from the operation. The import lint (`tests/lint/api-imports.test.ts`) cannot see repo access through the scope object, so T071's check passes while the rule is broken. T052 added `getJobItem`, plus `limit`/`offset` on `listJobs` and `listJobItems`, for the API. Nothing calls `getJobItem` (only the scope test's fixture names the operation id), and the API reads items through a second presenter, `loadApiJobItems` and `loadApiJobItem` in `views/load.ts`, which re-implements `toItemView`. That gives two paths to the same job-item reads, which constitution IV ("no duplicated logic per caller") forbids. The next change to one will drift from the other.
      owed:   route `listJobs`, `listJobItems` and `getJobItem` through the job read services (with their `limit`/`offset`), mapping `JobItemView` to `ApiJobItem` in `views/job.ts`. Alternatively move those reads into one service function and delete the unused one. Either way, no operation file may call `scope.<repo>`. Extend `tests/lint/api-imports.test.ts` to fail on `scope\.(jobs|jobItems|posts|media|accounts|targets|webhooks|apiKeys)\.` in `src/server/api/operations/**`.
      traces: FR-044, Constitution IV

- [x] MAJOR F5 — `docs/decisions.md` leaves out the 009 spec-time decisions and the interim constants the spec says will be logged
      where:  docs/decisions.md:357-370, specs/009-public-api/spec.md:28-43, specs/009-public-api/spec.md:386
      why:    The 009 section has 12 implementation notes. It does not record the spec's "Decisions made while specifying", which says "It will be appended to `docs/decisions.md`":
      - the key decides the project;
      - API keys only, no browser sessions;
      - a key outlives its creator;
      - permissions are independent;
      - API posts are not put in review;
      - 7-day retention and 409 for in-flight duplicates;
      - http and private webhook URLs are allowed;
      - media by URL is copied into the bucket;
      - `job.finished` fires on every move into a finished state;
      - the media source is offered over the API.

      It also does not record any of the interim constants that the spec's Assumptions say are "each one constant, logged in `docs/decisions.md`":
      - rate limit default 60 (range 1–1,000), 25 keys, 10 endpoints;
      - 7-day retention and the hold formula;
      - the 8 MB JSON limit;
      - 100 items per add and 500 per job;
      - 8 delivery attempts with 1 min doubling to 6 h, a 10 s timeout, 20 failed deliveries to disable, a 30-day log and a 24 h overlap;
      - URL fetches: 3 redirects, 30 s.

      The added URL error codes (`url_*`) and most of plan.md's 14 generic changes (scope actor, emit hook-ins, the `recordRefresh` return type, the `prepareUpload` split, `listUpcomingOccurrences`, access statements, the auth-gate prefix, the 4th tick section, audit enum values) have no *Reverse* lines either. T072 is ticked. The 008 section shows the expected form (`docs/decisions.md:319-340`). The owner relies on this log to review choices made while away.
      owed:   append the spec-time decisions, an "interim limits" entry naming each constant and the file it lives in, the `url_*` codes, and a *Reverse* line for each plan.md generic change.
      traces: FR-045, spec Assumptions, Constitution "Docs" workflow rule

- [ ] MINOR F6 — `POST /media/from-url` answers 500 for a valid URL whose last path segment contains a bare `%`
      where:  src/server/services/media-from-url.ts:34-35
      why:    `decodeURIComponent(last)` throws `URIError` for, say, `https://cdn.example.com/photo%ZZ.png` (probe: `URIError: URI malformed`). The WHATWG URL parser keeps such segments as they are. The error is not a `UrlFetchError`, so it maps to 500 `internal_error` after the image was already downloaded. Nothing is stored, so a retry fails the same way.
      owed:   wrap the decode in try/catch and fall back to the raw segment, or to `"image"`.
      traces: FR-018

- [ ] MINOR F7 — temporary URL-fetch failures are stored and replayed for 7 days, and the n8n guide does not say what to do
      where:  src/server/api/idempotency.ts:142-148, src/server/api/errors.ts:59-62, docs/n8n.md:65-77
      why:    `url_timeout` and `url_fetch_failed` (DNS failure, or a 5xx from the image host) are 400s raised in `prepare`, so they are stored. With the documented key `media-{{row.id}}`, n8n's documented "retry 3 times with the same key", and any later re-run of the execution, keep replaying the stored 400 for 7 days. The guide says that "other 4xx answers are mistakes in the request", which does not fit a flaky image host. No duplicate is possible, but the row is stuck until someone edits the key expression.
      owed:   either map temporary fetch failures to an unstored status (for example 502 or 504, like `generation_unavailable`), or document in `docs/n8n.md` §4 that `url_timeout` and `url_fetch_failed` need a new key (`media-{{row.id}}-2`), as `generation_failed` does.
      traces: FR-045, US3 AS5

- [ ] MINOR F8 — stored image objects are left orphaned when the idempotent transaction rolls back after the media row was written
      where:  src/server/api/operations/media.ts:41-48, src/server/api/idempotency.ts:167-179
      why:    `commit` deletes the prepared objects only if its own savepoint throws. If the outer transaction then rolls back, the row disappears but the two objects stay in the bucket, unlogged. That happens when `complete` returns false (hold lost), or the commit fails. contracts/services.md asks for the deletion in a `finally` around the idempotent transaction.
      owed:   let the media operations clean up on any outcome other than a committed 2xx (for example an `onRollback` hook from the pipeline, or a check after `runIdempotent`), and log the orphan as `uploadMedia` does.
      traces: contracts/services.md "Media"

- [ ] MINOR F9 — the webhook event's `data.createdBy` differs from the `GET` shape it should mirror
      where:  src/server/services/webhooks/emit.ts:38, src/server/services/webhooks/emit.ts:64, src/server/services/views/load.ts:13-23
      why:    `emitEvent` rebuilds the post and job views itself. It sets `createdBy` to `{ type: "api_key", name: "API key" }` or to `null`, where `GET /posts/{id}` returns the key's name, or `{ type: "user", name }` for members. A receiver that reads the creator from `post.published` sees `null` for every post a member made. FR-036 says event data uses "the same shapes as the API's GET responses".
      owed:   share one creator lookup between `load.ts` and `emit.ts` (the scheduler repos would need `apiKeys` and `members`, or a single joined read), or document that `createdBy` in events is coarse.
      traces: FR-036

- [ ] MINOR F10 — a `/generate` takeover keeps the record id, so a different or expired request can return an earlier post
      where:  src/server/dal/idempotency.ts:82-104, src/server/api/idempotency.ts:61-65, src/server/api/operations/generate.ts:64
      why:    The takeover is an UPDATE of the same row, and `generationRequestIdFor(recordId)` is derived from that row's id. Two cases go wrong:
      - **Different body:** a first `/generate` committed its post and then died before `complete`. A request with a *different* body, sent after the hold lapses, takes over the claim and gets the first request's post (200) instead of a new post or 422.
      - **Expired record:** a completed record past its 7 days, but not yet purged, is also taken over in place. The same key then returns the old post instead of being "treated as new". The result depends on whether housekeeping has run yet.
      owed:   on takeover, derive the generation request id from the new lock token or `bodyHash` as well as the record id, or re-insert under a new id. Keep the same-body crash recovery that `idempotency-generate.test.ts` covers.
      traces: FR-015, spec decision "Idempotency records last 7 days"

- [ ] MINOR F11 — the webhook and close-job server actions have no rows in the action × role matrix
      where:  tests/integration/actions-authz.test.ts:129-141, src/app/p/[projectSlug]/settings/webhooks/actions.ts:32-103, src/app/p/[projectSlug]/jobs/actions.ts:74-81
      why:    contracts/services.md says that `actions-authz.test.ts` "gains rows for every new server action × role". Only the two API-key actions were added. Editor refusal for webhooks is tested only for `createEndpoint` at the service level (`tests/integration/webhooks/settings.test.ts:61-66`). The code does enforce it: every function in `services/webhooks/endpoints.ts` calls `need()`. However, the seven webhook actions and `closeJobAction` are not covered for editors, signed-out users or non-members, which US1 AS2 ("the server refuses every key and webhook action from them") and the constitution's role tests call for.
      owed:   add a `manage: true` case for each webhook action, and a case for `closeJobAction`.
      traces: US1 AS2, FR-041, contracts/services.md

- [ ] MINOR F12 — the tick summary log line leaves out webhook and housekeeping counts
      where:  src/server/scheduler/loop.ts:23-27
      why:    `TickSummary` gained `webhooks` and `housekeeping`, but `summaryLine` still prints only publishing and generation counts. contracts/webhooks.md says that "the summary log line gains its counts". Failed and retried deliveries are therefore invisible in the worker log.
      owed:   append `webhooks_sent`, `webhooks_failed` and `webhooks_retried` (and the purge counts) to `summaryLine`.
      traces: FR-038, contracts/webhooks.md

- NOTE N13 — Nothing past the plan is committed. All the implementation, including `tasks.md`, is in the working tree. The constitution asks for small conventional commits per task, staged by explicit path. The `after_implement` git hook (`.specify/extensions.yml`) or the remediation pass should commit it before the PR. Until then, CI has not run on this code.
- NOTE N14 — `tests/integration/api/idempotency.test.ts` still drives a test-only operation (`/test/idem`) rather than `POST /posts`, as T033 allowed. The seam calls the real `createDraft`, so the effect is real. Idempotency on the real routes is also covered by `n8n-flow.test.ts`, `idempotency-generate.test.ts` and `endpoints/jobs.test.ts`.
- NOTE N15 — `readBytes` checks `Content-Length` first, but for a chunked body it reads everything into memory before the size check (`src/server/api/handle.ts:26-34`). The request-size review belongs to the hardening entry (spec "Out of scope").

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-048) | 48 | 43 | 5 (FR-019, FR-028, FR-043, FR-044, FR-045) | 0 | 0 |
| Success criteria (SC-001–SC-011) | 11 | 10 | 0 | 0 | 0 |
| User-story acceptance scenarios (US1–US6) | 36 | 34 | 2 (US4 AS6 via F1; US6 AS2 via F3) | 0 | 0 |
| Edge cases (spec "Edge Cases") | 24 | 24 | 0 | 0 | 0 |
| Constitution principles (I–VII) | 7 | 6 | 1 (IV, F4) | 0 | 0 |
| Constitution engineering constraints (tick bounded, `SKIP LOCKED` + lease, no network call in a held transaction, no session features, UTC/Temporal, UI via `docket-ui`) | 6 | 6 | 0 | 0 | 0 |

The SC row counts 10 of 11 because SC-010 (an owner makes a first call within 2 minutes) needs a live run. It is T050, honestly marked 🛑 BLOCKED and owed by the owner, so I did not count it as satisfied.

The constitution asks the first review to sweep these categories:

- **Concurrency and locking:** checked.
  - Key creation (project lock and count) and revocation (conditional UPDATE).
  - The rate-limit UPDATE.
  - The idempotency claim, takeover and `complete` on the token.
  - `appendItems`, `closeJob` and `cancelJob` all lock the job row.
  - Delivery claim with `SKIP LOCKED`, lease, recovery, and recording on the token.
  - `lockStatus` `FOR UPDATE` inside the emitting transactions.
- **Idempotency and retries:** F7, F8, F10.
- **Authorization and scoping:**
  - `KEY_GRANTS` and `keyCan`;
  - the key re-check in `transaction()`;
  - 404 for other projects (operation-driven test);
  - no `requireRole` in reachable services;
  - F11.
- **Time zones and DST:** `listUpcomingOccurrences` uses the existing Temporal `occurrencesBetween` and `plannedTime`; schedule input requires an offset.
- **Error, timeout and ambiguous paths:**
  - generate 422 versus 503;
  - 5xx never stored;
  - URL timeout, size and redirect limits;
  - delivery timeout, 3xx and 410;
  - F6.
- **Secrets:**
  - the plaintext key appears only in the create return;
  - the hash column is excluded from every select (`publicColumns`);
  - webhook secrets are encrypted with AAD;
  - response excerpts are passed through `redact`;
  - `logUnexpected` logs the error name only;
  - audit details use `host`, never `url` or `secret`.

## What I could not check

- **Live n8n and a deployed Docket** (T050, SC-010, quickstart §9). Verified with mocks only: the doc's exact requests are executed by `n8n-flow.test.ts` against the route module.
- **Real webhook receivers on the internet:** TLS failures, slow-loris receivers, and the DNS-based `dns` and `tls` error kinds. Tests use a local `node:http` receiver.
- **Real DNS rebinding and IPv6 edge ranges** for `safe-fetch`: 6to4 `2002::/16`, Teredo, and documentation ranges are not in `BlockList`. Tightening this belongs to the hardening entry.
- **The settings screens in a browser:** keyboard flow, focus, copy-to-clipboard and the four states. I read the components and `ui.test.tsx` only by name and case count.
- **Implement's gate results** (`tsc`, `lint`, `db:check`, the full Vitest run). There is no committed history and no CI run to read. T073 is ticked; I did not re-run the gates, per the constitution's review rule.
- **Behaviour under Neon's transaction pooler.** Verified on local Postgres only.
