# Review: Account posting instructions (011)

Reviewed 101 changed files (86 tracked, 15 new) against `9c809ce` (merge-base with `origin/main`). The branch has 3 commits: spec (`161a70a`), plan (`0451325`) and golden fixtures (`efbc225`). **The whole implementation, T003–T046, is uncommitted in the working tree.** So this review covers base…working tree (`git diff 9c809ce` plus untracked files), not base…HEAD.

**Read in full (diff or whole file):**

- **Grouping and generation:**
  - `src/lib/generation/groups.ts` and `src/server/services/generation/groups.ts`
  - `prompt.ts`, `schema.ts`, `core.ts`, `single.ts`, `save.ts`, `series.ts`, `regenerate.ts`
- **Jobs:** `src/server/services/jobs/{create,runner,read}.ts`
- **Posts and review:** `src/server/services/posts/{index,variant-groups}.ts`, `src/server/services/review.ts`
- **Services and data:**
  - `src/server/services/{voice,accounts}.ts` and `src/server/services/views/account.ts`
  - `src/server/dal/accounts.ts`, `src/server/db/schema/{accounts,jobs,audit}.ts`
  - `src/lib/validation/{generation,jobs,voice}.ts`, `src/lib/api/schemas.ts`
  - `src/server/api/operations/generate.ts`, `src/lib/action-result.ts` (consumer)
- **UI:**
  - `accounts/{page,PostingInstructionsForm,actions}`
  - `generate/{GenerateForm,generate-logic,page,actions}` and `generate/result/[postId]/{page,VariantEditor,variant-logic}`
  - `review/{ReviewList,actions}`
  - `jobs/{new/JobForm,new/form-data,[jobId]/page}`
  - `voice/{TryItPanel,VoiceEditor,scope,voice-logic,[profileId]/history/page,[profileId]/page,new/page}`
  - `settings/members/{activity-list,page}`
- **Migrations:** `drizzle/0008_lazy_guardsmen.sql`, `drizzle/0009_copy_platform_guidance.sql`, `_journal.json`
- **Docs:** `docs/{generator,accounts,decisions}.md`
- **Tests:**
  - `tests/integration/generation/{group-limit,try-it-accounts,posting-instructions}.test.ts`
  - `tests/integration/jobs/posting-instructions.test.ts`
  - `src/lib/generation/groups.test.ts`, `prompt.golden.test.ts`, `__fixtures__/cases.ts`
  - the diffs of `result.test.tsx`, `review.test.ts`, `update-variants.test.ts`, `generate.test.tsx`, `openapi.test.ts`, `slots-accounts.test.ts`, `api/endpoints/generate.test.ts`, `voice/voice.test.ts` and the validation tests

**Sampled (assertions only):** `tests/integration/accounts-posting-instructions.test.ts`, `tests/integration/migrations/copy-platform-guidance.test.ts`, `voice/voice.test.tsx`.

**Not reviewed:**

- `drizzle/meta/000{8,9}_snapshot.json` (generated) and `__snapshots__/prompt.test.ts.snap`.
- The `prompt.test.ts`, `schema.test.ts` and `core*.test.ts` diffs. I ran these suites instead of reading them.
- `accounts-ui.test.ts`, `actions-authz.test.ts`, `no-secrets.test.ts`, `voice/try-it.test.ts`: small fixture updates, not read line by line.

**Ran (targeted):**

- `pnpm vitest run` on `groups.test.ts`, `prompt.golden.test.ts`, `prompt.test.ts` and `schema.test.ts`: **4 files, 52 tests passed**. The golden fixture `pre-011-prompts.json` is unchanged from commit `efbc225`, so FR-009 is proved byte for byte.
- A one-off esbuild probe outside the repo, run against `failFromError(assertGroupLimit(17 groups))`. It confirmed F2 (output quoted there).

## Verdict

**Not ready to merge: three MAJOR findings, all small to fix.** On the server the feature is sound and hangs together:

