# Review: Threads provider (Meta, part 2)

Reviewed 86 file(s) changed across 22 commit(s), against 4285587 (merge-base with origin/main)...HEAD.

- **Read in full:**
  - every non-test file under `src/providers/threads/`;
  - `src/providers/{types,text,validation,registry,connect}.ts` and the `src/providers/meta/` diff;
  - the whole `src/server/**` and `src/app/**` diff (connect service, accounts service, compose, refresh helper, token-refresh, DAL, callback route, accounts page, `ConnectGroupSection`);
  - `tests/integration/threads/{outcomes,container-status,limits,paste,scope}.test.ts`, the Threads section of `tests/integration/meta/no-secrets.test.ts`, and the setup and assertions of `tests/integration/threads/refresh.test.ts`.
- **Sampled:**
  - `src/providers/threads/{validate,text}.test.ts`, checked against the boundary cases spec US5 asks for;
  - `docs/meta-setup.md` (headings and anchor), the `docs/decisions.md` 006 block, the README "Connecting Threads" section;
  - `.env.example`, `package.json`, `.gitignore`.
- **Not read line by line:** `tests/integration/threads/{connect,carousel,publish-e2e}.test.ts`, `tests/integration/connect/{redirect-requirement,callback-hint}.test.ts`, `tests/integration/compose/*`, `tests/integration/accounts-notes.test.ts`, `tests/integration/scheduler/token-refresh-hold.test.ts`, `docs/adding-a-provider.md`, the body text of `docs/meta-setup.md`, and the spec-dir design docs. These files are covered only in the sense that their tests ran and passed (see below).
- **What I ran:**
  - `pnpm typecheck`: pass.
  - `pnpm lint`: pass (0 errors, 2 warnings, both in files older than this branch).
  - `pnpm vitest run` over the feature's suites: 626 passed, 1 failed.
  - `pnpm test` (full): 1581 passed, **1 failed**, 1 skipped.
  - `pnpm build` and `pnpm db:check`: not run.

## Verdict

The feature substantially does what the spec asks, and the passes fit together well.

- **Provider shape:** Threads is one folder plus one registry line. It reuses the shared Meta Graph client, error table and scrubber rather than copying them. The five generic fixes (G9–G13) are provider-neutral, each is wired end to end, and each is recorded with a reversal in `docs/decisions.md`.
- **Publishing:** the step machine is pure and total. `publish` is the only `mayPublish` step. Recreation happens only before a publish request, and every uncertain outcome on publish is `ambiguous`. This matches the outcome tables in US2 and US3, and the matrix test checks it step by step.
- **Interfaces across passes:** I found no interface drift between passes. The G9 count is computed on the server, and the compose check carries only the rule's name. The G10 check sits in the single start path and in the list view. The G11 parking goes through the one refresh helper.

It is **not ready to merge**, for two reasons:

1. **The full test suite is red** (F1). A new Threads refresh test runs the global token-refresh section at a far-future clock and then asserts global counts. It therefore sweeps, and miscounts, every account other test files left behind. This breaks the constitution's quality gate (CI must be green) and contradicts the ticked T050 and SC-010.
2. **The paste fallback's chooser never says the expiry is estimated** (F2), which US7 scenario 3 requires.

Both fixes are small.

## Findings

- [x] 🛑 BLOCKER F1 — The full `pnpm test` run fails: `tests/integration/threads/refresh.test.ts` asserts global refresh counts at a 2030 clock.
      where:  tests/integration/threads/refresh.test.ts:33, tests/integration/threads/refresh.test.ts:29, tests/integration/threads/refresh.test.ts:84 (same pattern at :99, :120, :123, :131, :139, :146, :156, :157)
      why:    `T0` is 2030-01-01 and `refreshMaxAccounts` is 1000, so `runTokenRefresh` claims every account in the shared test database whose expiry is before 2030. That includes Threads accounts that other files (connect, paste, no-secrets, publish) created with real-time 60-day expiries. Those accounts are "expired" at T0, so they become `needs_reauth` and count as `failed`. Case (a) then receives `{ refreshed: 1, failed: 12 }` instead of `failed: 0`. Run alone, the file passes (8/8, twice). Run in the full suite, it failed in both of my runs (the feature subset and the full `pnpm test`). The test also flips other files' accounts to `needs_reauth`, which can break concurrently running tests. The constitution's Development Workflow says "CI must be green before merge: … `pnpm test`". T050 is ticked as passing.
      owed:   Make each case assert only its own account: the row's status, ciphertext, `last_refreshed_at` and `refresh_lease_until`, plus the refresh requests made with this account's token. Drop the global `counts` assertions, or filter them to this account. Move `T0` to the real current time so the section stops sweeping other files' accounts. Then run `pnpm test` (full) green.
      traces: SC-010, FR-034 (renewal), constitution Development Workflow (quality gates), T050

