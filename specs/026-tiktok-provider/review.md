# Review: TikTok provider (026)

Reviewed 105 files changed against `bbb9d30` (merge base with `origin/main`): 77 tracked files (5 commits, `a633d4a..118c599`, plus uncommitted edits) and 28 untracked files. **Most of the feature is not committed.** HEAD holds only setup, the generic hooks and US1. US2–US7 (posting fields, publishing, failures, unaudited UI and docs) exist only in the working tree. So this review covers the **present working tree against the base**, not `base...HEAD`.

- **Read in full:**
  - providers: `src/providers/tiktok/{index,publish,state,steps,validate,posting,creator,http,errors,sealed,connect-group,refresh,settings,config,capabilities}.ts`, `src/providers/types.ts` (diff);
  - services: `src/server/services/posts/{consent,posting,notes,validate,compose,index}.ts` (diffs or full), `src/server/services/account-details.ts`;
  - engine: `src/server/scheduler/publishing.ts` (diff and lines 395–530), the relevant parts of `src/server/scheduler/record.ts`;
  - UI: `src/components/compose/{PostingFieldsPanel.tsx,posting-ui.ts}`, the diffs of `Composer.tsx`, `compose/[postId]/page.tsx`, `composer-logic.ts`, `posts/page.tsx`, `posts/[postId]/page.tsx`, `CalendarBoard.tsx`;
  - views and schema: `src/server/services/{calendar.ts,posts/list.ts,posts/view.ts}` (diffs), `drizzle/0018_burly_living_lightning.sql`;
  - docs: `docs/tiktok-setup.md`, `docs/limits.md` (TikTok section);
  - tests: `tests/helpers/tiktok-publish.ts`, `tests/integration/posts/consent.test.ts`, `tests/integration/compose/tiktok-check.test.ts`, `tests/integration/tiktok/{video,unaudited-ui}.test.*`, the first 140 lines of `failures.test.ts`.
- **Sampled:**
  - code: `src/providers/tiktok/{oauth,credentials}.ts`, `src/server/services/{accounts,connect}.ts` (diffs), `src/server/dal/{posts,targets}.ts` (the touched queries);
  - docs: `docs/{decisions,adding-a-provider,feature-map,accounts}.md`, `README.md`, `docs/index.md` (grep for the FR-031–FR-035 items);
  - tests: `tests/integration/tiktok/{photo,no-secrets,unaudited,connect,refresh}.test.ts` and `posting-hooks-inert.test.ts` (case lists only), the unit test files (case lists only).
- **Not reviewed:** `drizzle/meta/0018_snapshot.json` (generated) and `specs/**` (inputs, not output).

**Checks I ran** (no test database is reachable here: 5433 refuses connections, and 5432 has no `docket` role):

- The TikTok, Bluesky, media-range and `posting-ui` unit suites, through a database-free Vitest config in `$TMPDIR`: **31 files, 360 tests, all passed**.
- `tests/integration/docs/*` through the same config: 9 files passed, including `tiktok-docs`, `limits-inventory`, `provider-guide`, `readme` and `published-docs`. `n8n-flow` failed with `ECONNREFUSED :5433`, which is unrelated.
- Two throwaway probes in `$TMPDIR`, which confirmed F1 and F2 below.

The working tree was unchanged afterwards.

## Verdict

**Not ready to merge. It is close, and the design holds.**

**What holds up:**

- The generic hooks (G25–G28 and the G13 `now`) are inert for other providers.
- Consent is one implementation, judged by fingerprint. The composer check, the save, the gate and the engine all agree on it, because each one recomputes the fingerprint from the same `loadTargetContent` shape.
- The step machine follows the contract: only the final chunk and the photo `init` may publish, a final chunk is never re-sent, and `publish_id` becomes the external id.
- Secrets are sealed and scrubbed.

**What blocks the merge** (five MAJOR findings, all cheap to fix):

1. **F1:** the TikTok step function can mark a target **failed with "nothing was posted" after the final chunk or the photo `init` was sent**. This happens whenever TikTok's configuration or stored credentials are unreadable at a status check. It breaks SC-003 and constitution V, and the false message invites a duplicate post.
2. **F2:** an "Allow comments", "Allow duets" or "Allow stitches" toggle that is on, when the creator later turns that interaction off, is rendered disabled and still ticked. The validator then blocks scheduling, and the person cannot untick it: a dead end.
3. **F3:** US2–US7 are uncommitted, and HEAD still registers TikTok with stub publishing.
4. **F4:** the safety-critical paths FR-038 names have no test: a final-chunk timeout going to status checks, `SEND_TO_USER_INBOX`, and `access_token_invalid` at publish.
5. **F5:** `docs/limits.md` lacks the five TikTok note rows FR-030 requires.

