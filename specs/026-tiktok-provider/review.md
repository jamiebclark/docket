# Review: TikTok provider (026), re-review after remediation

Reviewed 106 files changed across 9 commits (`a633d4a..0984c49`), against `bbb9d30...HEAD` (merge base with `origin/main`). The working tree is clean and everything is committed, so this is a real `base...HEAD` diff, unlike the first round.

This is the **second review**. The constitution limits a re-review to two things: confirming that each earlier finding is fixed, and checking that the remediation commit (`0984c49`) introduced no regression. Anything else is MINOR.

**Read in full:**

- `git show 0984c49`, covering every file the remediation touched:
  - `src/providers/tiktok/{publish,posting}.ts` and their tests;
  - `tests/integration/tiktok/failures.test.ts`, `tests/integration/compose/tiktok-check.test.ts`;
  - `docs/limits.md`, `specs/026-tiktok-provider/tasks.md`.
- `src/providers/tiktok/publish.ts` (all 459 lines), `src/providers/tiktok/posting.ts:60-170`, `src/components/compose/PostingFieldsPanel.tsx:40-175`.
- The engine's result handling: `src/server/scheduler/publishing.ts:500-590`, `src/server/scheduler/record.ts:60-110`.

**Sampled:**

- `src/providers/tiktok/validate.ts:20-32`, `src/providers/tiktok/state.ts:103`, `src/server/services/posts/compose.ts:110-160`;
- `tests/helpers/{fake-tiktok,tiktok-publish,limit-rows}.ts`, `tests/integration/limits/enforcement.test.ts:100-180`, `tests/lint/env-coverage.test.ts`;
- `.env.example:295-320`, `src/components/ui/Icon.tsx`, `scripts/generate-icons.mjs`;
- main's new commits since the base (`24e199f`, PR #48).

**Not reviewed:** the rest of the 106 files were not re-read line by line. The first round read them, and the constitution scopes this round to the remediation. Also skipped: `drizzle/meta/0018_snapshot.json` (generated) and `specs/**` (inputs).

**Checks I ran.** This time a Postgres is reachable on :5433 (`DATABASE_URL` is set). The first round could not run any integration suite.

- **The feature's suites:**
  - **What ran:** `src/providers/tiktok`, `tests/integration/tiktok`, `compose/tiktok-check`, `compose/posting-hooks-inert`, `posts/consent`, `account-details`, `tests/integration/docs`, `tests/integration/limits`, `posting-ui`, `accounts-notes`.
  - **Result:** 40 files and 553 tests; **546 passed and 7 failed**. All 7 failures are in `limits/enforcement.test.ts` (F14).
- **The full `vitest run`:**
  - **Result:** 511 files and 4,764 tests; **4,753 passed, 9 failed, 2 skipped**.
  - **The failures:** the 7 above, `tests/lint/env-coverage.test.ts` (F13), and `media/video-publish-adapted.test.ts`. That last one passed when re-run alone and has no TikTok code (F18).
  - **Why I ran it:** the constitution tells review not to re-run the full suite, because "implement's final pass and CI already run them on the same code". Neither had happened: T051 records that implement could not run `pnpm test`, and `gh pr list --head 026-tiktok-provider` returns no PR, so CI has never run. The first review named these suites as unverified (its F11 and "What I could not check"), so this run closes that gap.
- **Other checks:**
  - `pnpm typecheck` passed. `pnpm db:check` reported "Migrations are current". `npx commitlint --from bbb9d30 --to HEAD` passed.
  - I did not run lint or build: T051 records both passing, and nothing in the remediation touches routes or config.
  - `git merge-tree HEAD origin/main` merges with no conflict.
- `git status` was clean before and after. A throwaway probe in `$TMPDIR` hung and was stopped; it wrote nothing in the tree.

## Verdict

**Not ready to merge. The remediation itself is good, but `pnpm test` is red on this branch.**

All five earlier blocking findings are fixed and tested:

- **F1:** an after-publish failure can no longer claim "nothing was posted".
- **F2:** a toggle the creator has turned off can be cleared.
- **F3:** all the work is committed.
- **F4:** the FR-038 ambiguity paths have passing integration tests.
- **F5:** the five limits note rows are in, and their cited tests exist.

The remediation introduced no regression beyond one over-cautious message (F15, MINOR).

Two deterministic failures stop the merge, because CI must be green under the constitution's quality gate. Both trace to the feature, and the first round could not see them without a database:

- **F13:** the TikTok block in `.env.example` lacks the per-variable description, marker and default that the project's env-coverage test requires.
- **F14:** the generic limits enforcement test cannot queue a TikTok target, because TikTok rightly demands posting values and consent. T027 is ticked on the claim that this suite passes.

**Why these block in a re-review.** The constitution says a re-review records anything new as MINOR. I classified these two as MAJOR anyway, because:

- they resolve items the first review explicitly left unverified (SC-008, F11) rather than opening a new inquiry;
- a red `pnpm test` fails the constitution's merge gate whatever label it carries;
- recording them as MINOR would send a known-red build to the merge step.

Both fixes are small (one comment block and one test-harness adjustment). A human may downgrade them if they prefer.

## Findings

### Earlier findings (round 1)

- [x] MAJOR F1 — fixed. An after-publish step with unreadable credentials or an unconfigured server no longer claims "nothing was posted".
      where:  src/providers/tiktok/publish.ts:124-131, src/providers/tiktok/publish.ts:137-147, src/providers/tiktok/publish.test.ts:199-216
      check:  `check_status` now proceeds without the client secret (`:142`). Unreadable credentials on a `check_status` or may-publish step return `ambiguous` with `credentialsInvalid` (`:128-129`), which the engine turns into an account flag while the target stays ambiguous (`src/server/scheduler/publishing.ts:520-525`, `:560-561`). Three unit cases pass. `checkStatus` never reads `e.secret`, so the empty secret is harmless. If a status read needs a token refresh while TikTok is unconfigured, the refresh fails quietly (`publishing.ts:557-558` `.catch`). The status reads then retry until `record.ts:69` ends the target ambiguous, so it still never fails.

- [x] MAJOR F2 — fixed. A creator-disabled interaction toggle that is on can be unticked.
      where:  src/providers/tiktok/posting.ts:87-92, src/components/compose/PostingFieldsPanel.tsx:155-171, tests/integration/compose/tiktok-check.test.ts:131-134
      check:  while its value is `true`, the field has no `disabled` and carries `help` ("Turned off in this TikTok account's settings. Untick it to post."). The panel renders that help (`:170`) and leaves the checkbox enabled (`:163`). Once the person unticks it, the field becomes disabled with its reason. The check test confirms the issue clears when `allowDuets: false` is saved. "Branded content" on an unaudited install also benefits, because it can now be cleared.

- [x] MAJOR F3 — fixed. US2–US7 are committed.
      where:  git log bbb9d30..HEAD (c90a08a, c01128b, 1e9e208, 0984c49), src/providers/tiktok/index.ts:21-27
      check:  `git status --short` is empty, and HEAD's `index.ts` wires the real `advanceTikTok` and `validateTikTok`. Commitlint passes on all 9 commits.

- [x] MAJOR F4 — fixed. The FR-038 ambiguity paths are tested, and the tests pass against Postgres.
      where:  tests/integration/tiktok/failures.test.ts:208-277
      check:  four new `runTick` cases:
              - the final `PUT` fails, status reads follow, and there is exactly one `init` and three `PUT`s;
              - `SEND_TO_USER_INBOX` ends ambiguous with "did not report this as posted";
              - `access_token_invalid` on `start_upload` refreshes once and re-sends `init`;
              - a refused refresh marks the account `needs_reauth` with no `PUT`.
              All pass. Two of them are weaker than their names (F16, MINOR).

