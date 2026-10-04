# Review: Hardening for real use — failures view, limits audit, security pass, configuration and deployment

Reviewed 122 files changed across 12 commits, against `a50f8ba...HEAD` (the merge base with `origin/main`). This is a review of the diff, not of the present state alone.

**Read in full** (the file, or its whole diff plus the helpers it calls):

- Services, DAL and engine:
  - `src/server/services/failures.ts`
  - `src/server/services/posts/{index,view,validate}.ts`, plus `gate`, `withLockedTarget` and `queueTargetsInTx`
  - `src/server/services/queue/index.ts` (`peekNextFree`, `allocateNextFree`)
  - `src/server/dal/{targets,attempts,audit}.ts`
  - `src/server/scheduler/{publishing,limits,http}.ts` (all of `execute()`)
  - `src/server/services/webhooks/{deliver,destination,endpoints}.ts`
  - `src/server/net/safe-fetch.ts`
  - `src/server/services/{audit,accounts}.ts`
  - `src/providers/{limits,types}.ts`, `src/providers/bluesky/{index,settings}.ts`
  - `drizzle/0007_shallow_stephen_strange.sql` and the schema diff
- Screens:
  - `src/app/p/[projectSlug]/failures/page.tsx`
  - `src/components/targets/TargetResolution.tsx`
  - `src/app/p/[projectSlug]/posts/actions.ts`
  - `src/app/p/[projectSlug]/posts/[postId]/page.tsx`
  - `src/app/p/[projectSlug]/layout.tsx`, `src/components/shell/LeftNav.tsx`
- HTTP and security:
  - `src/proxy.ts`, `src/lib/http/{same-origin,security-headers}.ts`
  - `next.config.ts`, `src/app/layout.tsx`
  - `src/server/http/body.ts`, `src/server/api/handle.ts`, `src/app/p/[projectSlug]/compose/check/route.ts`
- Configuration and deployment:
  - `src/server/startup/{validate,index}.ts`, `src/worker.ts`, `scripts/prestart.mjs`
  - `src/server/env.ts`, `src/server/llm/config.ts`, `src/server/config-registry.ts`, `drizzle.config.ts`
  - `docker-compose.yml`, `package.json`, `scripts/smoke.ts`
- Docs: `docs/{deployment,limits,security}.md` and the 010 section of `docs/decisions.md`.
- Tests:
  - `tests/integration/limits/enforcement.test.ts`
  - `tests/integration/docs/{limits-inventory,security-findings,provider-guide}.test.ts`
  - `tests/integration/security/{secret-scan,csrf,headers}.test.ts`
  - `tests/integration/failures/{concurrency,authz,ui,nav}.test.ts(x)`
  - `tests/integration/scheduler/pre-call-failures.test.ts`
  - `tests/integration/webhooks/destination.test.ts`
  - `tests/lint/env-coverage.test.ts`
  - `tests/integration/posts/resolve-url.test.ts`
  - the diffs of `tests/integration/{audit,scope-check,tick-endpoint}.test.ts` and `src/server/net/safe-fetch.test.ts`

**Sampled:**

- `README.md` (section order and quick start).
- The test titles of `tests/integration/{instagram,threads}/carousel.test.ts`, `tests/integration/facebook/multi-photo.test.ts`, `tests/integration/bluesky/images.test.ts` and `src/providers/media.test.ts`.
- `src/server/services/media-variants.ts` (`adaptedMediaFor`).
- Next's own Server Action origin check, `node_modules/next/dist/server/app-render/action-handler.js:427-470`.

**Not reviewed:**

- Generated files, which `pnpm db:check` already covers: `drizzle/meta/0007_snapshot.json` and `_journal.json`.
- The body of `.env.example`, which `tests/lint/env-coverage.test.ts` checks.
- The body of `docs/adding-a-provider.md`, which `provider-guide.test.ts` checks.
- Tests I did not read: `tests/integration/failures/{list,attempts,resolve,requeue,retry}.test.ts`, `tests/integration/security/{body-limit,cookies}.test.ts`, `tests/integration/docs/{deployment,readme}.test.ts`, the startup and prestart tests, and the unit tests next to `body.ts`, `same-origin.ts`, `security-headers.ts` and `services/failures.ts`.
- `DeletePostButton.tsx`, `failures/loading.tsx` and `tests/helpers/failures.ts`.
- `contracts/ui.md`, `contracts/docs-and-config.md`, `research.md` and `quickstart.md`.

