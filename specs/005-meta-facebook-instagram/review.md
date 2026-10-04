# Review: Facebook Pages and Instagram providers (Meta, part 1)

Reviewed 110 file(s) changed across 13 commit(s), against `7c15677` (merge-base with `origin/main`)...HEAD **plus the uncommitted working tree** (14 files the last implement pass left staged/modified — see NOTE F6). Evidence is the diff, not just the present state.

Read in full: `src/providers/types.ts`, `src/providers/registry.ts`, `src/providers/meta/{config,graph,errors,oauth,candidates,credentials,connect-group}.ts`, `src/providers/facebook/{index,capabilities,settings,steps,links,publish,validate}.ts`, `src/providers/instagram/{index,capabilities,settings,state,steps,quota,publish,validate}.ts`, `src/server/services/connect.ts`, `src/server/dal/connect-attempts.ts`, `src/server/db/schema/connect.ts`, `drizzle/0003_empty_roxanne_simpson.sql`, `src/server/provider-env.ts`, the diffs of `src/server/scheduler/publishing.ts` (plus the whole `execute` function), `src/server/dal/{accounts,scope}.ts`, `src/server/services/accounts.ts`, `src/server/startup/index.ts`, `src/server/db/project-owned.ts`, `src/app/connect/callback/route.ts`, `src/app/connect/invalid/page.tsx`, `src/app/p/[projectSlug]/accounts/{actions.ts,page.tsx (diff),ConnectGroupSection.tsx,ReconnectGroupButton.tsx}`, `src/app/p/[projectSlug]/accounts/connect/[attemptId]/{page.tsx,ChooserForm.tsx}`, `docs/decisions.md` (005 section), `README.md` (diff), `.env.example` (diff).
Sampled: `src/providers/validation.ts`, `src/providers/media.ts` (planner adaptation), `src/server/services/posts/validate.ts`, `docs/meta-setup.md` and `docs/adding-a-provider.md` (headings and the U1/U2/Threads/G7 passages), `tests/integration/connect/state-security.test.ts`, `tests/integration/instagram/outcomes.test.ts`, `tests/integration/meta/engine-unchanged.test.ts`, `tests/helpers/connect-group.ts`, `research.md` (R7–R10).
Not reviewed line by line: the remaining ~40 test files (run, not read), `drizzle/meta/0003_snapshot.json` (generated), `tests/helpers/fake-graph.ts` beyond its use.

Gates run in this phase: `pnpm typecheck` passed; `pnpm lint` passed (0 errors, 2 warnings in test files); `pnpm vitest run` over `src/providers`, `src/server/startup`, `tests/helpers` and `tests/integration/{connect,facebook,instagram,meta}`, plus the credentials-invalid, accounts-ui, compose-check-route, no-plaintext, actions-authz and scope-check tests: **53 files, 510 tests passed**. I did not run the full `pnpm test`, `pnpm build` or `pnpm db:check`.

## Verdict

The feature mostly does what the spec asks and the parts fit together. The shared Meta module is used by both providers, and there is one Graph client and one error table. G5–G8 are generic and were proven with a throwaway provider. The callback security order (shape → lookup → binding → role → conditional consume → exchange) matches research D5. The Instagram step machine is pure and total, and never sleeps. The may-publish/ambiguous rules hold in the code and in the outcome matrices. Two cross-pass defects block the merge, and both are small to fix:

- **F1.** The Meta connect group and the generic callback disagree on how "no Pages" is signalled. A person who deselects every Page in the login dialog (a spec edge case) is told to check the app id and secret instead of which permissions are needed.
- **F2.** A generic accounts-screen component hard-codes Meta's five permission names, which FR-002 forbids. The FR-002 source-scan test does not cover that directory, so it missed this.

Fix both through the two remediation tasks, then review again. The working tree also has to be committed before merge (NOTE F6).

## Findings