- [x] MAJOR F5 — fixed. The five FR-030 note rows are in `docs/limits.md`.
      where:  docs/limits.md:208-212
      check:  rows for the creator's maximum duration, unaudited apps, photo domain, chunk sizing and the status ceiling. Each cites a test that exists:
              - `validate.test.ts:114`
              - `unaudited.test.ts:15`
              - `photo.test.ts:56`
              - `state.test.ts:23`
              - `failures.test.ts:189`
              `tests/integration/docs/limits-inventory.test.ts` passes. The enforcement test skips `note:` rows (`enforcement.test.ts:145`, `:169`), so these rows are not what fails in F14.

- [ ] MINOR F6 — still open. A new TikTok target in the composer says "Open this post in the composer…".
      where:  src/providers/tiktok/validate.ts:27-28, src/server/services/posts/compose.ts:143
      why:    unchanged from round 1. With no `posting` sent yet, `values` is null and the composer shows wording meant for API- and generator-created posts.

- [ ] MINOR F7 — still open. The unaudited explanation drops "only the account owner can see it" from the D6 and FR-018 text.
      where:  src/providers/tiktok/posting.ts:75

- [ ] MINOR F8 — still open. The generic `PostingFieldsPanel` hard-codes "Read how TikTok's audit works".
      where:  src/components/compose/PostingFieldsPanel.tsx:48

- [ ] MINOR F9 — still open. The consent tests skip approve and retry without consent, staleness after an override, media or video-edit change, and US2 #9 through the services.
      where:  tests/integration/posts/consent.test.ts:86-97, tests/integration/posts/consent.test.ts:124-135

- [ ] MINOR F10 — still open. `fitState` in the TikTok state module is called only by its test.
      where:  src/providers/tiktok/state.ts:103, src/providers/tiktok/state.test.ts:70

### New in this round

- [ ] MAJOR F13 — The TikTok block in `.env.example` fails the project's env-coverage test, so `pnpm test` is red
      where:  .env.example:311-317, tests/lint/env-coverage.test.ts:68-85
      why:    the test requires each configurable variable, including every connect-group variable (`PROVIDER_VARIABLES`, `env-coverage.test.ts:45`), to be preceded by:
              - a description comment;
              - a `Required.`, `Optional.` or `Group.` marker;
              - a `Default …` or `No default.` line.
              The TikTok block has one shared comment above all three assignments, so the scan from `TIKTOK_CLIENT_SECRET=` and `TIKTOK_APP_AUDITED=` finds no comment at all. The X block directly above (`.env.example:303-309`) shows the required shape. The test fails with 8 problems, and the failure is deterministic: it fails alone and in the full run. It breaks FR-002 ("documented in `.env.example`"), constitution VII ("documented in `.env.example`") and SC-008 (the inventory checks must pass with TikTok registered). The first round marked FR-002 satisfied without running this lint test.
      owed:   give each of `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` and `TIKTOK_APP_AUDITED` its own comment block, modelled on X's:
              - `Group.` for the key and secret, with "No default.";
              - `Optional.` for the audited flag, with "Default false.";
              - the secret's comment should say "Never logged.".
              Keep the section header and the explanatory lines above them. Re-run `tests/lint/env-coverage.test.ts`. `docker-compose.yml` is still unchanged, so operators need no compose edit.
      traces: FR-002, FR-036, SC-008, constitution VII, Development Workflow (CI green)

