---

description: "Task list for the Bluesky provider (004)"
---

# Tasks: Bluesky provider

**Input**: Design documents from `/specs/004-bluesky-provider/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (providers, bluesky, scheduler, accounts), quickstart.md

**Tests**: Requested by the spec (FR-027). Every test uses Vitest against real Postgres (001–003 harness) with `fetch` stubbed. There are **no live calls**. Every task below is executable headless (vitest, `tsc`, lint, build); nothing needs a browser or the network.

**Organization**: Grouped by user story. Framework gaps G1–G4 are generic and sit in Foundational (G2–G4) or in the story that needs them (G1 in US1).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependencies on incomplete tasks)
- **[Story]**: US1–US6 (spec.md)
- Commands: `pnpm vitest run <path>`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm db:check`

## Phase 1: Setup

**Purpose**: confirm the baseline and create the folder skeleton

- [X] T001 Confirm `@atproto/api` 0.22.0 is in `package.json` and importable (`Agent`, `RichText`, `BlobRef`, `AtUri`, `XRPCError`); run `pnpm typecheck` and `pnpm vitest run src/providers` to record a green baseline. Add no dependency
- [X] T002 [P] Create the empty module files listed in plan.md under `src/providers/bluesky/` (`index.ts settings.ts client.ts session.ts steps.ts facets.ts publish.ts errors.ts validate.ts`), each exporting its planned names as typed stubs so later tasks compile

---

## Phase 2: Foundational (framework fixes G2, G3, G4 and test helper)

**Purpose**: generic engine/type changes that MUST land, proven with a throwaway provider, before Bluesky exists

**⚠️ CRITICAL**: no user story work starts until this phase is complete

- [X] T003 Update `src/providers/types.ts` per data-model §6: `CredentialField.optional/defaultValue/placeholder`, `ConnectResult`, `connectAccount?`, `needsRefresh?`, `retryable_error.credentialsExpired?`, `RefreshResult.transient/retryAt/displayName`, `StepContent`, `stepFor(state, settings, content)`, `PublishContext.step`
- [X] T004 Update `src/providers/mock/index.ts` (and any other `stepFor` implementer or caller found by `pnpm typecheck`) for the new `stepFor` signature, ignoring `content`; behaviour unchanged. Run `pnpm typecheck` and fix every compile error repo-wide
- [X] T005 [P] Extend `src/providers/registry.test.ts` with the new invariants from contracts/providers.md (connectAccount ⇒ credentials/manual-token strategy with ≥1 field; unique field names matching `[a-zA-Z][a-zA-Z0-9]*`; defaultValue ⇒ optional; secret ⇒ no defaultValue; needsRefresh ⇒ refreshCredentials; `stepFor` total on malformed state with `{text:"", mediaCount:0}`)
- [X] T006 [P] Add `RefreshPatch.displayName` (applied by `recordRefresh`) and `AccountsRepo.acquireRefreshLease` (acquired/changed/busy/unavailable, one conditional UPDATE filtered on `project_id`) in `src/server/dal/accounts.ts`
- [X] T007 [P] Add `ClaimContext.contentShape(target)` (effective text = `override_text ?? base_text`, `count(post_media)`, pinned by `project_id`, `null` when the post is gone) in `src/server/dal/scheduler.ts`
- [X] T008 Extend the scope-check/authorization tables in `tests/helpers/scope-check.ts` and `tests/integration/scope-check.test.ts` for `acquireRefreshLease` and `contentShape`; run `pnpm vitest run tests/helpers/scope-check.test.ts tests/integration/scope-check.test.ts`
- [X] T009 G4 in `src/server/scheduler/publishing.ts`: call `contentShape` in the claim `decide` (order per contracts/scheduler.md §1), pass `content` to `stepFor`, pass `step: { name, mayPublish }` into `advance`, and return `fatal_error` "The post is no longer available." (no provider call) when effective content is null
- [X] T010 Write `tests/integration/scheduler/step-content.test.ts` with a throwaway provider (`registerTestProvider`): `stepFor` receives `{text, mediaCount}` reflecting `override_text`; first-step `mayPublish` depends on `mediaCount`; deleted post → `fatal_error` never `ambiguous`; `ctx.step` visible to the provider. Run it green
- [X] T011 Create `src/server/scheduler/credentials.ts` with `applyRefreshResult` (ok / definitive → `needs_reauth` / transient → stays active with `last_error`, per contracts/scheduler.md §3) and `refreshForPublish` (lease → decrypt → timeout-bounded `refreshCredentials` → `applyRefreshResult`; returns refreshed/changed/busy/unavailable/transient/refused)
- [X] T012 Make `src/server/scheduler/token-refresh.ts` delegate to `applyRefreshResult`; transient keeps the account `active` and counts `deferred`; a thrown error still means `needs_reauth`
- [X] T013 Wire proactive (`needsRefresh`) and reactive (`credentialsExpired`) refresh into `execute` in `src/server/scheduler/publishing.ts`, extracting the existing out-of-budget path into `release(lease, error?)`; refresh only when it fits the tick deadline (contracts/scheduler.md §2)
- [X] T014 [P] Write `tests/integration/scheduler/publish-refresh.test.ts` (throwaway provider, scripted `needsRefresh`/`refreshCredentials`): proactive persists before `advance` sees it; `changed` reuses with no second call; `busy` releases with unchanged `attemptCount` and one `released` attempt; `refused` → `needs_reauth` then `account_unavailable` next tick; `transient` → retryable with `notBefore=retryAt`, account stays active; reactive `credentialsExpired` then publish once; budget overrun releases
- [X] T015 [P] Write `tests/integration/scheduler/refresh-concurrency.test.ts`: two `refreshForPublish` plus one `runTokenRefresh` race on one account over separate pool connections with a latch-slowed refresh, looped 20×; assert exactly one platform refresh and newest refresh token persisted (SC-006)
- [X] T016 [P] Extend `tests/integration/scheduler/refresh.test.ts`: transient stays `active` with `last_error` and retries next tick; `displayName` updated on handle change; all 002 cases unchanged
- [X] T017 Create `tests/helpers/fake-pds.ts`: scripted `fetch` stub returning status/headers/body per route, with modes hang-until-abort, reset-mid-body, pre-send failure (`TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } })`), latch-delayed responses, and a request log (url, method, headers, parsed body). Includes a helper to mint fake JWTs with a chosen `exp`. Add a small self-test
- [X] T018 Run `pnpm typecheck && pnpm lint && pnpm vitest run tests/integration/scheduler src/providers` and confirm all existing 002/003 scheduler tests still pass