The integration suites have never run in this environment (T051 is still open). CI must run them before a human merges.

## Findings

- [ ] MAJOR F1 — After publishing, an unconfigured TikTok or unreadable credentials end the target `failed`, "nothing was posted", instead of ambiguous
      where:  src/providers/tiktok/publish.ts:123, src/providers/tiktok/publish.ts:130-135, src/providers/tiktok/publish.ts:147, src/server/scheduler/record.ts:96
      why:    `advanceTikTok` checks the credentials (`:123–124`) and calls `requireTikTokConfig()` (`:130–135`) before it routes to `check_status` (`:147`), and returns `fatal_error` from both checks. The engine records a provider's `fatal_error` as `failed` even on an after-publish step (`record.ts:96`). Its own G23 rescue (`publishing.ts:503–506`) covers only the engine's own exceptions. Reproduced with a probe: state `phase: "status"` with a `publishId`, both TikTok variables empty, step `check_status`. The result is `{"kind":"fatal_error","error":"TikTok is not configured on this server; nothing was posted."}`, and no status read is made. The final chunk or photo `init` has already gone out at that point, so the post may be live. A person who trusts "nothing was posted" and retries makes a duplicate. That contradicts D12 ("status checks … can only end published, failed by TikTok's own report, or ambiguous"), SC-003 and constitution V. Realistic trigger: an operator restarts the worker with the TikTok variables removed or emptied while a post is in its ≤ 60-minute status window.
      owed:   route `check_status` before the configuration check; it needs only the access token, not the client secret. When the credentials are unreadable or TikTok is unconfigured on an after-publish step, return `ambiguous` (or `retryable_error`, which the engine turns into ambiguous at max attempts), never `fatal_error`. Add a unit case to `publish.test.ts` for each.
      traces: FR-026, FR-027, SC-003, D12, constitution V

- [ ] MAJOR F2 — A creator-disabled interaction toggle that is on can be neither unticked nor scheduled
      where:  src/providers/tiktok/posting.ts:97-100, src/components/compose/PostingFieldsPanel.tsx:162-163, src/providers/tiktok/validate.ts:53-61
      why:    `view()` keeps the stored `value: true` and adds `disabled` when creator info says the interaction is off. The panel renders `checked={field.value}` and `disabled={!!field.disabled}`. Meanwhile `validateTikTok` raises the blocking `interaction_disabled` ("Ada has turned off comments on TikTok."). Reproduced with a probe: values `{privacy: FOLLOWER_OF_CREATOR, allowComments: true}` and details `commentDisabled: true` give the field `{"value":true,"disabled":{…}}` and the issue `interaction_disabled@posting.allowComments`. The composer has no other way to change the value: `postingValues` changes only through the panel's `onChange`, and a reload re-seeds it from the stored row. Realistic triggers:
              - a saved draft whose creator later turns comments, duets or stitches off;
              - a person who ticks a toggle while the details read failed (no `disabled` yet), then presses Retry.
              The target can then never be scheduled to TikTok. The cross-pass seam: `posting.ts` (T028), `validate.ts` (T029) and the panel (T031) are each plausible alone.
      owed:   let the person clear it. Either keep a disabled toggle enabled while its value is `true` (so it can only be turned off), or have `view()` show it unticked and the composer send `false`. Add a `posting.test.ts` case, and a `tiktok-check.test.ts` case where saving `false` clears the issue.
      traces: FR-016, US2 #3, D7, SC-005

- [ ] MAJOR F3 — US2–US7 are uncommitted; HEAD registers TikTok with stub publishing
      where:  src/providers/tiktok/index.ts:21-27 (working tree), specs/026-tiktok-provider/tasks.md:73-139
      why:    `git status` shows 22 modified and 28 untracked files. They include `publish.ts`, `posting.ts`, `validate.ts`, `steps.ts`, `state.ts`, `sealed.ts`, `errors.ts`, `PostingFieldsPanel.tsx`, the `Composer.tsx` edits, `docs/tiktok-setup.md` and every US2–US7 test. At HEAD, `src/providers/tiktok/index.ts` still has `advance: async () => ({ kind: "fatal_error", error: NOT_BUILT })` and plain capability validation. A PR or merge of HEAD would therefore ship a registered TikTok provider that cannot publish, with no posting fields and no consent: US2, US3, US4 and US6 would not work. Tasks T027–T050 are ticked, but none of their work is in git. The constitution's workflow rule is "commit after each completed task … explicit paths".
      owed:   commit the existing working-tree changes in logical conventional commits with explicit paths, for example US2, US3+US4, US5+US6 and docs. Do this before or together with the other remediation tasks, and confirm `git status` is clean afterwards.
      traces: Development Workflow (commits), US2–US7