- [x] MAJOR F1 — An OAuth login that yields no Pages shows the "check app id/secret/redirect" banner, not the needed permissions
      where:  src/providers/meta/candidates.ts:73, src/providers/meta/connect-group.ts:13-14, src/server/services/connect.ts:314-315, src/app/p/[projectSlug]/accounts/page.tsx:29-36, tests/helpers/connect-group.ts:16
      why:    The two sides were built in different passes and disagree. `handleOAuthCallback` treats `{ ok: false }` as `exchange_failed`, and only `{ ok: true, candidates: [] }` as `no_candidates`; the throwaway test group returns the second form. The Meta group returns `{ ok: false, message: NO_PAGES }` when the listing is empty, so a real Meta login with zero Pages (the person deselected all Pages in the dialog, or the token lacks `pages_show_list`) lands on `?connect=exchange_failed`. The banner then reads "Could not finish signing in. Check the app id, secret and redirect address", which sends the owner to the wrong fix. The spec edge case says "If no Pages come back, the chooser says so and lists the needed permissions", and contracts/connect.md maps `no_candidates` to the group's permissions message. The paste path happens to work, because it shows `result.message` directly (`paste.test.ts:83`). Nothing tests the OAuth path with the real Meta group and an empty `/me/accounts`.
      owed:   Make one side match the other. Either `listPageCandidates` returns `{ ok: true, candidates: [] }` when no Page is listed (paste then shows its own no-accounts message at connect.ts:352), or the callback passes the group's refusal through to a `no_candidates` banner that names the permissions. Add a `meta-connect` (or `state-security`) case: real Meta group, fake-graph `/me/accounts` → `{ data: [] }` → `?connect=no_candidates` with a message listing the permissions.
      traces: Edge case "Person deselects Pages or permissions", US2 AS4, FR-009, contracts/connect.md messages table

- [x] MAJOR F2 — The generic connect UI hard-codes Meta's permission names, and the FR-002 guard test does not scan that code
      where:  src/app/p/[projectSlug]/accounts/ConnectGroupSection.tsx:83, tests/integration/meta/engine-unchanged.test.ts:63
      why:    `ConnectGroupSection` is the generic per-group component that every OAuth group renders through, but its paste hint appends the literal "Needed permissions: pages_show_list, pages_manage_posts, pages_read_engagement, instagram_basic, instagram_content_publish." This is Meta-specific code in a route/UI file, which FR-002 says MUST NOT exist, and it breaks SC-008. The next entry (meta-threads) adds another group, which would show Facebook's permission list under Threads. The test written to catch this only scans `src/server/{scheduler,services,db/schema}` and `src/app/p/[projectSlug]/posts`, not `src/app/p/[projectSlug]/accounts/**` or `src/app/connect/**`. It also matches only quoted provider keys, so it would not catch permission strings anyway.
      owed:   Move the permission text into `metaConnectGroup.pasteToken.help` (src/providers/meta/connect-group.ts:46), and have the component render `paste.help` only. Extend the scan roots to include `src/app/p/[projectSlug]/accounts` and `src/app/connect`, and add `pages_`/`instagram_` permission tokens to the forbidden pattern.
      traces: FR-002, SC-008, Constitution V

- [ ] MINOR F3 — Facebook attempt summaries leave out the step detail that FR-033 requires, and are inconsistent with Instagram's
      where:  src/providers/facebook/publish.ts:67, src/providers/facebook/publish.ts:75, src/providers/instagram/publish.ts:21-32
      why:    Instagram's `summarize` records the step, media type, image index, container id and status. Facebook records only `graphSummary` (HTTP status and Graph code, subcode, type and trace id). An `upload_photo_N` attempt therefore keeps neither the image index nor the returned photo id, and the final `attached_media` post does not record which photo ids it attached. This is safe to ship, but it leaves FR-033 partial for Facebook and makes a U1 failure harder to diagnose after the fact.
      owed:   Add `request: { step, imageIndex? }` and `response: { photoId? / photoIds? }` to the Facebook summaries.
      traces: FR-033

- [ ] MINOR F4 — Candidates are not validated or de-duplicated as contracts/providers.md specifies
      where:  src/server/services/connect.ts:157-158, src/server/services/connect.ts:219-237
      why:    The contract says the framework drops and `console.warn`s (key only) any candidate with a foreign provider key, invalid settings, or a duplicate `(providerKey, externalId)`. The code drops only foreign keys. A candidate with invalid settings makes `settingsSchema.parse` throw inside the chooser transaction, so the whole choice fails with a 500 instead of just that candidate being skipped. A duplicate is upserted twice. The Meta group never produces either today, so this is latent.
      owed:   Filter candidates once, at store time (`encryptCandidates`) or read time: drop invalid settings and duplicates, and warn with the key only.
      traces: contracts/providers.md G5 rules

- [ ] MINOR F5 — decisions.md says expired attempts are purged on callback traffic, but the callback never purges
      where:  docs/decisions.md:263, src/server/services/connect.ts:262-320 (purge is called only at connect.ts:98 and connect.ts:344)
      why:    The D9 entry lists "start, paste and callback" as purge points. `handleOAuthCallback` does not call `purgeExpiredConnectAttempts`. Expired rows are still unreadable straight away (`bound` requires `expires_at > now`), so this is a documentation inaccuracy about how long encrypted candidate rows persist (FR-010), not a leak path.
      owed:   Either call the purge in the callback or correct the decisions entry.
      traces: FR-010, FR-040