**Checkpoint**: framework ready; Bluesky work can begin

---

## Phase 3: User Story 1 - Connect a Bluesky account (Priority: P1) 🎯 MVP

**Goal**: owner/admin connects with handle + app password (+ optional PDS); encrypted session stored; app password never stored (G1).

**Independent Test**: `pnpm vitest run src/providers/bluesky/settings.test.ts src/providers/bluesky/session.test.ts src/providers/bluesky/errors.test.ts tests/integration/accounts-credentials-connect.test.ts`

### Provider pieces

- [ ] T019 [P] [US1] Implement `src/providers/bluesky/settings.ts`: `blueskySettingsSchema`, `blueskyCredentialsSchema`, `blueskyStateSchema`, `normaliseHandle` (strip `@`, trim, lower-case), `normalisePdsUrl` (https only, no credentials/query/fragment, trailing slash ignored), `DEFAULT_PDS_URL`; with `settings.test.ts` covering handle and PDS URL rules
- [ ] T020 [P] [US1] Implement `src/providers/bluesky/errors.ts`: `classify(err, kind)`, `rateLimitNotBefore(headers, now)` (Retry-After delta-seconds and HTTP-date, junk/past ignored, 24 h cap), `isPreSend` (walk `cause` to bounded depth for ECONNREFUSED/ENOTFOUND/EAI_AGAIN), `safeReason`; with `errors.test.ts`
- [ ] T021 [P] [US1] Implement `src/providers/bluesky/client.ts` `agentFor(pdsUrl, accessJwt?)` using `Agent` with `fetch: (i, o) => globalThis.fetch(i, o)` (no `CredentialSession`/`AtpAgent`)
- [ ] T022 [US1] Implement `connectAccount` and `jwtExp` in `src/providers/bluesky/session.ts` per contracts/bluesky.md §4 (single `createSession`, failure mapping table, expiry = refresh JWT `exp` else now+60 d); write the connect half of `session.test.ts` with fake-pds: success shape (no password anywhere in `JSON.stringify(result)`), each failure row, PDS rules, handle normalisation, no request on invalid input
- [ ] T023 [US1] Wire the declarations (capabilities, `connect.fields`, `settingsSchema`) in `src/providers/bluesky/index.ts` per contracts/bluesky.md §2 and add the single `blueskyProvider as SocialProvider` line to `src/providers/registry.ts`; run `pnpm vitest run src/providers/registry.test.ts`