- [ ] MAJOR F4 — FR-038's ambiguity-path tests are missing: a final-chunk timeout going to status checks, `SEND_TO_USER_INBOX`, and `access_token_invalid` at publish
      where:  tests/integration/tiktok/failures.test.ts:138-203, src/providers/tiktok/publish.test.ts:68-154, src/providers/tiktok/publish.ts:343, src/providers/tiktok/publish.ts:439-441, src/providers/tiktok/publish.ts:92-93
      why:    FR-038 requires tests for "a timeout after the final chunk going to status checks; `FAILED`, `SEND_TO_USER_INBOX` and the 60-minute ceiling". US5 scenarios #5 and #7 and contract §9 add "`access_token_invalid` refresh then retry; a refused refresh leading to needs_reauth". A grep of `src/providers/tiktok/*.test.ts` and `tests/integration/tiktok/` finds none of the following:
              - a final-chunk network failure, which `publish.ts:343` sends to status checks;
              - `SEND_TO_USER_INBOX` (`:439–441`);
              - `access_token_invalid` or `credentialsExpired` on `check_creator`, `start_upload` or `check_status` (`:92–93`, `:409–410`).
              These are the paths that decide between a duplicate, a miss and ambiguity. T043 is ticked, but its test file stops at the 403-restart and 60-minute cases.
      owed:   add integration cases through `runTick` to `failures.test.ts`:
              (a) the final `PUT` times out: status reads follow, there is no second `PUT` and no second `init`, and the target ends published or ambiguous;
              (b) `SEND_TO_USER_INBOX` ends ambiguous with the D11 message;
              (c) `access_token_invalid` on `start_upload` refreshes and retries, and a refused refresh marks the account `needs_reauth` while the target waits.
      traces: FR-038, US5 #5, US5 #7, SC-003

- [ ] MAJOR F5 — `docs/limits.md` lacks the five TikTok note rows FR-030 requires
      where:  docs/limits.md:183-207
      why:    FR-030 requires note rows for:
              - the creator's maximum duration;
              - the unaudited private-only rule and 5-account cap;
              - the photo domain verification;
              - the chunk sizing;
              - the 60-minute status ceiling.
              data-model §9 lists them. The TikTok table has only the 21 capability rows, while every other video provider carries its `note:` rows (Instagram `:94`, Threads `:134`, Bluesky `:161–165`). T027 is ticked.
      owed:   add the five `note:` rows with source, enforcement point and an existing test. Possible test citations: `src/providers/tiktok/validate.test.ts` for the creator duration, `tests/integration/tiktok/unaudited.test.ts`, `tests/integration/tiktok/photo.test.ts` "surfaces url_ownership_unverified as a plain failure", `src/providers/tiktok/state.test.ts` for the chunk plan, and `tests/integration/tiktok/failures.test.ts` "ends ambiguous when TikTok is still processing after 60 minutes". Then re-run `tests/integration/docs/limits-inventory.test.ts`.
      traces: FR-030