- one grouping module;
- one `assertGroupLimit`, called before every model call in single, series plan/start/post, regenerate, Try it, job creation and the runner;
- group keys threaded consistently from schema, prompt and checks through to save, the record, `variantGroupsForPost`, Review and the API;
- job snapshots read on every tick;
- an idempotent migration;
- per-platform guidance removed from voice input and from the prompt.

Two defects sit at the seams between passes, and both break the case this feature adds: a platform split into several variants.

- **F1, editing:** the variant editor on the result screen and in Review cannot edit a split platform's text. One line was left keyed by platform when the rest of the component moved to group keys.
- **F2, the refusal message:** the group-limit refusal from server actions reaches the person as the generic "Some posts have validation problems." The service raises `ValidationIssuesError`, but the forms read `message` or `fieldErrors`. The number of groups and the maximum are lost on Generate, regenerate and Try it.
- **F3, tests:** FR-028's "group-limit refusal on every caller" has no Try it case, and one "no post created" assertion is vacuous.

Fix these three, commit the work in logical conventional commits, and finish T047 (lint, full test, build). I expect the next review to pass.

## Findings

- [ ] MAJOR F1 — The variant editor ignores edits to any group whose key is not the platform key (`bluesky_1`, `bluesky_2`, …), so split-platform texts cannot be edited on the result screen or in Review.
      where:  src/app/p/[projectSlug]/generate/result/[postId]/VariantEditor.tsx:32, VariantEditor.tsx:27, VariantEditor.tsx:52, VariantEditor.tsx:112, src/app/p/[projectSlug]/review/ReviewList.tsx:158
      why:    `texts` is now keyed by `c.key` (lines 27 and 52), but `live` still reads `texts[c.providerKey] ?? c.text` (line 32). For a split group, `texts["bluesky"]` is undefined, so the controlled `<textarea value={c.text}>` (line 112) always shows the original text and drops each keystroke. **Save** and **Save and approve** send the unedited text. Platforms with one group still work, because there `key === providerKey`. Review passes the same cards to the same component, so it is broken too. The server path (`updatePostVariants` and `approvePost` with `accountIds`) is tested and correct. The client is not exercised by any test: `result.test.tsx` only renders static HTML.
      owed:   Read `texts[c.key]` in `live`. Move the card → live-text mapping into a pure helper in `variant-logic.ts`, and unit-test it: editing `bluesky_2` changes only that card's text and its `{ accountIds, text }` edit.
      traces: FR-011, US2 scenario 7, SC-002

- [ ] MAJOR F2 — A group-limit refusal raised through a server action shows "Some posts have validation problems." instead of the required message, on Generate (single and series), regenerate and Try it.
      where:  src/server/services/generation/groups.ts:16, src/lib/action-result.ts:81, src/lib/action-result.ts:86, src/app/p/[projectSlug]/generate/GenerateForm.tsx:132, GenerateForm.tsx:156, src/app/p/[projectSlug]/generate/result/[postId]/RegenerateDialog.tsx:23, src/app/p/[projectSlug]/voice/TryItPanel.tsx:56
      why:    `assertGroupLimit` throws `ValidationIssuesError`. `failFromError` keeps the message only for `conflict`, `last_owner` and `PolicyNotAllowedError`, so `message` becomes the generic "Some posts have validation problems." The real text survives only in `issues`. Probe output: `{"ok":false,"error":"validation","message":"Some posts have validation problems.","issues":[{"code":"too_many_groups","field":"targetAccountIds","message":"These accounts need 17 different versions of the post; one generation can write at most 16. …"}]}`.
              - `GenerateForm`, `RegenerateDialog` and `TryItPanel` render `result.message` and ignore `issues`. `fieldErrors.targetAccountIds` is never set, because `fieldErrors` is only filled for Zod errors. So T028's "server error shown next to picker" leg does not work.
              - Only `JobForm.tsx:100` flattens `issues`, so job creation shows the right text.
              - **Regenerate has no live notice.** A post whose accounts' instructions have since diverged past 16 groups is refused with a misleading message that does not name the count, the maximum or the fix.
              - On Generate, a stale page (instructions changed after load) shows the generic error.
      owed:   Make the `too_many_groups` message reach the person on every UI caller: next to the account picker on Generate (via `fieldErrors.targetAccountIds` or by rendering `issues`), and as the dialog or panel error for regenerate and Try it. One option is mapping `ValidationIssuesError` issues that carry a `field` into `fieldErrors` and the message in `failFromError`. If that is the route, check that the other `ValidationIssuesError` throwers' messages are written for users. Add an action-level test, e.g. `regenerateAction` or `generateSingleAction` over the limit returns the message naming 17 and 16.
      traces: FR-012, FR-013, US3 scenario 1