### Generic connect (G1)

- [ ] T024 [US1] Add `connectWithCredentials` (zod input, `manage` check before any network call, provider/reconnect checks, field normalisation per contracts/providers.md G1, 15 s abort, redaction, DID-mismatch refusal on reconnect, `saveConnectedAccount` upsert with one retry on unique violation) and `credentialConnect` on `listConnectableProviders` in `src/server/services/accounts.ts`
- [ ] T025 [US1] Add `connectCredentialsAction(slug, input)` through `mutate` in `src/app/p/[projectSlug]/accounts/actions.ts`; fold `retryAt` into the message in project time zone; never echo field values
- [ ] T026 [P] [US1] Create `src/app/p/[projectSlug]/accounts/ConnectCredentialsForm.tsx` (client leaf; labelled fields from declared metadata, secret → `type="password"` `autoComplete="new-password"` cleared after every submit, `role="alert"` errors, polite live region on success, focus to first invalid field) following the `docket-ui` skill
- [ ] T027 [US1] Update `src/app/p/[projectSlug]/accounts/page.tsx`: per-provider "Connect a <name> account" section for `credentialConnect` providers when `canManage`; Reconnect disclosure in `needs_reauth` cards; editors see neither
- [ ] T028 [P] [US1] Write `tests/integration/accounts-credentials-connect.test.ts` per contracts/accounts.md §4 (success row/credentials/settings, default and custom PDS, each failure leaves DB untouched, rate-limit retry time, same DID twice → one row, reconnect same DID ok / different DID refused, editor refused with zero PDS requests, invalid handle/PDS → zero requests, app password absent from DB dump/action result/console)
- [ ] T029 [P] [US1] Extend `tests/integration/accounts-ui.test.ts` (declared fields render with right `type`/`autocomplete`/`required`; editors see no form), `tests/integration/actions-authz.test.ts` (owner/admin ✓, editor `forbidden`, no PDS request) and `tests/integration/no-plaintext.test.ts`
- [ ] T030 [US1] Run the Independent Test command above plus `pnpm typecheck && pnpm lint`

**Checkpoint**: Bluesky accounts can be connected and reconnected

---

## Phase 4: User Story 2 - Publish a text post with links, mentions and hashtags (Priority: P1)

**Goal**: text posts publish through the unchanged scheduler with correct facets; `at://` id and bsky.app URL recorded.

**Independent Test**: `pnpm vitest run src/providers/bluesky/facets.test.ts src/providers/bluesky/steps.test.ts src/providers/bluesky/publish.test.ts tests/integration/bluesky/publish-e2e.test.ts`

- [ ] T031 [P] [US2] Implement `src/providers/bluesky/facets.ts` `buildFacets(text, mentions)` (RichText `detectFacetsWithoutResolution`, mention `did` holds handle → normalise and substitute, drop null/unresolved, drop empty facets, return counts) and `facets.test.ts`: byte ranges after emoji/accents/CJK asserted via `Buffer.from(text).subarray(start,end).toString() === token`, unresolved dropped with text unchanged, mixed pair
- [ ] T032 [P] [US2] Implement `src/providers/bluesky/steps.ts` (`stepForContent`, `mentionHandles`) pure and total per data-model §4, and `steps.test.ts` covering the whole table, invalid state, and totality on random junk
- [ ] T033 [US2] Implement `src/providers/bluesky/publish.ts` for `resolve_mentions` and `create_post` (record shape per contracts/bluesky.md §6, `createdAt = ctx.now`, `at://` URI validated, URL `https://bsky.app/profile/<handle>/post/<rkey>`, summaries per §7, step-mismatch → retryable, unreadable state/credentials → fatal, `signal: ctx.signal` on every call, never throws)
- [ ] T034 [US2] Wire `stepFor`, `advance`, `validate` hook-ups in `index.ts`; write `publish.test.ts` for text-only success, record shape (alt `""`, `createdAt`), `at://` URL parsing edges, resolve_mentions success/unresolved/transient failure never ambiguous, step mismatch, and no secrets in any result
- [ ] T035 [US2] Write `tests/integration/bluesky/publish-e2e.test.ts` through the real `runTick`: text-only publishes in 1 tick; multibyte text with link + resolved mention + hashtag in 2 ticks with correct request facets; unresolved mention publishes with no mention facet; mention-lookup failure retries and never goes ambiguous
- [ ] T036 [US2] Run the Independent Test command above