I did not re-run the suite (constitution: review reads the implement phase's results). I relied on the final gate recorded in `docs/decisions.md` (010 "Final gate results": tsc, lint, db:check, vitest 306 files / 2,579 tests and build all green). The only things I ran were read-only probes: the proxy matcher regex, and `docker info`, which reports the daemon unreachable.

## Verdict

**Not yet.** The feature mostly works and hangs together, but two P1 deliverables claim more than they prove.

What holds up:

- **Code structure.** The three implement passes reuse one another's work rather than duplicating it:
  - one shared `TargetResolution` component for both screens;
  - one `retryBlockedReason`, shared by the service, the failures rows and the post view;
  - one allocator (`allocateNextFree`) for requeue;
  - one `validateResolvedContent`, shared by the scheduling gate and the engine;
  - one `validateConfiguration`, used by the web process, the worker and prestart;
  - one webhook address policy, checked at save time and inside the socket lookup.
- **Behaviour I traced:**
  - the locking and guarded updates for resolve, requeue and retry;
  - the pre-call classification in the engine;
  - the tick refusals;
  - the bounded body reader;
  - the migration.

  All of them match the spec and data model. I found no secret leak and no authorization gap.

What blocks the merge — two pieces of evidence the spec makes the point of P1 stories:

- **The end-to-end secret scan (US3, FR-020).** It omits secrets the spec names: session tokens, and the Meta and Threads app secrets. It also skips the setup and resolution steps the spec requires it to drive. Even so, `docs/security.md` says it covers "every environment secret".
- **The limits inventory (US2, FR-014, FR-017, SC-004).** About 15 of its rows cite tests that never break the limit in that row. Its doc test only checks that the cited file exists, so it cannot notice.

Neither is a runtime defect. Both make the artifact the owner is meant to trust misleading, and both are cheap to fix. I would fix both (two tasks below), leave the MINORs for later, and have a human run the Docker walkthrough (T068) before calling deployment verified.

## Findings

- [x] MAJOR F1 — The end-to-end secret scan does not seed or drive everything FR-020 lists, and the findings record says it does
      where:  tests/integration/security/secret-scan.test.ts:5-20, tests/integration/security/secret-scan.test.ts:158-279, tests/integration/security/secret-scan.test.ts:219, docs/security.md:9-10
      why:
        - **No session token.** The scan never creates a real session. It mocks `getSession` with a fake id (line 219), and the only sign-in it attempts is for a user who does not exist, so no session token is ever produced or scanned.
        - **No Meta or Threads app secrets.** `META_APP_SECRET` and `THREADS_APP_SECRET` are absent from `ENV` (lines 5-20). They are real secrets the app holds, read through the provider-declared environment, and contracts/http-security.md §6 lists them.
        - **Two required steps are not driven.** The flow never runs setup (it uses factory fixtures) and never resolves an ambiguous target, though FR-020 names both "setup" and "resolution".

        So a leak of a session token, or of a Meta or Threads app secret (for example into a log line, an error page or an attempt summary), would pass this test. Meanwhile `docs/security.md:9` says the scan covers "every environment secret, stored credential …", which the code does not support. The spec makes this test the proof for US3 ("proof — not a promise"), so the record should not overstate it.
      owed:
        - Seed distinctive `META_APP_ID`/`META_APP_SECRET` and `THREADS_APP_ID`/`THREADS_APP_SECRET` values.
        - Create a real user and sign in through the auth handler, so a real session token exists. Add the token to the scanned secrets, excluding only its own `Set-Cookie` header by location, and assert that one appearance separately.
        - Drive first-user setup through the setup service, and an ambiguous target through `resolveAmbiguous` (published with a URL, and not-published with requeue).
        - Bring the "Secrets in …" rows of `docs/security.md` into line with what the test actually covers.
      traces: FR-020, FR-028, SC-005, US3 AS1

- [x] MAJOR F2 — About 15 limits-inventory rows cite a test that does not break that limit, and the doc test cannot notice
      where:  docs/limits.md:22, docs/limits.md:25, docs/limits.md:31, docs/limits.md:33-37, docs/limits.md:49-51, docs/limits.md:53-54, docs/limits.md:82, docs/limits.md:85, tests/integration/limits/enforcement.test.ts:53-70, tests/integration/limits/enforcement.test.ts:86-88, tests/integration/limits/enforcement.test.ts:117, tests/integration/docs/limits-inventory.test.ts:96-101
      why:
        - **Instagram planner rows** (bytes, formats, max width, min aspect, max aspect; limits.md:33-37) cite `tests/integration/instagram/carousel.test.ts`. That file's only test publishes 2- and 4-image carousels; nothing in it is oversize, PNG, too wide or out of aspect range.
        - **Threads planner rows** (bytes, formats, min width, min aspect, max aspect; :49-51, :53-54) cite `tests/integration/threads/carousel.test.ts`. Of these limits, it only exercises max width.
        - **Facebook "formats"** (:22) cites `facebook/multi-photo.test.ts`, which never uploads a PNG.
        - **Mock "formats"** (:82) cites the "capabilities are refused" describe, but `violations()` (enforcement.test.ts:53-70) generates no format row.
        - **Facebook and mock "publish limit: account limit"** (:25, :85) cite "publish limits defer". That describe loops over `providerPublishLimits(provider)` (:117), which is empty for both, so neither provider gets a test there.
        - **Instagram "text length"** (:31) cites "text rows:", but that describe skips media-required providers (:86-88).

        Some of these limits are probably enforced and tested elsewhere. The generic planner has refusal tests in `src/providers/media.test.ts:63-80`, but those use generic constraints, not each provider's values. Even so, the inventory, which FR-014 requires to name "the test that proves enforcement", points at the wrong place. US2's Independent Test ("for each row, run the named test") proves nothing for these rows, and SC-004 ("100% of entries … have a passing test") is not met as written.

        `limits-inventory.test.ts:96-101` only checks that the file exists. A quoted title fragment is optional, and when present it is matched anywhere in the file's text. So a wrong citation passes, and the next drift will pass too.
      owed:
        - For every row, cite a test that breaks exactly that limit using the provider's own capability values and asserts the documented outcome: refusal, adaptation, or deferral with no platform request.
        - Where no such test exists, add rows to `enforcement.test.ts`:
          - planner refusals and adaptations driven through `mediaConstraintsOf(provider.capabilities)` / `planImage`, per provider;
          - a format row;
          - an account-level publish-limit deferral for Facebook and the mock.
        - Make the doc test require a quoted fragment on every row, and match it against a real `it(` / `describe(` title, or a generated `"<providerKey>: <field>"` name, rather than raw file text.
      traces: FR-014, FR-017, SC-004, US2 AS1

- [ ] MINOR F3 — The proxy's same-origin guard is skipped for any path ending in a static-file extension, and Server Actions are reachable there
      where:  src/proxy.ts:92, src/proxy.ts:49-59, node_modules/next/dist/server/app-render/action-handler.js:440-445
      why:
        - **The matcher skips these paths.** It excludes `.*\.(?:ico|png|jpg|…)$`. Probed: `/p/acme/posts/x.png` does not match, while `/p/acme/posts/abc` does.
        - **A page still answers there.** That path is served by `posts/[postId]/page.tsx`, whose bundle includes the post actions. A Server Action can be invoked on it, either with the `Next-Action` header or with a no-JS form carrying a `$ACTION_ID_…` field.
        - **Next's own check has the hole D16 closes.** It refuses a mismatched `Origin`, but it lets a request with no `Origin` through with only a warning (action-handler.js:440-445). That missing-`Origin` case is exactly what D16 added the proxy guard to close, and on these paths the guard does not run.

        It is hard to exploit. Browsers send `Origin` on cross-origin POSTs, and `SameSite=Lax` keeps the session cookie off cross-site POSTs. So this is a defence-in-depth gap rather than a working CSRF. The CSRF tests call `proxy()` directly, so they bypass `config.matcher` and cannot see it.
      owed: Apply the guard to non-GET requests whatever the extension. For example, narrow the matcher exclusion to `GET`/`HEAD` (via `has`/`missing`), or exclude only `/_next/*` and real `public/` files. Then add a test that asserts the matcher includes a POST to a `.png` page path.
      traces: FR-021, SC-006

- [ ] MINOR F4 — Past the last page, the failures view says "Nothing needs attention"
      where:  src/app/p/[projectSlug]/failures/page.tsx:166-167, src/app/p/[projectSlug]/failures/page.tsx:202-216
      why:
        - `empty` is `rows.length === 0`, and `filtered` ignores `page`.
        - So `?page=N` past the end shows the "Nothing needs attention. Every post that was due went out…" empty state and no pagination. This happens after resolving the last row on page 2, which calls `refresh()` on the same URL.
        - Meanwhile the summary line above it still says, for example, "3 need your decision · 30 failed".
      owed: When `list.filtered > 0` but the page is empty, show "This page is empty" with a link to the last page, or clamp the page in `listFailures`.
      traces: FR-004, FR-013

- [ ] MINOR F5 — Requeue skips the variant preparation that every other scheduling path runs, so a missing variant becomes a spurious conflict
      where:  src/server/services/posts/index.ts:710, src/server/services/posts/index.ts:440
      why:
        - `addToQueue` (:440), `scheduleAt` and `publishNow` call `prepareForScheduling` before their transaction.
        - The requeue branch of `resolveAmbiguous` calls `gate` (:710) directly. `adaptedMediaFor` only reads variants (media-variants.ts:204-215). An image target whose variant is missing therefore fails the gate with `variant_failed`.
        - A variant goes missing when, for example, a deploy changes the provider's media constraints and so the variant hash. When that happens, the preview offers only "don't requeue", and the server raises a `ConflictError`, although Add to queue would have succeeded.
      owed: Call `prepareForScheduling(scope, target.postId, { targetIds: [targetId] })` before `withLockedTarget` when `requeue` is true, as `addToQueue` does.
      traces: FR-008, constitution IV

- [ ] MINOR F6 — On the failures view, the result announcement and the focus are probably lost when the row disappears
      where:  src/components/targets/TargetResolution.tsx:106, src/components/targets/TargetResolution.tsx:55-71, src/app/p/[projectSlug]/posts/actions.ts:33
      why:
        - The `LiveRegion` lives inside the row's `TargetResolution`.
        - Every successful action calls `refresh()`, and the refreshed list no longer contains the row. The component unmounts in the same update that sets the message, so a screen reader probably hears nothing.
        - The focused button is removed, so focus probably falls back to `<body>`.
        - The post detail page keeps its target mounted, so it is unaffected.
        - This is plausible from the code, not observed: it needs a browser.
      owed: Lift the announcement into a page-level live region (or one in the layout), and move focus to the table caption or the next row after a successful action.
      traces: FR-013

- [ ] MINOR F7 — A blocked retry always links "Reconnect <account>", even when reconnecting cannot help
      where:  src/components/targets/TargetResolution.tsx:116-122, src/server/services/failures.ts:161
      why:
        - For a removed account, the row reads "This account was removed, so the post can't be retried. Reconnect Removed account".
        - For an unregistered provider, it offers a reconnect link that cannot help.
      owed: Show the reconnect link only when the account exists and needs reconnecting. Otherwise show the reason alone.
      traces: FR-009, US1 AS7

- [ ] MINOR F8 — The save-time "couldn't look up that host" warning never reaches the user
      where:  src/server/services/webhooks/endpoints.ts:108, src/app/p/[projectSlug]/settings/webhooks/actions.ts:37
      why: `createEndpoint` returns `destinationWarning`, but the settings action destructures only `endpoint`, `secret` and `httpWarning`. Someone who mistypes a hostname gets a silently saved endpoint, which every delivery then refuses or fails. The warning is a dead end: one pass produced it and no later pass shows it.
      owed: Pass `destinationWarning` through the action and show it next to the `http` warning.
      traces: FR-023 (contracts/services.md §5)

- [ ] MINOR F9 — Two new behaviours have no test
      where:  src/app/p/[projectSlug]/posts/[postId]/page.tsx:131-163, src/server/scheduler/publishing.ts:379-380
      why:
        - **The post detail page additions (FR-011).** These are the attempt count, the "Who" column, the `safeExternalHref` fallback to plain text, and the shared resolution dialogs. No test renders the page; the plan's `tests/integration/posts/detail-resolution.test.tsx` was not written. Only the pure helpers are tested (`resolve-url.test.ts`).
        - **The engine's new "any other pre-call throw is retryable" branch.** This is a behaviour change from ambiguous to retryable for, say, a database error before `advance`. `pre-call-failures.test.ts` covers only unreadable credentials, unparsable settings and the post-call ambiguous case.
      owed: Render `PostPage` for an ambiguous target and a failed target, with a `javascript:` external URL stored. Add a pre-call test that makes `getCredentialsCiphertext` throw and expects `retryable_error`, never `ambiguous`.
      traces: FR-011, FR-012

- NOTE F10 — The empty-means-unset rule is implemented three times; the helper meant to be the single reading is used only by a test.
  - `directUrlOf` (`src/server/env.ts:302`) is called only from `tests/startup/prestart.test.ts`.
  - The rule is inlined at `src/server/env.ts:310`, `scripts/prestart.mjs:14` and `drizzle.config.ts:4`. That last one is justified in decisions D28: drizzle-kit cannot resolve the alias.
  - All three use `||`, so FR-033 holds today.

- NOTE F11 — Import cycle: `services/posts/index.ts:19` re-exports `./view`, `view.ts:8` imports `../failures`, and `failures.ts:10` imports `./posts`. It works because every use happens at call time, but a top-level use added later would see `undefined`.

- NOTE F12 — The Docker checks are honestly not done, so deployment is unverified.
  - The clean-checkout run (FR-037), backup and restore (FR-035, SC-009), SC-008 and the browser CSP-console check (FR-024) are all recorded as NOT VERIFIED (`docs/deployment.md:43`, `:61`). This is what the spec requires when Docker is unavailable, and I confirmed the Docker daemon is unreachable here.
  - T068 (`tasks.md:153`) stays open and blocked for a human. It is not counted as a defect, but the feature is not deploy-verified until it runs.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted | Not verifiable here |
|---|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-042) | 42 | 38 | 4 (FR-014, FR-017, FR-020, FR-028) | 0 | 0 | — (FR-035 and FR-037 are satisfied by their "report as not run" clause) |
| Success criteria (SC-001–SC-011) | 11 | 6 (SC-002, 003, 006, 007, 010, 011) | 2 (SC-004, SC-005) | 0 | 0 | 3 (SC-001, SC-008, SC-009) |
| User stories (P1–P3) | 6 | 4 (US1, US4, US5 as documented, US6) | 2 (US2, US3) | 0 | 0 | — |
| Edge cases (spec list) | 16 | 16 | 0 | 0 | 0 | — |
| Constitution core principles (I–VII) | 7 | 7 | 0 | 0 | 0 | — |