- [ ] MAJOR F3 — The group-limit tests miss the Try it caller and contain a vacuous "no post created" assertion, so FR-028 / SC-004 are only partly proved even though T029 is ticked.
      where:  tests/integration/generation/group-limit.test.ts:45, tests/integration/generation/group-limit.test.ts:52, tests/integration/generation/group-limit.test.ts:120, tests/integration/generation/try-it-accounts.test.ts:31
      why:    T029 lists Try it among the callers to refuse 17 groups with zero model calls. Neither `group-limit.test.ts` nor `try-it-accounts.test.ts` has that case. `voice.ts:286` does call `assertGroupLimit`, but per constitution II that behaviour has not run.
              - Line 52 asserts `findByRequestId(randomUUID())` is falsy. That is a fresh random id, so it can never fail; it does not check the request that was refused.
              - No case counts generation failure rows.
              - The `/generate` case (line 120) asserts neither "no post" nor "no failure row" (US3 scenario 4).
      owed:   Add a Try it case: 17 groups via `accountIds` → `ValidationIssuesError` naming 17 and 16, and `llm.requests.length === 0`. In the single case, use the refused request's own `requestId`. Assert no generation-failure row for single and `/generate`, and no post for `/generate`.
      traces: FR-028, FR-012, SC-004, US3 scenario 4

- [ ] MINOR F4 — The result screen labels remaining problems with the bare group key (`mock_2: …`), not the group label the record stores and the API uses (`mock_2 (Mock (offline): Acme News): …`).
      where:  src/app/p/[projectSlug]/generate/result/[postId]/page.tsx:56, src/server/api/operations/generate.ts:91
      why:    The cards are headed "Bluesky: Acme News", so `bluesky_2: …` names a key the person never sees. The retry prompt and the API are correct.
      owed:   Use `p.label ?? p.groupKey ?? p.providerKey`, as the API does.
      traces: FR-010

- [ ] MINOR F5 — Try it's default account selection exists twice, once in the service and once in the panel.
      where:  src/server/services/voice.ts:276, src/app/p/[projectSlug]/voice/TryItPanel.tsx:13
      why:    Both loop over accounts and add each one while `groupTargets(...)` stays at or under `GROUP_LIMIT`. The UI always sends `accountIds`, so today they agree, but this is duplicated logic across two passes (constitution IV) that can drift.
      owed:   Export one `defaultTryItSelection` from `src/lib/generation/groups.ts` and use it in both places.
      traces: FR-020, constitution IV

- [ ] MINOR F6 — The job tests do not cover the deferred correction retry or manually retried items running under the snapshot, and the job page's snapshot list is not rendered in any test. T038 claims both.
      where:  tests/integration/jobs/posting-instructions.test.ts:71, src/app/p/[projectSlug]/jobs/[jobId]/page.tsx:110
      why:    The behaviour holds by construction: `processClaimedItem` reads the snapshot on every claim (`runner.ts:259`). But FR-016 names retried items explicitly, and only API-appended items are exercised.
      owed:   Add a deferred-retry item and a `retryItem` case asserting the prompt contains the snapshot text after an edit. Add a render assertion for "Posting instructions (as of job creation)" and "Not recorded".
      traces: FR-016, US5 scenarios 2 and 5