- [x] MAJOR F2 — A pasted token saved with an estimated expiry shows no "estimated" note in the chooser.
      where:  src/providers/threads/connect-group.ts:69, src/providers/threads/connect-group.ts:20
      why:    US7 scenario 3: "the chooser and the account say the expiry is estimated". The save-as-is branch builds its candidate through `candidateFor`, which never sets `notes`. As a result, `getConnectChoice` and `ChooserForm` (src/app/p/[projectSlug]/accounts/connect/[attemptId]/ChooserForm.tsx:44) show nothing. Only the account card says it, through G13 after saving. `tests/integration/threads/paste.test.ts:80` checks the account note but not the chooser, so the gap went unnoticed.
      owed:   Give the estimated-expiry candidate a note (for example "Expiry estimated: Docket could not confirm when this token expires and assumes 60 days."). Then extend paste case (c) to assert that note in `getConnectChoice`'s candidates.
      traces: FR-015, US7 scenario 3

- [ ] MINOR F3 — A rate limit never uses a platform not-before time, and the test named for it cannot fail.
      where:  src/providers/meta/errors.ts:99, tests/integration/threads/outcomes.test.ts:125
      why:    US3 scenario 4 says a rate limit is retried "with the platform's not-before time when given, and the engine's backoff otherwise". `graphStepError` never reads a not-before (rate limits go through `retry(msg)` with no `notBefore`). The test "a rate limit carries the platform's not-before when it gives one" stubs no such value and only checks `nextAttemptAt > T0`, which engine backoff alone satisfies. R4 gives no interim not-before field, so for Threads the behaviour is probably right today. But the test's name claims coverage that does not exist.
      owed:   Either rename the test to what it proves (engine backoff on a rate limit) and add a sentence to decisions.md that no platform not-before is read (R4), or read one where the Graph reply provides it and test that value.
      traces: US3 scenario 4, FR-028

- [ ] MINOR F4 — Threads OAuth reclassifies Graph errors with its own copy of the rate-limit and temporary codes, and refresh detects an empty reply by matching a string literal.
      where:  src/providers/threads/oauth.ts:31, src/providers/meta/errors.ts:7, src/providers/threads/refresh.ts:7, src/providers/threads/refresh.ts:42, src/providers/threads/oauth.ts:77
      why:    `[4, 17, 32, 613]` and codes 1/2 are copied from `GRAPH_ERROR_TABLE` instead of going through `classifyGraphError`. If the shared table changes (it is marked R3/R4 interim), Threads connect and renewal will classify differently from publishing. `refreshThreads` recognises "unreadable success" by comparing `reason` to the literal `"Threads returned no token"`, which is defined separately in oauth.ts. Rewording either copy silently turns a transient result into `needs_reauth`. Both work today.
      owed:   Classify through `classifyGraphError`. Have `readLongLived` return a typed `{ ok: false, transient: true, kind: "no_token" }` (or export the constant) instead of matching on the message text.
      traces: FR-001 (reuse the shared module), FR-018

- NOTE F5 — `check_quota` continues on a rate limit, 5xx, network failure or rejection, and stops only on a 190 (src/providers/threads/publish.ts:167–176). This settles a real tension in the spec: US3 scenarios 4 and 6 say "any step" retries, while US6 scenario 3 says an unreadable quota never blocks. The code sides with US6, which is reasonable, because the following `publish` turns a rate limit into a retryable result anyway. The outcome matrix (tests/integration/threads/outcomes.test.ts:91) encodes this behaviour on purpose. It is recorded under R7 in decisions.md, but only as "unknown never blocks", not as an exception to US3.