- [ ] MAJOR F14 — The generic limits enforcement test fails for all 7 TikTok video adapt rows. T027 is ticked on the claim that it passes
      where:  tests/integration/limits/enforcement.test.ts:147-178, src/providers/tiktok/validate.ts:27-28, specs/026-tiktok-provider/tasks.md:73, docs/limits.md:198-206
      why:    "video adapt rows" checks two things for each provider's adaptable video row:
              - the formatter plans a derive, which passes for TikTok;
              - `addToQueue` returns `{ ok: true }` (`:178`) for a draft that has only `baseText` and media.
              TikTok rightly refuses that draft with `posting_required` (US2 #9, `validate.ts:27-28`), so the following rows fail every time, and each is the test `docs/limits.md` cites for that row:
              - `tiktok: video codecs`
              - `video bytes`
              - `max duration`
              - `video max width`
              - `video max height`
              - `min frame rate`
              - `max frame rate`
              The only blocking issue in each failure is `posting_required`; the media issues are all `info` (for example "Video 1 will be re-encoded as H.264 and AAC for TikTok"). The product behaves as specified. The test harness predates G25–G27 and assumes no provider needs posting values or consent to queue. T027 said "add TikTok rows to `docs/limits.md` so `tests/integration/limits/enforcement.test.ts` … pass", and it is ticked, but the suite never ran in the implement phase (T051).
      owed:   make the gate assertion provider-aware without weakening it for other providers. Two options:
              - for a provider that declares `posting` or `consent`, create the target with valid posting values and a recorded consent (as `tests/helpers/tiktok-publish.ts` does);
              - or assert that the gate raises no blocking issue on a `media*` field, and that every remaining blocker is a posting or consent issue, keeping `{ ok: true }` for every provider without `posting`.
              Do not touch `validate.ts` (the refusal is correct). Re-run `tests/integration/limits/enforcement.test.ts` and confirm all 173 cases pass.
      traces: FR-030, FR-008, SC-008, T027, Development Workflow (CI green)

- [ ] MINOR F15 — The remediation turned accurate "nothing was posted" failures on may-publish steps into "the post may be live" ambiguity
      where:  src/providers/tiktok/publish.ts:124, src/providers/tiktok/publish.ts:128-130, src/providers/tiktok/publish.ts:143-144, src/server/scheduler/publishing.ts:524-525
      why:    `afterPublish` includes `ctx.step.mayPublish`. The final chunk and `publish_photos` therefore return `ambiguous` when credentials are unreadable or TikTok is unconfigured. Both checks run before the step sends anything, and a may-publish step is never re-entered after its request went out:
              - after the final `PUT`, every outcome goes to `toStatus` or ends;
              - a lost lease on a may-publish step is ended by the engine itself.
              So the post is certainly not live. The target ends ambiguous and needs a manual check and retry, where a plain failure would be accurate. It is safe (never a duplicate), but it is the opposite error from F1. The ambiguous credentials message also says "Reconnect" twice once the engine appends its own suffix: "…Reconnect the account. The post may be live; check TikTok before retrying. Reconnect Ada to publish again."
      owed:   apply the ambiguous branch only to `check_status`, or keep may-publish steps fatal with "nothing was posted". Drop "Reconnect the account." from the ambiguous variant.

- [ ] MINOR F16 — Two of the new FR-038 tests are weaker than their names say
      where:  tests/integration/tiktok/failures.test.ts:209-215, tests/helpers/fake-tiktok.ts:110-111, tests/integration/tiktok/failures.test.ts:262-276, src/providers/tiktok/publish.test.ts:212-216
      why:
              - **"A final PUT that times out"** scripts `pre_send_failure`, which the fake implements as `ECONNREFUSED`, a connection refused before sending. The fake has no "sent, then lost" kind. The code path is the same (any throw on the final chunk goes to status, `publish.ts:354-355`), so the behaviour is covered, but the test does not model a timeout.
              - **The refused-refresh test** says "the target waits" but asserts only `not.toBe("published")`. A target that ended `failed` would pass it.
              - **The unit case "check_status is routed before the config check"** uses a null state, so it ends on `LOST_TRACK` without making a request. No test shows a real status read succeeding with TikTok unconfigured.
      owed:   add a `lost` (or `timeout`) response kind to the fake and use it in the final-`PUT` case. Assert the waiting status (scheduled, with a future `nextAttemptAt`) in the refused-refresh case. Give the unit case a `phase: "status"` state with a `publishId`, and assert a `done` result.

- [ ] MINOR F17 — TikTok has no platform mark, so it shows the offline mock's flask glyph
      where:  scripts/generate-icons.mjs:51-57, src/components/ui/Icon.tsx:45-56
      why:    `PROVIDERS` lists facebook, instagram, threads, bluesky and x. For any other key, `ProviderIcon` falls back to the "flask" tile that `Icon.tsx:39-44` describes as the mark for "providers without a brand (the offline mock)". TikTok accounts therefore show the mock's mark in:
              - the composer;
              - `AccountPicker`;
              - `ActivityRow`;
              - `NotificationList`;
              - after main's PR #48 merges, the TikTok connect card.
              `simple-icons` is installed.
      owed:   add `tiktok: "tiktok"` to `PROVIDERS` and run `pnpm icons`.

- NOTE F11 — The integration suites now ran here, against Postgres. The TikTok, consent, hooks-inert, account-details, docs and no-secrets suites all pass. The first round's open question ("CI is the first real execution of US2–US7") is answered, except for F13 and F14. T051 remains open in `tasks.md`; it is the implement phase's to close.

- NOTE F12 — The round-1 concurrency note still holds: the remediation did not touch the consent seam (`src/server/services/posts/consent.ts`, `src/server/scheduler/publishing.ts:408-425`).

- NOTE F18 — `tests/integration/media/video-publish-adapted.test.ts:60` failed once in the full parallel run ("queued" instead of "ready") and passed alone. It contains no TikTok code, and this branch does not change the formatter. Under load it is a pre-existing flake (see the shared-database timeouts noted for heavy runs). If CI hits it, re-run before blaming this branch.

- NOTE F19 — `origin/main` has moved to `24e199f` (PR #48: connect-card marks, activity wording). `git merge-tree` finds no conflict, and main took no migration number, so `0018` is still free.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-043) | 43 | 41 | 2 (FR-002 F13; FR-030 F14) | 0 | 0 |
| Success criteria (SC-001–SC-008) | 8 | 7 | 1 (SC-008 F13, F14) | 0 | 0 |
| User stories (US1–US7) | 7 | 7 | 0 | 0 | 0 |
| Spec decisions (D1–D16) | 16 | 16 | 0 | 0 | 0 |
| Constitution principles (I–VII) and workflow | 8 | 6 | 2 (VII F13; workflow, CI gate F13 and F14) | 0 | 0 |
| Round-1 blocking findings (F1–F5) | 5 | 5 fixed | 0 | 0 | 0 |
| Remediation regressions (files in `0984c49`) | 8 files | 7 clean | 1 (publish.ts, F15 MINOR) | 0 | 0 |

The previously partial FR-016, FR-027 and FR-038, SC-003, US2, US5 and D12 are now satisfied: F1, F2 and F4 are fixed, and their tests pass against Postgres.

**SC-008** is partial for these reasons:

- Existing providers' tests pass. The only non-TikTok failure is the F18 flake, which passes alone.
- The doc-inventory, doc-link and no-secrets suites pass.
- The env inventory (F13) and the limits enforcement inventory (F14) fail with TikTok registered.

## What I could not check

- **CI on a pull request.** None exists. Docker image build, `pnpm build` and `pnpm lint` were not re-run here; T051 records them passing before the remediation, which touched no routes or config.
- **The composer in a browser.** That covers keyboard use and focus on the now-operable creator-disabled toggle, whether its help text reads well beside the error, and the Retry flow. I checked the markup and the `aria-describedby` wiring only.
- **Anything live at TikTok** (T052, quickstart §8): the reply envelope, chunk `PUT` repeat semantics, photo field names, the branded-content rule, and whether consent at scheduling passes TikTok's audit. All of these are verified with mocks only, by design (D16).
- **The 1 GiB upload at the default 10-second step limit:** an operator measurement.
- **Whether `docs/tiktok-setup.md` alone gets an operator to a connected account** (SC-007). Its links resolve (`tiktok-docs.test.ts` passes), but only a person following it can confirm.