Notes on the counts:

- **Edge cases.** One edge case differs only in wording. When a target was requeued by someone else and then claimed by the tick, a late resolve answers "This post was already resolved." rather than "Publishing in progress". Both are true, so I counted it as satisfied.
- **Plan touch-points.** I checked the plan's "Source Code" list against the diff. Every source file is there except `src/lib/validation/api.ts`. That is a logged deviation: decisions D20 moved the literal-address check into `services/webhooks/destination.ts`, because the schema is shared with client code. Of the test files the plan names, two are missing:
  - `tests/integration/posts/detail-resolution.test.tsx` was not written (F9).
  - `src/server/env.test.ts` and `src/server/llm/config.test.ts` were not extended. The new `NODE_ENV`, `PORT`, `HOSTNAME` and `llmEnvIssues` rules are still exercised, by `tests/lint/env-coverage.test.ts` (a malformed-value probe for every variable) and by `src/server/startup/validate.test.ts`.

- **FR-013** is counted as satisfied, with F6 as a plausible gap that only a browser can confirm.
- **FR-021** is counted as satisfied, with F3 as a defence-in-depth gap.
- **FR-028** is partial only because of the overclaim in F1.
- **The constitution** passes on behaviour:
  - VII: no leak found; F1 is about the proof, not a leak.
  - IV: one allocator and one validator; F5 is a missed preparation step, not a duplicate path.
