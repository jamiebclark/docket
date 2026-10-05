# Review: Hardening for real use — failures view, limits audit, security pass, configuration and deployment (010), re-review after remediation

This is a **re-review**, so it is scoped. The constitution (`.specify/memory/constitution.md:125-128`) says a re-review "checks ONLY that each earlier finding is fixed and that the files changed by the remediation introduced no regression". Anything else it notices is recorded as MINOR.

The first review is in git at `e48d1ea`. It covered the full 122-file feature diff (`a50f8ba...3cd060a`) across every category, and found two MAJOR findings (F1, F2), seven MINOR (F3–F9) and three NOTEs (F10–F12).

The feature has since been merged to `main` (PR #15, merge `e6c61e0`). The branch tip is `85f6d88` (`origin/010-hardening-deployment`). `git diff --stat 85f6d88 main -- tests/ src/server/services/media.ts docs/limits.md docs/security.md` is empty, and no commit since the merge touches `src/` or `tests/` (`git log e6c61e0..main -- src tests`). So the remediated code on `main` is exactly what is reviewed here.

- **Remediation diff, read in full:** 4 commits and 11 files, `e48d1ea..85f6d88`.
  - `b070fc3` (F1): `tests/integration/security/secret-scan.test.ts`, `docs/security.md`
  - `fdf43b4` (F2):
    - `tests/helpers/limit-rows.ts` (new)
    - `tests/integration/limits/enforcement.test.ts`
    - `tests/integration/docs/limits-inventory.test.ts`
    - `docs/limits.md`
    - `src/server/services/media.ts` (`ACCEPTED_TYPES` renamed and exported as `UPLOAD_MIME_TYPES`)
    - the F2 note in `docs/decisions.md:428`
  - `5e62266`: bookkeeping — `review.md` F1/F2 ticked, `tasks.md` T076/T077 ticked, and the F1 judgement call in `docs/decisions.md:455`.
  - `85f6d88`: `docs/deployment.md` "Verified run" table, and T068 ticked (`tasks.md:153`).
- **Present state on `main`, checked:** the files above, plus whether F3–F9 are still open (see each finding).
- **Not re-reviewed:** the rest of the 122-file feature diff. The first review covered it, and the re-review rule excludes new lines of inquiry.

**Probes:**

- **Remediation tests.** On `main` I ran `pnpm vitest run tests/integration/security/secret-scan.test.ts tests/integration/limits/enforcement.test.ts tests/integration/docs/limits-inventory.test.ts`: 3 files, 85 tests, all passed.
- **Test isolation.** The new scan deletes every user (`secret-scan.test.ts:182-183`). I checked that this is safe:
  - `vitest.config.ts` gives each worker its own database clone, and files run serially within a worker.
  - `tests/integration/bootstrap.test.ts:80-81` already uses the same pattern.
  - The only other reader of install state, `tests/integration/anonymous-entry.test.ts:14`, expects setup to be unavailable, which the scan leaves true.
- **The rename.** `UPLOAD_MIME_TYPES` (`src/server/services/media.ts:43`) is display-only. It lists the same three types the upload processor stores (`src/server/media/process.ts:10`). No reference to `ACCEPTED_TYPES` remains.
- **Not run:** the full suite, lint, typecheck and build, per the constitution's review rule.

## Verdict

**The remediation holds, and nothing blocks the merge** (which has already happened).

**F1 is fixed.** The secret scan now:

- seeds `META_APP_SECRET` and `THREADS_APP_SECRET`;
- runs first-user setup through the setup service;
- signs in for real, and scans the session token everywhere except the three appearances it asserts by location;
- drives Meta and Threads connects whose platform errors echo the app secret;
- resolves two ambiguous targets (published with a URL; not published and requeued).

`docs/security.md` now lists exactly what is scanned, and what is not.

**F2 is fixed.** Every `docs/limits.md` row now cites a test generated from that provider's own capability values. The doc test now rejects a citation that names no real test, or a test that sits in a suite other than the row's enforcement point.

Neither fix introduced a regression I could find. The seven MINOR findings from the first review are all still open and are carried forward unchanged. I add one new MINOR (F13): the recorded Docker run does not show SC-009, and the doc already says so.

## Findings

- [x] MAJOR F1 — The end-to-end secret scan did not seed or drive everything FR-020 lists — **resolved**
      where:  tests/integration/security/secret-scan.test.ts:17-23, tests/integration/security/secret-scan.test.ts:151-152, tests/integration/security/secret-scan.test.ts:181-216, tests/integration/security/secret-scan.test.ts:238-254, tests/integration/security/secret-scan.test.ts:270-281, tests/integration/security/secret-scan.test.ts:349-356, tests/integration/security/secret-scan.test.ts:386-391, docs/security.md:9-10, docs/security.md:23
      why (each point from the first review, checked against the code):
        - **Meta and Threads app secrets.** They are now seeded in `ENV` (:17-20) and added to `ENV_SECRETS` (:151-152).
          - The connect runs through `connect.startOAuthConnect` and `handleOAuthCallback`, bound to the real session.
          - The fake Graph returns errors that echo each secret (:240-241).
          - The test asserts that both exchanges sent the secret to the platform (:252), so the secret really is in play in this run.
        - **Session token.** A real `sign-in/email` goes through the auth handler, and the token is read from the `session` table (:190-200).
          - Its three appearances are asserted: the `Set-Cookie` (:205), the sign-in body's `token` (:207) and `get-session`'s `session.token` (:353).
          - Each is then removed by location. The rest of both responses is scanned (:208-210, :354-356), and the token is in the scanned set (:387).
          - The JSON-body appearances are a real finding. They are recorded honestly as low and accepted (`docs/security.md:23`, `docs/decisions.md:455`), not hidden.
        - **Setup.** It is driven through `setup.createFirstUser`, including a refused second call (:181-187), and the setup password is scanned (:386).
        - **Resolution.** `resolveAmbiguous` runs on two genuinely ambiguous targets: 502s on `createRecord` whose messages echo tokens (:260-261, :270-281). The test asserts the results `["published", "scheduled"]`.
        - **The record now matches the code.** The "Secrets in …" rows of `docs/security.md` list exactly these steps and secrets, and name what is not scanned (database URL password, `BOOTSTRAP_ADMIN_PASSWORD`, `MINIO_ROOT_PASSWORD`).
        - **Regression check.** The scope now comes from the setup user added as owner (`addMember`, :215-216) rather than `env.scope`. The page renders use the real session id (:310). The deliberate-leak test (:165) is unchanged, so the scan is still proven able to fail.
      traces: FR-020, FR-028, SC-005, US3 AS1

- [x] MAJOR F2 — About 15 limits-inventory rows cited a test that did not break that limit — **resolved**
      where:  tests/helpers/limit-rows.ts:48-69, tests/helpers/limit-rows.ts:92-176, tests/helpers/limit-rows.ts:193-197, tests/integration/limits/enforcement.test.ts:50-56, tests/integration/limits/enforcement.test.ts:67-95, tests/integration/limits/enforcement.test.ts:97-111, tests/integration/limits/enforcement.test.ts:113-157, tests/integration/docs/limits-inventory.test.ts:119-138, docs/limits.md:22-87
      why (each point from the first review, checked against the code):
        - **Instagram and Threads planner rows.** These are bytes, formats, min/max width and min/max aspect. They now drive `planImage` over `mediaConstraintsOf(provider.capabilities)` (`limit-rows.ts:178-179`), with each provider's own values:
          - an oversize file must derive a `compress` step to `c.maxBytes`;
          - a type the provider does not accept must derive `convert`;
          - too wide must derive `downscale` to exactly `maxWidth`;
          - too small and out-of-aspect must refuse with `image_too_small` or `aspect_ratio_out_of_range`.
          Each row also checks an asset just inside the limit, which must not trigger the same rule (`enforcement.test.ts:102-107`). That gives every row a case that fails if the boundary moves.
        - **Formats for Facebook, Bluesky and the mock.** These rows use the first uploadable type the provider does not accept (WebP), so a real conversion is exercised (`limit-rows.ts:119-131`).
        - **Account-level limits.** For Facebook and the mock, a `none` publish limit is now proved with an account-level limit set through `accounts.setPublishLimit` (`enforcement.test.ts:119-124`). The test asserts the provider really declares none.
        - **Instagram text length.** It now runs end to end with a stored JPEG attached (`enforcement.test.ts:75-76`), so only the text breaks the limit.
        - **The doc test.** It now:
          - requires a quoted name on every row (`limits-inventory.test.ts:125`);
          - for `enforcement.test.ts`, requires exactly `<provider>: <category>` and that a test of that name is generated in the suite matching the row's "Enforced in" cell (:127-134);
          - elsewhere, matches only literal `describe`/`it`/`test` titles, not raw file text (:136).
          So the wrong-citation case F2 described now fails.
        - **The Threads carousel-minimum note.** It moved to a real literal title in `tests/integration/threads/publish-e2e.test.ts`.
        - **Regression check.** `UPLOAD_MIME_TYPES` (`src/server/services/media.ts:43`) is a rename and export only. `mediaStatus` returns the same list, and nothing else in `src/` read the old name.
      traces: FR-014, FR-017, SC-004, US2 AS1

- [ ] MINOR F3 — The proxy's same-origin guard is skipped for any path ending in a static-file extension, and Server Actions are reachable there (carried forward, still open)
      where:  src/proxy.ts:92, node_modules/next/dist/server/app-render/action-handler.js:440-445
      why: The matcher is unchanged on `main`, so the reasoning in the first review (`e48d1ea`) still applies. Next's own action check lets a request with no `Origin` header through with only a warning, which is the gap D16 added the proxy guard to close. On these paths the guard never runs. This is defence in depth, not a working CSRF: `SameSite=Lax` and browsers' `Origin` header block the practical attack.
      owed: Apply the guard to non-GET requests whatever the extension, and add a matcher test for a POST to a `.png` page path.
      traces: FR-021, SC-006

- [ ] MINOR F4 — Past the last page, the failures view says "Nothing needs attention" (carried forward, still open)
      where:  src/app/p/[projectSlug]/failures/page.tsx:166, src/app/p/[projectSlug]/failures/page.tsx:202
      why: `empty` is still `list.rows.length === 0`, and it ignores how many rows match in total (`list.filtered`).
      owed: Show "This page is empty" with a link to the last page, or clamp the page in `listFailures`.
      traces: FR-004, FR-013

- [ ] MINOR F5 — Requeue skips `prepareForScheduling`, so a missing variant becomes a spurious conflict (carried forward, still open)
      where:  src/server/services/posts/index.ts:681-752, src/server/services/posts/index.ts:440
      why: `addToQueue` (:440), `scheduleAt` (:581) and `publishNow` (:596) prepare variants first. `resolveAmbiguous` still does not.
      owed: When `requeue` is true, call `prepareForScheduling(scope, target.postId, { targetIds: [targetId] })` before `withLockedTarget`.
      traces: FR-008, constitution IV

- [ ] MINOR F6 — On the failures view, the result announcement and the focus are probably lost when the row disappears (carried forward, still open; needs a browser to confirm)
      where:  src/components/targets/TargetResolution.tsx:106, src/app/p/[projectSlug]/posts/actions.ts:33
      owed: Move the announcement to a page-level live region. After a successful action, move focus to the table caption or the next row.
      traces: FR-013

- [ ] MINOR F7 — A blocked retry always links "Reconnect <account>", even when reconnecting cannot help (carried forward, still open)
      where:  src/components/targets/TargetResolution.tsx:116-122, src/server/services/failures.ts:161
      owed: Show the reconnect link only when the account exists and needs reconnecting.
      traces: FR-009, US1 AS7

- [ ] MINOR F8 — The save-time "couldn't look up that host" warning never reaches the user (carried forward, still open)
      where:  src/server/services/webhooks/endpoints.ts:108, src/app/p/[projectSlug]/settings/webhooks/actions.ts:37
      why: `createEndpoint` still returns `destinationWarning`, and no caller in `src/` reads it.
      owed: Pass it through the action and show it next to the `http` warning.
      traces: FR-023

- [ ] MINOR F9 — Two new behaviours have no test (carried forward, still open)
      where:  src/app/p/[projectSlug]/posts/[postId]/page.tsx:131-163, src/server/scheduler/publishing.ts:379-380
      why: Neither of these tests exists in `tests/`:
        - the plan's `tests/integration/posts/detail-resolution.test.tsx`;
        - a pre-call test that makes `getCredentialsCiphertext` throw and expects the target to be retried, not marked ambiguous.
      owed: as in the first review.
      traces: FR-011, FR-012

- [ ] MINOR F13 — The recorded Docker run does not show SC-009 (the restored backup contains the posts created before it), though §4 reads as if the backup was proven
      where:  docs/deployment.md:56, docs/deployment.md:86, scripts/smoke.ts
      why:
        - SC-009 requires that "a database backup … restored with the documented procedure contains the posts created before the backup".
        - The run in `85f6d88` shows only that `pg_dump`/`pg_restore` exit 0 and the app comes back healthy. Line 56 says this honestly.
        - But the backup section's footnote now reads "(Run 2026-10-04 — see 'Verified run' above.)" (:86). A reader who stops there sees a proven backup.
        - The smoke script creates a post in each run, but never checks that an earlier run's post survived.
      owed: Either:
        - make the second smoke run (or a separate check) assert that the post id from the first run is still listed after the restore, and record that; or
        - change :86 to say the restore ran but data survival was not checked.
      traces: SC-009, FR-035

- NOTE F10 — The empty-means-unset rule is still implemented three times (`src/server/env.ts:302`, `src/server/env.ts:310`, `scripts/prestart.mjs:14`, `drizzle.config.ts:4`), and `directUrlOf` is still used only by a test. Unchanged from the first review; FR-033 holds.

- NOTE F11 — The import cycle `services/posts/index.ts` → `./view` → `../failures` → `./posts` is unchanged. It works because every use happens at call time.

- NOTE F12 — Deployment is now partly verified.
  - **Run:** a clean-checkout Compose run, the smoke script, and backup and restore. They are recorded with commands, results and a date at `docs/deployment.md:44-56`, so FR-037 moves from "reported as not run" to satisfied.
  - **Not run:** the browser check for CSP errors in the console (FR-024, U5) and the manual UI walkthrough (SC-008). The doc says so.
  - **T068 is ticked anyway** (`specs/010-hardening-deployment/tasks.md:153`). An inline caveat says the browser check was not run, so the box is not misleading, but that check is still owed by a human.

## Coverage

Scope: this re-review re-checked the obligations the remediation touched. For everything else, the counts are the first review's (`e48d1ea`), adjusted only where the remediation or the recorded run changed the evidence.

| Checked | Count | Satisfied | Partial | Absent | Contradicted | Not verifiable here |
|---|---|---|---|---|---|---|
| Earlier blocking findings (F1, F2) | 2 | 2 fixed | 0 | 0 | 0 | — |
| Earlier MINOR findings (F3–F9) | 7 | 0 fixed (all still open, none worse) | — | — | — | — |
| Functional requirements (FR-001–FR-042) | 42 | 42 (FR-014, FR-017, FR-020 and FR-028 now satisfied; FR-037 now by a real run) | 0 | 0 | 0 | — |
| Success criteria (SC-001–SC-011) | 11 | 8 (SC-004 and SC-005 now satisfied) | 1 (SC-009, F13) | 0 | 0 | 2 (SC-001, SC-008) |
| User stories (P1–P3) | 6 | 6 (US2 and US3 now satisfied) | 0 | 0 | 0 | — |
| Constitution core principles (I–VII) | 7 | 7 | 0 | 0 | 0 | — |

**Regression check of the remediation files:**

- **`secret-scan.test.ts`:**
  - It deletes every user (:182-183) and leaves the install marked as set up. That is safe under one database clone per worker, and `anonymous-entry.test.ts` expects exactly that state.
  - `BETTER_AUTH_URL` is set to `https://docket.scan.test` inside `vi.hoisted` (:23), so the change is scoped to this file.
  - Auth does not use Better Auth's cookie cache (no `cookieCache` in `src/server/auth`). So dropping the whole sign-in `Set-Cookie` header (:209) hides only the session cookie.
- **`limit-rows.ts` and `enforcement.test.ts`:**
  - The `afterEach` that fails any platform request (:32-35) still guards every generated row.
  - The per-row timeout (`60_000`) covers seeding up to 11,666 rows for Bluesky's daily limit.
- **`limits-inventory.test.ts`:** the old existence check (:107-117) is kept, and the new test is added alongside it.
- **`media.ts`:** a rename and export only (see the probes above).

## What I could not check

- **The browser CSP check (FR-024, U5) and the manual walkthrough (SC-008).** Neither was run in the recorded Docker run (`docs/deployment.md:56`), and this phase has no browser.
- **The Docker run itself.** I did not re-run it. I am relying on the table in `docs/deployment.md:44-54`, which `85f6d88` added from a session outside this pipeline.
- **SC-001**, the 30-second reach-and-resolve time, is a human timing measure.
- **F6 (live region and focus)** is still plausible from the code, but not observed.
- **The full suite, lint, typecheck and build.** Not re-run, per the constitution. I ran only the three remediation test files, and they passed. I did not read CI for PR #15.
- **Live platforms.** Meta, Threads and Bluesky limits and token-exchange errors are exercised only against fakes (`createFakeGraph`, `createFakePds`), as the spec intends.
