---

description: "Task list for the Facebook Pages and Instagram providers (005)"
---

# Tasks: Facebook Pages and Instagram providers (Meta, part 1)

**Input**: Design documents from `/specs/005-meta-facebook-instagram/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (providers, connect, meta, facebook, instagram, scheduler), quickstart.md

**Tests**: Requested by the spec (FR-035). Every test is Vitest against real Postgres (001–004 harness) with `globalThis.fetch` stubbed through `tests/helpers/fake-graph.ts`. There are **no live calls**. Every task below is executable headless (`pnpm vitest run`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm db:check`); nothing needs a browser or the network. UI behaviour is checked by rendering server components / calling actions in Vitest, not by a dev server.

**Organization**: Grouped by user story. Framework gaps G5–G8 are generic and sit in Foundational (types, schema, DAL, env, engine) and in US1/US2 (connect service, route, pages). Contracts are in `specs/005-meta-facebook-instagram/contracts/`; read the named contract before each task.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependencies on incomplete tasks)
- **[Story]**: US1–US10 (spec.md)
- Commands: `pnpm vitest run <path>`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm db:generate`, `pnpm db:check`
- Read `node_modules/next/dist/docs/` (route handlers, `redirect`, `refresh`) before writing route/action code (AGENTS.md).

## Phase 1: Setup

**Purpose**: confirm the baseline and create the folder skeleton

- [X] T001 Run `pnpm typecheck` and `pnpm vitest run src/providers tests/integration/scheduler` to record a green baseline; confirm no new dependency is needed (platform `fetch`, `node:crypto`, zod, drizzle already installed). Add no dependency
- [X] T002 [P] Create typed stub files (exporting their planned names per contracts/meta.md, facebook.md, instagram.md) under `src/providers/meta/` (`config.ts graph.ts errors.ts oauth.ts candidates.ts credentials.ts connect-group.ts`), `src/providers/facebook/` (`index.ts capabilities.ts settings.ts steps.ts links.ts publish.ts validate.ts`) and `src/providers/instagram/` (`index.ts capabilities.ts settings.ts state.ts steps.ts quota.ts publish.ts validate.ts`) so later tasks compile. Do NOT register the providers yet

---

## Phase 2: Foundational (framework fixes G5–G8 and test helper)

**Purpose**: generic type, schema, DAL, env and engine changes that MUST land, proven with a throwaway provider, before any Meta code depends on them

**⚠️ CRITICAL**: no user story work starts until this phase is complete

- [ ] T003 Update `src/providers/types.ts` per contracts/providers.md: G5 `OAuthConnectGroup`, `ConnectCandidate`, `CandidatesResult`, oauth strategy carrying its group; G6 `pasteToken`; G7 `fatal_error.credentialsInvalid`; G8 `ProviderEnvIssue` / group `environment`. Add `listConnectGroups` / `findConnectGroup` helpers in `src/providers/registry.ts`
- [ ] T004 Run `pnpm typecheck` and fix every compile error repo-wide caused by T003 (the `oauth` strategy shape changes; `src/app/p/[projectSlug]/accounts/page.tsx` filters on it). Behaviour must be unchanged
- [ ] T005 [P] Extend `src/providers/registry.test.ts` with the group invariants from contracts/providers.md (a group is referenced consistently by all its providers, unique group keys, `pasteToken` only on groups, env vars named by a group are documented in `.env.example`)
- [ ] T006 Add `src/server/db/schema/connect.ts` with the `connect_attempts` table per data-model §1 (project_id, user_id, session binding, state_hash unique, group key, candidates_encrypted, expires_at, consumed_at, completed_at), export it from `src/server/db/schema/index.ts`, and register `{ table: "connect_attempts", scopeColumn: "project_id" }` in `src/server/db/project-owned.ts`
- [ ] T007 Generate the migration with `pnpm db:generate` (creates `drizzle/0003_*.sql`, snapshot and journal; do not hand-write SQL), then run `pnpm db:check` and confirm no drift
- [ ] T008 [P] Create `src/server/dal/connect-attempts.ts` (project-pinned repo methods per contracts/connect.md plus the two explicit `crossProject` statements: state-hash lookup and expired-attempt purge, each with a reason, mirroring invitation tokens) and add `scope.connectAttempts` in `src/server/dal/scope.ts`
- [ ] T009 [P] Write `tests/integration/connect/attempts-dal.test.ts` (project pinning, conditional single-use consume returning one winner under two parallel connections, expiry, purge) and extend the existing scope-check test (`tests/integration/scope-check.test.ts`) so `connect_attempts` is covered and a query without a project scope fails
- [ ] T010 [P] Create `src/server/provider-env.ts` (`providerEnvIssues`, `isGroupConfigured`, G8) and merge its issues into the startup error in `src/server/startup/index.ts`; extend `src/server/startup/startup.test.ts` with the merge (core issue + group issue reported together, values never printed)
- [ ] T011 Add `AccountsRepo.markCredentialsInvalid` in `src/server/dal/accounts.ts` (one conditional `UPDATE` filtered on `project_id` and on the credentials ciphertext the step used; no transaction held; sets `status = needs_reauth` and a secret-free `last_error`) per contracts/scheduler.md
- [ ] T012 Implement G7 in `src/server/scheduler/publishing.ts`: on `fatal_error` with `credentialsInvalid`, call `markCredentialsInvalid`, fail the target with `Reconnect <name> to publish: <reason>`, no refresh, no retry, never `ambiguous`; providers that do not set the flag are unaffected
- [ ] T013 Write `tests/integration/scheduler/credentials-invalid.test.ts` with a throwaway provider (no Meta code): flag sets account `needs_reauth` with the message, no retry, other due targets for the account are not claimed, a reconnect committed meanwhile (new ciphertext) is not overwritten, and a `fatal_error` without the flag leaves the account `active`
- [ ] T014 [P] Write `tests/helpers/fake-graph.ts`: scripted `fetch` stub keyed by method + path with a request log (method, path, params, never exposing the token in recorded URLs), responses (`ok`, Graph error body, 5xx, unparseable 2xx, missing id), hang-until-abort, reset mid-body (a `Response` whose body stream errors) and pre-send failure (`TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }) })`). Install through `vi.stubGlobal("fetch", …)`; add a small self-test `tests/helpers/fake-graph.test.ts`

**Checkpoint**: `pnpm typecheck`, `pnpm lint`, `pnpm vitest run tests/integration/scheduler tests/integration/connect src/server src/providers` green.

---

## Phase 3: User Story 1 — Connect Facebook Pages and linked Instagram accounts (Priority: P1) 🎯 MVP

**Goal**: one Facebook Login yields a chooser of Pages and their linked Instagram accounts; chosen ones become encrypted-token accounts.

**Independent Test**: with Meta HTTP stubbed, start → callback → chooser submit produces `facebook` and `instagram` account rows with Page/IG ids, decrypting to the Page token; exchanges happen server-side; no token appears in any response, log or attempt.

### Shared Meta module (test-first, in this order)

- [ ] T015 [P] [US1] Implement `src/providers/meta/config.ts` (`parseMetaEnv`, `requireMetaConfig`, `graphVersion`, rules and issue texts per contracts/meta.md) with `src/providers/meta/config.test.ts` (all-or-none id/secret, version pattern, config id ignored without id+secret, issues carry names only)
- [ ] T016 [P] [US1] Implement `src/providers/meta/errors.ts` — the single classification table (190 → credentials invalid; rate-limit and temporary code lists as interim R3 constants; validation/permission → fatal) — with `src/providers/meta/errors.test.ts` covering 190 with any subcode, each listed code, 5xx, unparseable bodies, and secret scrubbing of messages
- [ ] T017 [US1] Implement `src/providers/meta/graph.ts` (`graphRequest`, `graphList`, typed `GraphOutcome`, form-urlencoded POST with token in body, `globalThis.fetch` at request time, `signal` on every call, id validation, `paging.next` restricted to the Graph origin, pre-send vs after-send classification) with `src/providers/meta/graph.test.ts` using fake-graph (token never in any recorded URL for POST; timeout, reset, pre-send failure, unparseable)
- [ ] T018 [US1] Implement `src/providers/meta/oauth.ts` (login dialog URL with `scope` and optional `config_id`, code exchange, long-lived exchange; app secret only in server request bodies/queries) with `src/providers/meta/oauth.test.ts`
- [ ] T019 [US1] Implement `src/providers/meta/candidates.ts` (Pages listing `fields=id,name,access_token,instagram_business_account{id,name,username}`, cap 500 Pages, map to Facebook and linked Instagram candidates, Instagram candidate carries the Page id and Page token, display name per research R8) with `src/providers/meta/candidates.test.ts` (no IG link note, truncation, empty list, missing token)
- [ ] T020 [US1] Implement `src/providers/meta/credentials.ts` (credential payload shape for a Page token) and `src/providers/meta/connect-group.ts` (the `meta` `OAuthConnectGroup`: environment declaration via `parseMetaEnv`, `authorizeUrl`, `exchangeCode` → candidates, `pasteToken`) wired from the modules above; keep it parameterised by `MetaApp` so Threads can reuse it (FR-004)

### Generic connect service (G5/G6), proven with a throwaway two-provider group first

- [ ] T021 [US1] Extract `saveConnectedAccountTx` from `src/server/services/accounts.ts` (the existing `saveConnectedAccount` calls it; behaviour unchanged) and make the credential-form list exclude `oauth` providers
- [ ] T022 [US1] Implement `src/server/services/connect.ts` per contracts/connect.md: `startOAuthConnect` (unguessable state, SHA-256 stored, bound to user + session + project, 10-minute life, `account:manage` role), `getConnectChoice`, `chooseConnectCandidates` (one transaction: lock attempt `FOR UPDATE`, re-check user/session/expiry/`completed_at IS NULL`, upsert each chosen account with `saveConnectedAccountTx`, `complete()`, one unique-violation retry), expired-attempt purge on connect traffic. Candidate ciphertext AAD is `connect_attempt:<id>`, capped at 500 candidates / 1 MB. `handleOAuthCallback` and `pasteConnectToken` are added in US2 / US8
- [ ] T023 [P] [US1] Add the Server Actions `startOAuthConnectAction` and `chooseConnectCandidatesAction` to `src/app/p/[projectSlug]/accounts/actions.ts` (Zod at the boundary, server-side role check, `redirect()` to the external login URL, `refresh()` after save)
- [ ] T024 [P] [US1] Build the chooser: `src/app/p/[projectSlug]/accounts/connect/[attemptId]/page.tsx` (server component) and `ChooserForm.tsx` (client leaf) with nested labelled checkboxes in fieldsets (Page, then its Instagram account), "already connected" marks, a "no Instagram professional account is linked" note, and alert-role messages; follow the `docket-ui` skill
- [ ] T025 [US1] Update `src/app/p/[projectSlug]/accounts/page.tsx` and add `ConnectGroupSection.tsx` (client leaf): one section per connect group (rendered once even when two providers reference it), editor sees no connect action, a "not configured" state with `CopyField` for the redirect URI and the doc path as plain text, `?connect=` result banner
- [ ] T026 [US1] Write `tests/integration/connect/oauth-flow.test.ts` with a throwaway two-provider group (no Meta code): start returns the dialog URL with state and the fixed callback, chooser save creates both accounts, existing account updated in place and reactivated with error cleared, unticked candidates not saved, role refusals for editor on start and choose
- [ ] T027 [P] [US1] Write `tests/integration/connect/choose-race.test.ts`: two concurrent chooser submits on separate pool connections, 20× in a loop, only the first saves; a concurrent connect of the same Page retries once without duplicating
- [ ] T028 [P] [US1] Write `tests/integration/connect/chooser-ui.test.ts`: render the chooser server component for a throwaway attempt; assert labelled checkboxes, nested IG under Page, the no-IG note, "already connected" mark, and that no token/ciphertext is present in the HTML
- [ ] T029 [US1] Write `tests/integration/connect/meta-connect.test.ts` using the real **meta group** and fake-graph (run after US2's T030–T031 and after `facebookProvider`/`instagramProvider` are registered in T041/T049): start → callback → chooser with one Page and one Instagram account → two rows with `facebook`/`instagram` provider keys, external ids, credentials decrypting to the Page token, code and long-lived exchanges made server-side with the app secret, and the Meta-not-configured state hides the connect action

**Checkpoint**: US1 connect works with the throwaway group (T026–T028) and the Meta group (T029).

---

## Phase 4: User Story 2 — The callback is safe against forgery and replay (Priority: P1)

**Goal**: forged, expired, reused or foreign-session callbacks do nothing; cancelled logins change nothing.

**Independent Test**: the six refused cases make zero Graph calls and change no account.

- [ ] T030 [US2] Implement `handleOAuthCallback` in `src/server/services/connect.ts` in this exact order (research D5): (1) state shape, (2) lookup by hash, (3) expiry and reuse, (4) user + session binding, (5) re-resolve membership/role, (6) conditional consume (`UPDATE … RETURNING`), (7) only then the code exchange and long-lived exchange, then listing → candidates encrypted into the attempt. A platform `error`/`error_reason` is handled after a successful consume so the state cannot be reused. Messages never contain secrets
- [ ] T031 [US2] Add `src/app/connect/callback/route.ts` (GET → `handleOAuthCallback` → redirect to the chooser, the accounts screen with `?connect=…`, or `/connect/invalid`) and `src/app/connect/invalid/page.tsx` ("This connection attempt has expired or is not valid. Start again."); an unauthenticated callback is sent to sign-in and then refused (decision D6)
- [ ] T032 [US2] Write `tests/integration/connect/state-security.test.ts`: missing, unknown, malformed, expired (>10 min via DB clock), reused, foreign-session, and demoted-user states each assert **zero** fake-graph calls and no account change; platform error / cancelled login returns to accounts with a plain message; failed code exchange and failed long-lived exchange leave nothing changed and the message names what to check without secrets; expired unsubmitted attempt can no longer be chosen and its candidates are purged
- [ ] T033 [P] [US2] Extend `tests/integration/actions-authz.test.ts` with rows for start, callback, chooser and (later) paste: editor refused server-side, owner/admin allowed

---

## Phase 5: User Story 7 — Revoked tokens are flagged and can be fixed (Priority: P1)

**Goal**: code 190 flags the account and stops publishing; reconnecting reactivates it.

**Independent Test**: a 190 on any step sets `needs_reauth`; a chooser reconnect makes the account `active` with the new token.

- [ ] T034 [US7] Ensure the shared `errors.ts` maps 190 (any subcode) to `fatal_error` with `credentialsInvalid: true` and a reason phrased as a reason ("Facebook says the access token is no longer valid (code 190/460).") because the engine prefixes `Reconnect <name> to publish:`; add the cases to `src/providers/meta/errors.test.ts`
- [ ] T035 [US7] Update the accounts page for a `needs_reauth` Facebook/Instagram account: the card offers "Reconnect with Facebook" (start action) and the paste form; a reconnect where the Page is no longer managed shows "Page not found for this login" and leaves the account `needs_reauth`
- [ ] T036 [US7] Write `tests/integration/connect/reconnect.test.ts` (meta group + fake-graph): reconnect via chooser updates the same row in place, status `active`, `last_error` cleared, new ciphertext; a failed target from a revoked token can be retried with the existing retry action after reconnect; missing Page leaves it `needs_reauth`

---

## Phase 6: User Story 3 — Publish to a Facebook Page (Priority: P1)

**Goal**: text/link, single photo and multi-photo posts publish through the unchanged scheduler.

**Independent Test**: real `runTick` with fake-graph publishes (a) text + URL, (b) one image, (c) three images; only the final request is `mayPublish`.

- [ ] T037 [P] [US3] Implement `src/providers/facebook/capabilities.ts` and `settings.ts` per contracts/facebook.md (text + image + carousel, text-only allowed, interim R1/R2 limits as named constants, JPEG/PNG ≤ 8 MB, ≤ 10 photos, no alt text sent)
- [ ] T038 [P] [US3] Implement `src/providers/facebook/links.ts` (first http(s) URL in the text; images take precedence over the link) with `src/providers/facebook/links.test.ts` (several URLs, trailing punctuation, none)
- [ ] T039 [US3] Implement `src/providers/facebook/steps.ts` (pure, total `stepFor`: text → one `publish_feed`; one image → one `publish_photo`; N images → N `upload_photo` non-publishing steps then `publish_feed` with `attached_media`) with `src/providers/facebook/steps.test.ts` (malformed state, 0/1/N media, step state holds only photo ids)
- [ ] T040 [US3] Implement `src/providers/facebook/publish.ts` (`advance` using the shared `graphRequest`, `ctx.signal`, outcome mapping per US6 table, `done` with the post id as external id, URL omitted when unknown per R5) and `index.ts` (`facebookProvider`, `oauth` strategy on the `meta` group, `validate`), with `src/providers/facebook/publish.test.ts` for success paths: text, text with link, one photo, multi-photo (mocks only, U1), request params exact
- [ ] T041 [US3] Register `facebookProvider` in `src/providers/registry.ts` (one line) and make `registry.test.ts` pass
- [ ] T042 [US3] Write `tests/integration/facebook/publish-e2e.test.ts` through real `runTick`: text + URL → one request with `message` and `link`; one image → photos request with URL and caption; target `published` with post id; Facebook native scheduling never used
- [ ] T043 [P] [US3] Write `tests/integration/facebook/multi-photo.test.ts`: N photos publish within N + 1 ticks, photo ids in order in `attached_media`, a failed later step leaves nothing public and follows the outcome rules; header comment states U1 is verified with mocks only

---

## Phase 7: User Story 4 — Publish to Instagram through the container step machine (Priority: P1)

**Goal**: container create → status polling via `continue` + `notBefore` → quota check → one publish, no sleeps.

**Independent Test**: real `runTick` with fake-graph and the DB clock helper publishes a single image (IN_PROGRESS then FINISHED) and a four-image carousel with one publish request.

- [ ] T044 [P] [US4] Implement `src/providers/instagram/capabilities.ts` and `settings.ts` per contracts/instagram.md (image + carousel, media required, ≤ 10, JPEG, ≤ 8 MB, aspect 0.8–1.91, width ≤ 1440, alt ≤ 1000, interim caption limit R1, default publish limit 100 per 86400 s)
- [ ] T045 [US4] Implement `src/providers/instagram/state.ts` (Zod-parsed step state: container ids, media type, status-check count, first-check time, `createdAt`, recreation count; no secrets) and timing constants (10 s doubling to 5 min, 60-minute cap, 23 h age guard, recreate cap 2)
- [ ] T046 [US4] Implement `src/providers/instagram/steps.ts` (pure, total `stepFor`: carousel → item containers per image then carousel container; single → one container; then `check_status`…, `check_quota`, `publish`; state names the container media type so video can be added later) with `src/providers/instagram/steps.test.ts`
- [ ] T047 [US4] Implement container-create and `check_status` in `src/providers/instagram/publish.ts`: JPEG variant public URL, caption on the single/carousel container, non-empty `alt_text` per item; `IN_PROGRESS` → `continue` with `notBefore = ctx.now + delay`; `FINISHED` → next step; `ERROR` → `fatal_error` with scrubbed reason; `EXPIRED` before any publish request → recreate from step one (max 2, then fatal with a clear message); `PUBLISHED` before our publish → `ambiguous`; >60 min `IN_PROGRESS` → "Instagram did not finish processing the media"
- [ ] T048 [US4] Implement `src/providers/instagram/quota.ts` (defensive read of `content_publishing_limit`; full → `retryable_error` with `notBefore` +1 h and usage in the summary; unreadable → proceed on Docket's own counter with "quota unknown" in the summary; 23 h container age guard recreates before publish) and the `publish` step in `publish.ts` (one `mayPublish` `media_publish`; success → `done` with media id as external id; definitive "container expired" → `fatal_error` telling the user to retry, never auto-recreate after a publish request)
- [ ] T049 [US4] Implement `src/providers/instagram/index.ts` (`instagramProvider`, `oauth` strategy on the `meta` group) and register it in `src/providers/registry.ts` (one line); `registry.test.ts` must pass
- [ ] T050 [P] [US4] Write `src/providers/instagram/steps.test.ts` additions and `src/providers/instagram/publish.test.ts` covering each step's request params and results (container create params incl. caption/alt_text, status mapping for IN_PROGRESS/FINISHED/ERROR/EXPIRED/PUBLISHED, recreation count and cap, 60-minute cap using `ctx.now`)
- [ ] T051 [US4] Write `tests/integration/instagram/publish-e2e.test.ts` through real `runTick` using `tests/helpers/clock.ts` to advance the DB clock between ticks (no sleeping): single image publishes in 4 ticks when ready at first check; IN_PROGRESS then FINISHED takes the extra tick; each status check carries a `notBefore`; exactly one publish request; quota checked before publish
- [ ] T052 [P] [US4] Write `tests/integration/instagram/carousel.test.ts` (N-image carousel in N + 4 ticks, items in order, one carousel container) and `tests/integration/instagram/container-status.test.ts` (ERROR → fatal with no publish request, EXPIRED recreation and cap, PUBLISHED-before-publish → ambiguous, 60-minute cap)

---

## Phase 8: User Story 6 — Unknown, rate-limited and rejected outcomes behave safely (Priority: P1)

**Goal**: the may-publish ambiguity rules hold for every step on both providers.

**Independent Test**: the matrix in spec US6 passes for Facebook feed/photo, Instagram publish and every non-publishing step.

- [ ] T053 [US6] Write `tests/integration/facebook/outcomes.test.ts`: for `publish_feed`, `publish_photo` (mayPublish) and `upload_photo` (non-publishing) stub timeout-after-send, reset, 5xx, unparseable 2xx, 2xx missing id, rate-limit, validation/permission, code 190, pre-send failure; assert ambiguous vs retryable vs fatal per spec US6 and that no ambiguous target is retried by the next tick
- [ ] T054 [US6] Write `tests/integration/instagram/outcomes.test.ts`: same matrix for `publish` (mayPublish) and for container create, `check_status` and `check_quota` (non-publishing); also "container expired" answered to publish → fatal, never recreated; lease recovery of a killed publish step is `recovered_ambiguous`
- [ ] T055 [US6] Fix whatever the matrix exposes in `src/providers/facebook/publish.ts`, `src/providers/instagram/publish.ts` or `src/providers/meta/errors.ts` (rate-limit retryable on mayPublish steps only because a rate-limited request is refused; temporary/5xx/unparseable on mayPublish → ambiguous), re-running T053/T054 until green. If nothing needs fixing, say so in the commit

---

## Phase 9: User Story 5 — Instagram publishing limits are respected (Priority: P2)

**Goal**: never a 101st publish in 24 h.

**Independent Test**: simulated 150 queued targets produce at most 100 publish requests in a window.

- [ ] T056 [US5] Write `tests/integration/instagram/quota.test.ts`: platform quota full → `retryable_error` with `notBefore` ≈ +1 h, no publish request, usage in the attempt summary; unreadable/failed/unparseable quota → publishing proceeds, summary says quota unknown; `PUBLISH_MAX_ATTEMPTS` quota refusals in a row fail the target (accepted, plan note 10); wait past 23 h age recreates containers (no publish was sent)
- [ ] T057 [P] [US5] Write `tests/integration/instagram/limits.test.ts`: the provider's default 100/86400 s is enforced by the existing engine counter (101st target waits with no provider call), an account-level override still works, and a 150-target run never sends a 101st publish (SC-006)

---

## Phase 10: User Story 8 — Paste a token from Graph API Explorer (Priority: P2)

**Goal**: a pasted user token reaches the same chooser; also reconnects.

**Independent Test**: fake-graph long-lived exchange + Pages listing; pasted token only in the exchange; not stored/echoed/logged.

- [ ] T058 [US8] Implement `pasteConnectToken` in `src/server/services/connect.ts` and `pasteConnectTokenAction` in `src/app/p/[projectSlug]/accounts/actions.ts` (owner/admin only; insert the attempt then store the ciphertext in the same transaction; exchange outside any transaction; clear-field result on failure; the token is never stored or returned) and the paste form in `ConnectGroupSection.tsx` (label, hint listing the five permissions, field cleared after submit)
- [ ] T059 [US8] Implement `pasteToken` in `src/providers/meta/connect-group.ts` using `oauth.ts` (long-lived exchange then `candidates.ts`) with a case in `src/providers/meta/oauth.test.ts`
- [ ] T060 [US8] Write `tests/integration/connect/paste.test.ts`: valid token → chooser; unexchangeable token (expired/wrong app/malformed) → clear message and nothing changes; no Pages → message lists needed permissions; editor refused server-side and form not rendered; neither pasted nor long-lived user token stored anywhere (FR-012/FR-013)

---

## Phase 11: User Story 9 — Live validation in the composer (Priority: P2)

**Goal**: composer shows the platform rules before scheduling.

**Independent Test**: provider `validate` unit tests and the composer check endpoint return the specified issues.

- [ ] T061 [P] [US9] Implement `src/providers/facebook/validate.ts` (shared capability checks; text-only allowed; `too_many_images`; `text_too_long` with count/limit) with `src/providers/facebook/validate.test.ts` covering the edges (max images vs +1, text at/over limit counted in code points)
- [ ] T062 [P] [US9] Implement `src/providers/instagram/validate.ts` (shared checks; map `text_only_not_allowed` to `media_required` keeping `postType`; 10/11 images; aspect 0.8 and 1.91 inclusive, outside → `aspect_ratio_out_of_range` naming the image; alt 1000/1001; informational notes for PNG, >8 MB, >1440 px; mixed-aspect carousel crop note) with `src/providers/instagram/validate.test.ts`
- [ ] T063 [US9] Extend `tests/integration/compose-check-route.test.ts`: an Instagram target with no image yields exactly one blocking issue; Facebook text-only yields none; both providers' issues appear in the composer's per-target list

---

## Phase 12: User Story 10 — Meta app setup docs (Priority: P2)

**Goal**: a deployer can set up the Meta app from written steps.

**Independent Test**: every env var named in the docs exists in `.env.example` and in startup validation (checked by `registry.test.ts`, T005).

- [ ] T064 [P] [US10] Write `docs/meta-setup.md` in the order of plan note 15 (create Business app; Facebook Login for Business use case and optional login configuration with the five permissions → `META_LOGIN_CONFIG_ID`; permissions and when `ads_management`/`ads_read` would be needed; app roles for every connecting user and the linked-IG check; Standard Access, no App Review; valid OAuth redirect URIs for production `https://<host>/connect/callback` and `http://localhost:3000/connect/callback` marked **unverified (U2)** with a test procedure; hosts-file + mkcert fallback; where to find app id/secret and env vars; leave "Require App Secret" off (R6); Graph API Explorer token-paste steps with the five permissions; public bucket note; marked `## Threads (added by the meta-threads entry)` placeholder)
- [ ] T065 [P] [US10] Add `META_APP_ID`, `META_APP_SECRET`, `META_GRAPH_VERSION`, `META_LOGIN_CONFIG_ID` to `.env.example` with comments (all-or-none id/secret, default `v26.0`)
- [ ] T066 [P] [US10] Add the README section "Connecting Facebook Pages and Instagram" in `README.md` (what is stored, what "needs reconnection" means, public-bucket requirement for Instagram, how to remove Docket's access in Facebook settings) — FR-038
- [ ] T067 [P] [US10] Update `docs/adding-a-provider.md`: §4 OAuth groups, candidate lists, paste fallback and provider-declared env (G5/G6/G8); §7 `credentialsInvalid` (G7); new §14 Instagram worked example of a polling step machine with `continue` + `notBefore` — FR-039

---

## Phase 13: Polish & Cross-Cutting

- [ ] T068 [P] Write `tests/integration/meta/no-secrets.test.ts` (SC-007, FR-034): with distinctive fake values (`EAAG-fake-user-…`, `EAAG-fake-page-…`, app secret, `code-fake-…`, pasted token) run connect, callback, paste, chooser render and every advance path; grep `publish_attempts`, `post_targets`, `social_accounts` (minus `credentials_encrypted`), `connect_attempts` (minus `candidates_encrypted`), captured `console.*` (`vi.spyOn`), action results and chooser HTML
- [ ] T069 [P] Write `tests/integration/meta/engine-unchanged.test.ts` (FR-003, FR-002): the unchanged `runTick` publishes a Facebook and an Instagram target end to end, and a source scan asserts no `facebook`/`instagram`/`meta` string literals in `src/server/scheduler/**`, `src/server/services/**` (other than generic names), composer or schema
- [ ] T070 Extend `tests/integration/accounts-ui.test.ts` and `tests/integration/no-plaintext.test.ts` for the new account shapes (oauth providers absent from the credential form, each group rendered once, not-configured state, ciphertext only in `credentials_encrypted`/`candidates_encrypted`)
- [ ] T071 Append "005 — Facebook Pages and Instagram" to `docs/decisions.md` covering every item in plan.md implementation note 14 (FR-012; G5 including the `connect_attempts` table: what/why/reverse; G6, G7, G8; R1–R10 interim values as unverified; first-URL-as-link; images over link; polling cadence and 60-minute cap; recreation rule, cap 2 and 23 h guard; quota retry +1 h and attempt-cap note; no post URLs (R5); Instagram display name (R8); purge on connect traffic (D9) and its limit; unauthenticated callback refused after sign-in (D6); "verified with mocks only" for live connect/publishing, U1 and U2; note that `PUBLISH_MAX_DURATION_HOURS` usually fires before the 23 h guard)
- [ ] T072 Run the final gates and record real output: `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm db:check` (no drift after the single migration; `tests/lint/worker-bundle.test.ts` and import-boundaries green)
- [ ] T073 Verify scope (SC-008) with `git diff --stat main -- . ':!src/providers/meta' ':!src/providers/facebook' ':!src/providers/instagram' ':!tests' ':!docs' ':!README.md' ':!specs'`; only the two registry lines and the generic G5–G8 files named in plan.md may appear
- [ ] T074 Execute quickstart.md §1–§6 commands (§7 is replaced by the Vitest UI tests T028/T060) and note each as "verified with mocks only" in the `docs/decisions.md` entry
- [ ] T075 🛑 BLOCKED: needs a real Meta app, Facebook login, a Page with a linked Instagram professional account and a public media bucket — owner performs quickstart.md §8 after merge (connect, publish, U1 multi-photo, U2 localhost redirect) and records "verified live on <date>" in `docs/decisions.md`

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 (blocks everything). Within Phase 2: T003 → T004 → T005; T006 → T007 → (T008, T009); T010 and T014 independent after T003; T011 → T012 → T013.
- US1 (Phase 3): T015, T016 parallel → T017 → T018 → T019 → T020; T021 → T022 → (T023, T024) → T025 → (T026, T027, T028). T029 (Meta end-to-end) needs T020, T022 and US2's T030–T031.
- US2 needs T022 and T020 (T030 → T031 → T032, T033). US7 needs US1 + US2 and G7 (Phase 2).
- US3 needs Phase 2, T017 and T020; T037/T038 parallel → T039 → T040 → T041 → T042, T043. US4 needs the same plus the clock helper; T044 → T045 → T046 → T047 → T048 → T049 → (T050, T051, T052). US6 needs US3 and US4 publish code. US5 needs US4.
- US8 needs US1 and US2. US9 needs T037/T044. US10 is independent after T003.
- Polish after all stories; T075 is owner-owned and never gates the run.

### Parallel opportunities

- Phase 2: T005, T008/T009, T010, T014 together after their predecessors.
- US1: T015 + T016; T023 + T024; T027 + T028.
- US3: T037 + T038. US4: T044 early; T050 + T052 after T049. US3 and US4 may proceed in parallel once the Meta module exists.
- US9: T061 + T062. US10: T064–T067 together. Polish: T068 + T069.

## Implementation Strategy

### MVP first

Phase 1 → Phase 2 → US1 (connect, throwaway group then Meta group) → US2 (callback safety, required for the Meta e2e) → US3 (Facebook text publish) → stop and validate: a connected Page publishes a text post through the unchanged engine.

### Incremental delivery

Then US7 (reconnect), US4 (Instagram), US6 (outcome matrix), US5 (limits), US8 (paste), US9 (validation), US10 (docs), then Polish. The framework fixes G5–G8 stay generic and are proven with a throwaway provider before any Meta code depends on them.

## Notes

- Call `globalThis.fetch` at request time, never a captured reference; pass `ctx.signal` (or the connect timeout signal) on every call. Never log `request.url`.
- POST bodies use `URLSearchParams` with `content-type: application/x-www-form-urlencoded` and `access_token` in the body; tests assert the token is absent from every recorded URL for POSTs.
- Only `ECONNREFUSED`, `ENOTFOUND` and `EAI_AGAIN` in the cause chain are pre-send; `AbortError`/`TimeoutError` are after-send.
- Advance the DB clock (`tests/helpers/clock.ts`) between ticks; never sleep.
- Interim values R1–R10 live in one constant each and are reported as unverified, never as working.
- Commit per task or logical group with conventional commits and explicit paths.