- **Cross-pass coherence** (duplicated helpers, interface drift, producer/consumer shapes, dead ends):
  - no duplicated abstraction;
  - no interface drift: `ResolveResult`, `FailureActions` and `AttemptEntryView` are each used consistently by the service, both screens and the tests;
  - two dead ends: F8 (`destinationWarning`) and F10 (`directUrlOf`).

## What I could not check

- **The Docker walkthrough.** The Docker daemon is unreachable here. Unchecked: `docker compose up` from a clean clone, the smoke script against a live stack, the backup and restore commands, SC-008's 15-minute walkthrough, and whether `scripts/smoke.mjs` actually lands at `/app/scripts/smoke.mjs` in the image. That last one follows from the `COPY` of `.next/standalone` at `Dockerfile:33`, but it was not run.
- **Browser checks.** Unchecked:
  - whether the shipped screens satisfy the CSP with no console violations (FR-024, U5);
  - whether Next actually puts the nonce on every `<script>` in production;
  - the live-region and focus behaviour in F6;
  - keyboard operation of the dialogs and `<details>` in a real browser.
- **SC-001** (reach and resolve in under 30 seconds) is a human timing measure.
- **Live platforms.** The real Meta, Threads and Bluesky limits, and the U2 and U3 facts, are verified with mocks only, as the spec intends.
- **The test suite.** I did not re-run it, as the constitution asks. The green final gate comes from `docs/decisions.md`, not from CI on a PR, and no PR exists yet.
- **The Unraid steps** are generic and labelled unverified (U1). Whether they match a given Unraid version cannot be checked here.