**Checkpoint**: text publishing works end to end

---

## Phase 5: User Story 3 - Posts with images and alt text (Priority: P1)

**Goal**: up to 4 images uploaded one per step from the Bluesky variant, then embedded with alt text and aspect ratio.

**Independent Test**: `pnpm vitest run tests/integration/bluesky/images.test.ts`

- [ ] T037 [US3] Add `upload_image_<n>` to `src/providers/bluesky/publish.ts`: fetch the variant URL, check size ≤ 2,000,000 and allowed type (fatal before upload otherwise), `uploadBlob(bytes, { encoding })`, `continue` with `blob.ipld()` appended; embed built with `BlobRef.fromJsonRef`, alt text, `aspectRatio` only when both dimensions known
- [ ] T038 [US3] Extend `publish.test.ts` with the upload rows of the outcome table (timeout/5xx/429/pre-send → retryable, 4xx → fatal, image fetch non-2xx → retryable, size/type mismatch → fatal, expired token → retryable + `credentialsExpired`) and 4-image success
- [ ] T039 [US3] Write `tests/integration/bluesky/images.test.ts` through `runTick`: 3 images (one source > 2,000,000 bytes) publish in 4 ticks using the Bluesky variant (each upload ≤ 2,000,000 bytes), embed order/alt/aspect ratio correct; upload timeout then success re-uploads only that image and never ambiguous; upload 4xx → `failed` with no `createRecord` request; referenced-image-unknown rejection gives the "use Retry" message

**Checkpoint**: image posts publish

---

## Phase 6: User Story 6 - Unknown and rate-limited outcomes (Priority: P1)

**Goal**: ambiguous never retried; 429 honours `Retry-After`.

**Independent Test**: `pnpm vitest run tests/integration/bluesky/ambiguous.test.ts`

- [ ] T040 [US6] Extend `publish.test.ts` with every `publish`-kind row: hang until abort, reset mid-body, unparseable 2xx, 2xx missing `uri`, malformed `at://`, 5xx → `ambiguous`; 429 → retryable with `notBefore`; pre-send → retryable; 400 → `fatal_error` with truncated platform message and secrets removed
- [ ] T041 [US6] Write `tests/integration/bluesky/ambiguous.test.ts` through `runTick`: each ambiguous scenario ends `ambiguous` with no further request on later ticks; 429 with `Retry-After: 120` sets `next_attempt_at` ≥ now + 120 s; 400 fails with reason; pre-send `ECONNREFUSED` is retryable

**Checkpoint**: safety properties hold

---

## Phase 7: User Story 4 - Live validation in the composer (Priority: P2)

**Goal**: Bluesky count in graphemes plus byte, image count and size errors.

**Independent Test**: `pnpm vitest run src/providers/bluesky/validate.test.ts tests/integration/compose-check-route.test.ts`

- [ ] T042 [P] [US4] Implement `src/providers/bluesky/validate.ts` (`validateAgainstCapabilities` plus blocking `text_too_many_bytes` with count/limit) and `validate.test.ts`: 300 vs 301 graphemes from ZWJ families/skin tones/flags/combining marks, 3,000 vs 3,001 bytes, 4 vs 5 images, 2,000,000 vs 2,000,001 bytes, text-only valid, `empty_post`, unfixable image blocking error
- [ ] T043 [US4] Extend `tests/integration/compose-check-route.test.ts` with a Bluesky target (grapheme count, `text_too_long` at 301, `text_too_many_bytes` blocking in every gate, `too_many_images`, adaptation notes)

---

## Phase 8: User Story 5 - Sessions stay alive (Priority: P2)

**Goal**: refresh with rotation persisted, proactive and reactive, `needs_reauth` on refusal.

**Independent Test**: `pnpm vitest run src/providers/bluesky/session.test.ts tests/integration/bluesky/sessions.test.ts`