- NOTE F6 — The last implement pass's work is uncommitted. `git status` shows `src/providers/instagram/validate.ts` (T062), `src/providers/{facebook,instagram}/validate.test.ts`, `docs/meta-setup.md`, `README.md`, `docs/adding-a-provider.md`, `docs/decisions.md`, `tests/integration/meta/{no-secrets,engine-unchanged}.test.ts`, `tests/integration/connect/meta-connect.test.ts` and four extended tests as staged or modified but not committed. A PR cut from `HEAD` alone would have no Instagram validation rules (US9), no setup doc (FR-036/037) and no no-secrets test (FR-034). This review judged the working tree. The remediation pass must commit these files with its own changes.

- NOTE F7 — `check_quota` deliberately goes ahead on any non-190 failure, rate limits included (src/providers/instagram/publish.ts:160-171, asserted at tests/integration/instagram/outcomes.test.ts:74-78). This follows FR-029/US5 AS3 ("an unreadable quota MUST NOT block") rather than the general US6 AS4 rule. It is safe, because a rate-limited `media_publish` is itself `retryable_error` (src/providers/meta/errors.ts:99). It is recorded here so the departure from the US6 table is visible.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-040) | 40 | 37 | 3 (FR-002 F2, FR-033 F3, FR-010 F5 doc only) | 0 | 0 |
| Success criteria needing buildable work | 10 | 6 (SC-002–SC-007) | 2 (SC-008 F2; SC-010 — typecheck/lint/feature tests run here, full suite/build not re-run) | 0 | 0 (SC-001, SC-009 not checkable — live) |
| User stories (acceptance scenarios) | 10 (US1–US10) | 9 | 1 (edge case under US1/US2 — F1) | 0 | 0 |
| Constitution principles | 7 | 6 | 1 (V — F2) | 0 | 0 |
| Plan touch-points (framework gaps G5–G8, one migration, registry lines) | 6 | 6 | 0 | 0 | 0 |

How the major obligations were checked:
- **Callback order (FR-007/008, SC-002):** connect.ts:266-283 against research D5. Every refusal comes before `consumeState` and before `exchangeCode`. Single use is enforced by a conditional `UPDATE … WHERE callback_at IS NULL AND expires_at > now` (connect-attempts.ts:85-91).
- **G7 (FR-017):** publishing.ts:352-392. The error becomes "Reconnect … to publish", and `markCredentialsInvalid` runs only while the ciphertext is unchanged (accounts.ts:248-262). The result is `fatal_error`, never `ambiguous`.
- **Ambiguity (FR-030/US6):** errors.ts:61-104. On `mayPublish` steps, after-send network errors, unparseable replies, 5xx and temporary codes are ambiguous, and rate limits are retryable. A 2xx with no id is ambiguous in both providers (facebook/publish.ts:83-85, instagram/publish.ts:194-200).
- **Instagram machine (FR-026/028):** state.ts:3-7 and publish.ts:118-153. Checks back off from 10 s, doubling, to at most 5 min. The 60-minute cap runs from `createdAt`. `EXPIRED` recreates at most twice, and `PUBLISHED` is ambiguous. The only recreation after the create step is the 23 h guard in `check_quota`, which runs before any publish request.
- **Variants (US4 AS9):** the engine resolves media via `resolvePublishMedia` with Instagram's capabilities (JPEG only, `maxWidth` 1440, 8 MB), using the 003 planner (media.ts:111-147).
- **Secrets (FR-034):** tokens go in POST bodies, GET tokens are scrubbed from every message (errors.ts:24-33), and the pasted and user tokens are never persisted (connect.ts:331-373). This is backed by the passing no-secrets test.

## What I could not check

- **Anything live against Meta:** the real login dialog and `config_id` vs `scope` (R4), the code and long-lived exchanges, the real `/me/accounts` shape, multi-photo `attached_media` (U1), a `localhost` redirect (U2), the real Graph error codes (R3) and `content_publishing_limit` fields (R5). All of this is mocked. T075 (owner, quickstart §8) remains open, as intended.
- **SC-001 and SC-009** (a 2-minute connect; a new deployer completing `docs/meta-setup.md` without help). Both need a human and a real Meta app.
- **The browser flow:** the redirect from a Server Action to an external URL in the running Next 16 app, client-side focus and announcement behaviour on the chooser, and the clipboard in `CopyField`. These were checked only through Vitest-rendered components, not a browser.
- **The full gate set** (`pnpm test` across the whole repo, `pnpm build`, `pnpm db:check`). The implement pass recorded these as passing in docs/decisions.md. I re-ran only typecheck, lint and the 53 feature-related test files.
- **Load and concurrency beyond the tests:** behaviour with 500 Pages and a ~1 MB candidate ciphertext, and purge behaviour on a large `connect_attempts` table.