- NOTE F6 — The token, and for `th_exchange_token` the app secret, travel in GET query strings (src/providers/threads/oauth.ts:88–94, :104–110). FR-033 asks for request bodies "wherever the platform allows". This is recorded as a limitation (D10) and the URL is never surfaced, so it is not a defect. It is still worth checking during the owner's live survey (T053) whether POST is accepted.

- NOTE F7 — The G11 parking (src/server/scheduler/credentials.ts:47–54) holds the refresh lease for up to 24 h. For any future provider that both returns a transient `retryAt` from refresh and defines `needsRefresh`, publish-time refresh would see `busy` (src/server/scheduler/publishing.ts:307) and keep releasing targets until the hold ends. No current provider does both (Threads has no `needsRefresh`, and Bluesky's refresh never sets `retryAt`), so nothing misbehaves today. `docs/adding-a-provider.md` should probably say so.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-040) | 40 | 40 | 0 | 0 | 0 |
| Acceptance scenarios (US1–US8) | 57 | 55 | 2 (US7#3 → F2; US3#4 platform not-before → F3) | 0 | 0 |
| Success criteria | 10 | 7 | 1 (SC-010 → F1) | 0 | 0 |
| Constitution principles (I–VII, Eng. constraints, Workflow) | 9 | 8 | 0 | 0 | 1 (Workflow quality gate → F1) |
| Plan gaps G9–G13 wired end to end | 5 | 5 | 0 | 0 | 0 |

- **Success criteria:** SC-001 and SC-002 (timings for a live connect and a live HTTPS walk) cannot be checked here, so they are counted in neither the satisfied nor the partial column.
- **Functional requirements:** FR-033 counts as satisfied with the recorded D10 limitation (F6). The FR-035, FR-036 and FR-038 docs were checked for headings, the anchor and the env vars, not proofread.

What I specifically confirmed in code:

- the G10 check runs before purge or state creation in the single start path (src/server/services/connect.ts:108), and paste is not gated by it;
- the G12 hint is looked up from the registry, never reflected from the query string (src/app/p/[projectSlug]/accounts/page.tsx:52–57);
- G13 notes never receive credentials (src/server/services/accounts.ts:64–79);
- the compose check carries the rule name, not a function (src/server/services/posts/compose.ts:79);
- the Meta-module changes keep Facebook and Instagram URLs byte-identical (src/providers/meta/graph.ts:116);
- `publish` is the only `mayPublish` step (src/providers/threads/steps.ts:35);
- an `ambiguous` target is never reclaimed (tests/integration/threads/outcomes.test.ts:100–107);
- the 300-target run stops at 250 (tests/integration/threads/limits.test.ts:60–70).

## What I could not check

- **Live Threads behaviour:** connect, `th_exchange_token`, `th_refresh_token`, container creation, status polling, quota read and `threads_publish` against the real API. Everything is verified with mocks only (R1–R10, U1 `.net` vs `.com`, U2 token generator). This is T053, owner-only.
- **Local HTTPS:** the walk itself (hosts file, mkcert, `pnpm dev:https` at `https://docket.local:3000`) and whether the Threads dashboard accepts the port-3000 redirect (R8). This is T052.
- **Browser behaviour of the accounts screen:** the unavailable-group state, the paste field clearing after submit, and keyboard and focus. Only server rendering and the server actions were exercised.
- **`pnpm build` and `pnpm db:check`:** I did not run them. Typecheck passed, and there is no schema file in the diff.
- **SC-001 and SC-002 timings,** which need a human and real credentials.
- **Docs prose:** `docs/meta-setup.md` and `docs/adding-a-provider.md` were not proofread against FR-035, FR-036 and FR-039 line by line; only the headings, anchor and env-var presence were checked (and `tests/integration/docs/threads-docs.test.ts` passes).