- [ ] T044 [US5] Implement `refreshCredentials` and `needsRefresh` in `src/providers/bluesky/session.ts` per contracts/bluesky.md §4 (DID mismatch definitive, definitive refusal rows, transient with `retryAt`, never throws, handle change → `displayName`) and wire them in `index.ts`
- [ ] T045 [US5] Extend `session.test.ts`: refresh success with rotation, DID mismatch, each definitive row, transient rows, `jwtExp`/`needsRefresh` edges (5-minute threshold, unparseable → false)
- [ ] T046 [US5] Write `tests/integration/bluesky/sessions.test.ts` through `runTick`/`runTokenRefresh`: proactive refresh persists rotated tokens and publishes with one refresh request; reactive `ExpiredToken` on create → retryable, refresh, next tick publishes with exactly one successful `createRecord`; refusal → `needs_reauth` with readable reason and next-tick `account_unavailable`; transient refresh → retryable and account stays active; handle change updates display name; scheduled section renews an idle account near refresh-JWT expiry; reconnect restores `active`

---

## Phase 9: Polish & Cross-Cutting

- [ ] T047 [P] Write `tests/integration/bluesky/no-secrets.test.ts`: for connect, refresh and every advance path, collect `accessJwt`, `refreshJwt` and the app password; assert absence from `publish_attempts`, `post_targets`, `social_accounts` (excluding `credentials_encrypted`), captured `console` output (`vi.spyOn`), action results and rendered HTML (FR-026, SC-007)
- [ ] T048 [P] Add the README section "Connecting a Bluesky account" (generic app-password wording, PDS field, what is/isn't stored, "Needs reconnecting", revoke in Bluesky) in `README.md`
- [ ] T049 [P] Update `docs/adding-a-provider.md`: §4 connectAccount, §6 stepFor content + `ctx.step`, §7 `credentialsExpired`, §9 `needsRefresh`/transient/displayName, new §13 Bluesky worked example (FR-029)
- [ ] T050 [P] Append "004 — Bluesky provider" to `docs/decisions.md` covering every item in plan.md implementation note 13 (FR-007, G1–G4 with what/why/reverse, `released` reuse, refresh recovery note, JPEG/PNG only, one image per step, PDS URL rules, `Retry-After` only with U1 NEEDS RESEARCH, "verified with mocks only", not using `CredentialSession`, mention transient vs unresolved)
- [ ] T051 Run the final gates and record real output: `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm db:check` (no drift, no migration; `tests/lint/worker-bundle.test.ts` and import-boundaries green)
- [ ] T052 Verify scope (SC-008) with `git diff --stat main -- . ':!src/providers/bluesky' ':!tests' ':!docs' ':!README.md' ':!specs'`; only the registry line and the generic G1–G4 files from plan.md may appear
- [ ] T053 Execute quickstart.md §1–§6 commands and note each as "verified with mocks only" in the `docs/decisions.md` entry
- [ ] T054 🛑 BLOCKED: needs a real Bluesky account and app password — owner performs the live check in quickstart.md §7 after merge and records "verified live on <date>" in `docs/decisions.md`

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 (blocks everything). Within Phase 2: T003 → T004 → (T005, T006, T007 parallel) → T008, T009 → T010; T011 → T012 → T013 → (T014, T015, T016); T017 independent of T011–T016 after T003.
- US1 (Phase 3) needs Phase 2 and T017. T019–T021 parallel → T022 → T023; T024 → T025 → T027; T026 parallel with T024.
- US2 needs US1 provider pieces (T019–T023). US3 builds on US2's `publish.ts`. US6 builds on US2/US3 `publish.ts` and the fake PDS. US4 (T042) is independent of publish and may run any time after T023. US5 needs T022 and Phase 2's engine work.
- Polish after all stories; T054 is owner-owned and never gates the run.

### Parallel opportunities

- Phase 2: T005, T006, T007 together; later T014, T015, T016, T017 together.
- US1: T019, T020, T021, T026; then T028, T029.
- US2: T031, T032 together. US4's T042 alongside US2.
- Polish: T047–T050 together.

## Implementation Strategy

### MVP first

Phase 1 → Phase 2 → US1 (connect) → US2 (text publish) → stop and validate: a connected account publishes a text post through the unchanged engine.

### Incremental delivery

Then US3 (images), US6 (safety outcomes), US4 (validation), US5 (sessions), then Polish. The framework fixes stay generic and are proven with a throwaway provider before Bluesky depends on them.

## Notes

- Do not use `CredentialSession`, `AtpAgent` or `agent.post()` (plan note 2). Call `createRecord` directly.
- Pass `ctx.signal` on every call. Build the agent per call so `vi.stubGlobal("fetch", …)` still intercepts.
- Store `blob.ipld()` in state, never the `BlobRef` instance.
- Commit per task or logical group with conventional commits and explicit paths.