- [ ] MINOR F7 — `docs/generator.md` says "The forms show a live group count". They show the group-limit message only once the selection is over 16.
      where:  docs/generator.md:43
      owed:   Reword: "The forms warn as soon as the selection needs more than 16 groups."
      traces: FR-026

- NOTE F8 — The implementation (T003–T046) is entirely uncommitted. The constitution's workflow asks for a commit per task or small group of tasks, with explicit paths. The next implement pass should commit the existing tree in logical `feat`/`test`/`docs` commits before or alongside the remediation. Otherwise it can be lost or mixed into one commit.
- NOTE F9 — T047 is still open. `pnpm lint`, the full `pnpm test` and `pnpm build` have not run on this code; the host load average was about 130–165 during this review. No CI run exists because nothing is pushed. Until T047 completes, the integration suites I did not run are claims, not results: accounts, migration, jobs, review, API and voice.
- NOTE F10 — The 16-group limit rests on the UNVERIFIED research item R1. It is kept in one constant (`src/lib/generation/groups.ts:4`) and logged in `docs/decisions.md` § 011, which complies with constitution I. Model compliance with the instructions stays "verified with fakes only".

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-028) | 28 | 25 | 3 (FR-011 F1, FR-012 F2, FR-028 F3) | 0 | 0 |
| Success criteria (SC-001–SC-008) | 8 | 7 | 1 (SC-004 F3) | 0 | 0 |
| Acceptance scenarios (US1–US7) | 39 | 37 | 2 (US2-7 F1, US3-1 F2) | 0 | 0 |
| Spec edge cases | 13 | 13 | 0 | 0 | 0 |
| Constitution principles I–VII | 7 | 7 | 0 | 0 | 0 |
| Constitution workflow (commits, quality gates) | 2 | 0 | 2 (F8, F9; T047 open) | 0 | 0 |

**SC-001 is counted as satisfied on design only.** The form is next to the slots and is a single field, but timing cannot be measured headlessly.

The constitution's review sweep categories were each checked against the diff:

- **Concurrency and locking:** `setPostingInstructions` locks only the account row with `getForUpdate`, compatible with `removeAccount`'s order. Concurrent saves serialise, and each audits the true previous text.
- **Idempotency:** `generateSingle` checks `requestId` before the limit, so a replay returns the saved post. The `/generate` 400 replay is the logged plan reading (b).
- **Authorization and scoping:** `account:["manage"]` is checked outside and inside the transaction. The DAL write uses `mine(id)` with `removed_at IS NULL`. Variant and approve edits apply only to this post's targets, so foreign `accountIds` are ignored.
- **Time zones / DST:** not touched by this feature.
- **Error and timeout paths:** an over-limit pre-feature job fails the item with `bad_request` and no call. F2 above.
- **Secrets:** the audit details keys are `accountId`, `displayName`, `previous` and `next`. No credentials are involved.

## What I could not check

- **Browser behaviour of the client components.** The repo has no jsdom or testing-library, and this phase has no browser. F1 is established by reading `VariantEditor.tsx` (the controlled value comes from a lookup that misses), not by typing into it.
- **The full quality gates (T047).** `pnpm lint`, the full `pnpm test`, `pnpm build` and Docker build, and a CI run on a pushed branch. Per the constitution these are implement's final pass and CI, not review. They have not happened yet.
- **The integration suites I did not execute.** Their assertions were read but not run here, on a heavily loaded host:
  - `accounts-posting-instructions`
  - `migrations/copy-platform-guidance`
  - `jobs/posting-instructions`
  - `generation/{posting-instructions,group-limit,try-it-accounts}`
  - review, API endpoints and OpenAPI
  - voice
- **Real-model behaviour.** Whether Anthropic or OpenAI accept 16 required variant properties (R1), and whether the model follows the per-key instructions. Both are verified with fakes only.
- **The migration on a real upgraded database.** That covers Neon direct URL, `ALTER TYPE … ADD VALUE` inside the migrator's transaction, and real voice content. Only the throwaway-DB test exists, and I did not run it.