- [ ] MINOR F6 — A new TikTok target in the composer says "Open this post in the composer to choose TikTok's settings…"
      where:  src/providers/tiktok/validate.ts:27-28, src/server/services/posts/compose.ts:143
      why:    the composer sends no `posting` until a field is touched, so `values` is null and `validateTikTok` raises `posting_required`. That message was written for API- and generator-created posts (US2 #9), but here the person already is in the composer. It still blocks correctly; only the wording is wrong in this context.
      owed:   in the check, treat absent values for a provider with `posting` as the declaration's defaults (so the issue becomes `privacy_required`). Alternatively, word the composer-side issue differently.

- [ ] MINOR F7 — The unaudited explanation is not the spec's text
      where:  src/providers/tiktok/posting.ts:75
      why:    D6 and FR-018 give "Your TikTok app hasn't passed TikTok's audit, so every post is private: only the account owner can see it. The TikTok account itself must also be set to private." The code says "This TikTok app hasn't passed TikTok's audit, so every post is private. The TikTok account must also be set to private." It drops "only the account owner can see it".
      owed:   use the spec's sentence. `unaudited-ui.test.tsx:65` matches only a fragment, so it keeps passing.

- [ ] MINOR F8 — The generic `PostingFieldsPanel` hard-codes TikTok copy
      where:  src/components/compose/PostingFieldsPanel.tsx:48
      why:    the notice link always reads "Read how TikTok's audit works", whichever provider declared the notice. The plan says "there is no TikTok-specific UI code" (constitution V). The composer-ui contract §3 prescribes this label, so the contract itself is inconsistent here. The next provider with a `notice` would show TikTok's wording.
      owed:   carry the link label in `notice()` (for example `{ text, doc, docLabel }`) and render that.

- [ ] MINOR F9 — Consent tests skip several paths the contract lists
      where:  tests/integration/posts/consent.test.ts:86-97, tests/integration/posts/consent.test.ts:124-135, tests/integration/posts/consent.test.ts:281-292
      why:    the contract's `consent.test.ts` list asks for:
              - approving (auto-queue) and retrying without consent (only queue, schedule and publish-now are driven);
              - consent going stale on an override, media or video-edit change (only text and a posting value are driven);
              - US2 #9, an API, generator or bulk-created TikTok post refused with the `posting_required` message while other targets are unaffected (tested only at the unit and check level).
              All of these share the gate, so the risk is low.
      owed:   add the missing cases.

- [ ] MINOR F10 — `fitState` in the TikTok state module is dead code
      where:  src/providers/tiktok/state.ts:103-108, src/providers/tiktok/publish.ts:308
      why:    `publish.ts` repeats the kind and file checks inline (`:308`), and `steps.ts:18` does its own kind check. `fitState` is called only by its test, so two passes each wrote a "does the state still fit" rule.
      owed:   use `fitState` in `advanceTikTok`, or delete it.

- NOTE F11 — The integration suites have never run in this environment. T051 (`pnpm test`, `pnpm db:check`) is still open and BLOCKED, and none of the 14 TikTok and hook integration files could be executed here. The unit and docs suites I could run all pass. The constitution's merge gate (CI green, real Postgres) is therefore the first real execution of US2–US7. The tests read as meaningful: they drive `runTick` and the services against the fake TikTok, not the code under test.

- NOTE F12 — I checked concurrency at the consent seam and found it bounded:
  - The engine reads the text (`effectiveContent`, `src/server/scheduler/publishing.ts:408`) and the consent (`loadTargetContent`, `:425`) in separate queries. Every commit that changes a scheduled target re-gates it (`src/server/services/posts/index.ts:317-324`, after `settleConsent`), so whatever text the engine reads was covered by a valid consent when it was committed.
  - A failed live details read never clears a stored consent (`consent.ts:128–129`).
  - The details cache is keyed by account id, after the project-scope check (`account-details.ts:35–56`).

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted | Unverified |
|---|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-043) | 43 | 39 | 4 (FR-016 F2, FR-027 F1, FR-030 F5, FR-038 F4) | 0 | 0 | 0 |
| Success criteria (SC-001–SC-008) | 8 | 6 | 1 (SC-003 F1) | 0 | 0 | 1 (SC-008: existing suites not run here) |
| User stories (US1–US7, acceptance scenarios read one by one) | 7 | 5 | 2 (US2 F2; US5 F1, F4) | 0 | 0 | 0 |
| Spec decisions (D1–D16) | 16 | 15 | 1 (D12 F1) | 0 | 0 | 0 |
| Constitution principles (I–VII) and workflow | 8 | 6 | 2 (V F1, F8; workflow F3) | 0 | 0 | 0 |

Constitution sweep categories:

- concurrency and locking: F12;
- idempotency and retries: a final chunk is never re-sent; the photo `init` is ambiguous on any lost reply; a refused repeat of a chunk restarts;
- authorization and project scoping: `readAccountDetails` checks scope and permission first; consent is recorded only for a member actor; the public API mapper omits `postingFields`;
- time zones: DB clock throughout, ISO UTC in the state, UTC date in the reconnect note;
- error, timeout and ambiguous paths: F1, F4;
- secrets: the upload address is sealed and added to the scrub list; `explainTikTok` strips links and query secrets; no token reaches the state or summaries.

## What I could not check

- **Every integration suite against Postgres:** `tests/integration/tiktok/*`, `compose/tiktok-check`, `compose/posting-hooks-inert`, `posts/consent`, `src/server/services/account-details.test.ts`, `limits/enforcement`, and the existing providers' suites (SC-008). No test database is reachable in this sandbox. CI or a machine with `DATABASE_URL` on port 5433 must run `pnpm test` and `pnpm db:check` (T051).
- **The composer in a browser:** keyboard use, focus, `aria-describedby` wiring, the Retry flow, and the ticked-then-stale consent box. I reviewed the markup only.
- **Anything live at TikTok** (T052, quickstart §8):
  - the reply envelope, the token fields and the absence of PKCE;
  - chunk `PUT` behaviour, including whether Node's `fetch` sends the manual `content-length`, and the repeat semantics;
  - the photo field names, and the branded-content rule;
  - whether consent at scheduling passes TikTok's audit.
  All of these are verified with mocks only, by design (D16).
- **The 1 GiB upload at the default 10-second step limit** (≈ 30 Mbit/s): an operator measurement.
- **Whether `docs/tiktok-setup.md` alone gets an operator from no app to a connected account** (SC-007). I checked it against FR-034's list and its links resolve (`tiktok-docs.test.ts` passed), but only a person following it can confirm.
