# Implementation Plan: Bluesky provider

**Branch**: `004-bluesky-provider` | **Date**: 2026-10-03 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/004-bluesky-provider/spec.md`

## Summary

Bluesky becomes Docket's first real provider. It lives in `src/providers/bluesky/` and is enabled by one registry line.

- **Connect**: a handle, an app password and an optional PDS URL (default `https://bsky.social`).
  - One `createSession` call.
  - The encrypted session `{ accessJwt, refreshJwt, did, handle }` is stored. The app password is **never** stored.
  - External id = DID, display name = handle, settings = `{ pdsUrl }`.
- **Validate**: the shared capability checks (300 graphemes, 4 images, 2,000,000 bytes, JPEG/PNG with conversion to JPEG), plus a 3,000-byte text check.
- **Publish**: a pure, total step machine.
  1. `resolve_mentions`, only when the text has mentions.
  2. `upload_image_<n>`, once per image, using the Bluesky variant from 003's pipeline.
  3. `create_post`, the only `mayPublish` step. It sends text, facets from the official `RichText` helper (unresolved mentions dropped) and an images embed with alt text and aspect ratio.
  - Success → `at://` URI and a bsky.app URL.
  - Timeouts, resets, unparseable 2xx and 5xx on `create_post` → `ambiguous`.
  - 429 → retryable, honouring `Retry-After`.
- **Sessions**: the stored expiry is the refresh JWT's `exp`, so 002's scheduled refresh renews idle accounts. The 120-minute access token is renewed on demand while publishing, serialised per account through the existing refresh lease, and persisted before use.

Reading the framework exposed **four generic gaps**. Each is fixed for every provider and recorded in `docs/decisions.md`. None needs a schema change.

- **G1, generic credential connect**: a `connectAccount` hook, richer `CredentialField`, and one service, one action and one form.
- **G2, publish-time refresh owned by the engine**:
  - proactive: `needsRefresh`;
  - reactive: `retryable_error.credentialsExpired`;
  - `refreshForPublish` on the shared refresh lease.
- **G3, refresh failures are no longer all-or-nothing**: `RefreshResult.transient`, and `displayName` for handle changes.
- **G4, `stepFor` sees the content shape**: `{ text, mediaCount }`, and `advance` sees the leased step. Without it, a text-only post would need two ticks.

## Technical Context

**Language/Version**: TypeScript 5 (strict, `noUncheckedIndexedAccess`) on Node 24 LTS (`>=24.10 <25`).

**Primary Dependencies**: all already installed (decision #19); nothing new.

- `@atproto/api` **0.22.0**, already in `package.json`. Its transitive dependencies are `@atproto/xrpc` 0.8.14, `@atproto/lexicon` 0.7.15 and `@atproto/lex-data` 0.1.7. Used: `Agent` (built from `FetchHandlerOptions`), `RichText`, `BlobRef`, `AtUri`, `XRPCError`. **Not** used: `CredentialSession` / `AtpAgent`, because they auto-refresh (research R3).
- zod 4.6.5.
- Next.js 16.3.8 (Server Actions, `refresh()`).
- drizzle-orm 0.45.3.
- Vitest 5.

**Storage**: PostgreSQL 17, with **no migration**. These existing columns are reused: `social_accounts.{settings, credentials_encrypted, credentials_expires_at, refresh_lease_owner, refresh_lease_until, display_name, last_error}` and `post_targets.{step_state, external_id, external_url}`. Images are read from the variant's public URL ([003 storage](../003-scheduler-ui-media/plan.md)).

**Testing**: Vitest against real Postgres (the 001–003 harness). New pieces:

- `tests/helpers/fake-pds.ts`: a scripted `fetch` stub. It returns status, headers and body, can hang until abort, reset mid-body, or fail before sending, and records requests.
- Provider unit tests under `src/providers/bluesky/`.
- Engine-level tests with a throwaway provider (`registerTestProvider`).
- End-to-end tests through the real `runTick`.

There are **no live calls** (FR-027).

**Target Platform**: the same `node:24-slim` image for `web` and `worker`. The worker bundle (esbuild) now includes `@atproto/api`, which is pure ESM with no native code.

**Project Type**: the single Next.js app. `src/providers` stays a leaf, and the engine lives in `src/server/scheduler`.

**Performance Goals**:

- A text-only post publishes in the first tick after it is due.
- An image post takes N + 1 ticks, plus one when it has mentions (SC-003).
- Each step is one bounded request batch within `SCHEDULER_PROVIDER_TIMEOUT_SECONDS` (default 10 s): one image of ≤ 2 MB, or at most one resolve per distinct mention.
- Connect does one sign-in within 15 s.

**Constraints**:

- No provider I/O inside a held transaction. Refresh runs outside transactions, under the account refresh lease.
- No session-level Postgres features (Neon pooler).
- No sleeps or polling in `advance`.
- No tokens or app password in the browser, logs, attempts, step state or messages (FR-026).
- `src/providers/**` imports nothing from `src/server/**`.

**Scale/Scope**:

- 1 provider folder, about 10 files.
- 4 generic framework fixes, about 8 files outside the folder.
- 1 new server action and 1 new client form.
- 0 migrations, 0 new env vars.

**Unknowns**:

- No `NEEDS CLARIFICATION` remains.
- R2 and R3 are settled from installed sources.
- **R1** (the Bluesky rate-limit reset header) cannot be settled offline. It is resolved as decision D3: honour `Retry-After`, otherwise use engine backoff. It is recorded as **NEEDS RESEARCH** for the `platform-researcher` follow-up (research U1).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design (below).*

| Principle | Status | How this plan complies |
|---|---|---|
| I. Verified facts over memory | ✅ | Platform limits come from `docs/research/bluesky.md`.<br>Library behaviour comes from the installed 0.22.0 source: R2 uses the library's own expiry and refusal rules; R3 records the positional `CredentialSession` constructor, auto-refresh, `XRPCError` mapping and `RichText`.<br>The one fact not available offline (R1) is marked NEEDS RESEARCH with a safe fallback. It is not guessed.<br>Bluesky UI wording (where app passwords are created) is kept generic, because it is unverified. |
| II. Nothing is "working" unless it ran | ✅ | Every path is covered by mocked-HTTP tests. Live publishing is reported as "verified with mocks only" (quickstart §7 is for the owner). |
| III. Project isolation | ✅ | New DAL methods (`acquireRefreshLease`, `contentShape`) filter on `project_id` and are reachable only through `forSchedulerProject`. The connect service uses `ProjectScope` with `manage` checked on the server before any network call. The authorization table and `scope-check` tests are extended. |
| IV. One service layer | ✅ | One connect service (`connectWithCredentials`) for every credential provider. One refresh core (`applyRefreshResult`) shared by the scheduled section and publish-time refresh. The UI calls the service through one action. |
| V. Providers are plug-ins | ⚠️ justified | Bluesky is one folder plus one registry line. The **framework** changes (G1–G4) touch the scheduler and the accounts screen, and the spec explicitly classes them as framework defects to be fixed generically. They are optional or additive, and the mock and test providers keep working. There is no schema change. Each is recorded in `docs/decisions.md`. See Complexity Tracking. The ambiguous-never-retried rule is untouched. |
| VI. Boring, few dependencies | ✅ | No new dependency. `@atproto/api` was pre-installed for this purpose. |
| VII. Secrets never leak | ✅ | The app password exists only in the sign-in request. Tokens exist only in the encrypted column and in request headers. Summaries carry only counts, status and the error name (D19). Field values are never echoed. `redact()` remains the backstop. Secret-absence assertions run on every path (FR-026, SC-007). |
| Eng. constraints | ✅ | `runTick` stays bounded: refresh before and after `advance` each fits the deadline, or the target is released. Leases are reused. There is no session-level locking and no provider call in a transaction. The UI follows `docket-ui`: a server page with a client leaf form, labelled fields, an alert for errors and a live region for success. |
| Workflow | ✅ | Conventional commits with explicit paths. Gates: lint, typecheck, test and build (the worker bundle changes). `db:check` must show no drift. README, `docs/adding-a-provider.md` and `docs/decisions.md` are deliverables (FR-028–FR-030). |

**Gate result: PASS.** The principle V deviation is justified below.

### Post-design re-check (after Phase 1)

Re-evaluated against [data-model.md](./data-model.md) and [contracts/](./contracts/):

- **Duplicates impossible on refresh**:
  - an expired-token rejection proves no write (the library's own replay rule, R2);
  - refresh runs outside `advance`;
  - lease recovery on a `mayPublish` step stays conservative (`recovered_ambiguous`).
- **Rotation never lost**:
  - persist-then-use under the lease token;
  - a lease lost before persisting → transient, and the new credentials are discarded. The platform's rotation grace period covers the old token ([docs] "refresh tokens rotate (grace period)").
- **No deadlock**:
  - the account refresh lease is one conditional `UPDATE` with no transaction held;
  - the claim's `FOR NO KEY UPDATE SKIP LOCKED` on accounts and the scheduled section's `FOR UPDATE SKIP LOCKED` never wait;
  - no path locks a target and then an account.
- **Content-aware `stepFor`** is a DB read inside the claim transaction, with no provider I/O. `ctx.step` lets the provider refuse a mismatched step without sending anything.
- **No schema or enum change**: the `released` outcome is reused, and `credentials_expires_at` holds the refresh expiry.
- **Secrets**: the step state holds only DIDs, blob CIDs, MIME types and sizes.

**PASS.**

## Project Structure

### Documentation (this feature)

```text
specs/004-bluesky-provider/
├── plan.md              # This file
├── research.md          # Phase 0: R1–R3, G1–G4, decisions D1–D23, unverified U1–U3
├── data-model.md        # Phase 1: account/settings/credentials/state shapes, step table, type and DAL changes
├── quickstart.md        # Phase 1: validation scenarios + owner's live check
├── contracts/
│   ├── providers.md     # framework contract changes G1–G4, registry invariants
│   ├── bluesky.md       # the provider: declarations, validate, connect/refresh, advance + outcome table, tests
│   ├── scheduler.md     # engine: contentShape, refreshForPublish, applyRefreshResult, tests
│   └── accounts.md      # connectWithCredentials, connectCredentialsAction, ConnectCredentialsForm, tests
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
src/providers/
├── types.ts                     # G1 CredentialField.optional/defaultValue/placeholder, ConnectResult, connectAccount?
│                                # G2 needsRefresh?, retryable_error.credentialsExpired?
│                                # G3 RefreshResult.transient/retryAt/displayName
│                                # G4 StepContent, stepFor(state, settings, content), PublishContext.step
├── registry.ts                  # + blueskyProvider (the one line)
├── registry.test.ts             # + G1/G2/G4 invariants
├── mock/index.ts                # stepFor signature only (ignores content); behaviour unchanged
└── bluesky/                     # NEW — contracts/bluesky.md §1
    ├── index.ts  settings.ts  client.ts  session.ts  steps.ts  facets.ts  publish.ts  errors.ts  validate.ts
    └── validate.test.ts  facets.test.ts  steps.test.ts  session.test.ts  publish.test.ts  errors.test.ts

src/server/
├── dal/accounts.ts              # + acquireRefreshLease; RefreshPatch.displayName
├── dal/scheduler.ts             # + ClaimContext.contentShape
├── scheduler/publishing.ts      # stepFor(…, content); ctx.step; fatal on missing post; proactive/reactive refresh; release()
├── scheduler/credentials.ts     # NEW refreshForPublish, applyRefreshResult
├── scheduler/token-refresh.ts   # delegates to applyRefreshResult; transient keeps account active
└── services/accounts.ts         # + connectWithCredentials; listConnectableProviders.credentialConnect

src/app/p/[projectSlug]/accounts/
├── actions.ts                   # + connectCredentialsAction
├── page.tsx                     # + connect section per credential provider; reconnect in needs_reauth cards
└── ConnectCredentialsForm.tsx   # NEW generic client form

tests/
├── helpers/fake-pds.ts          # NEW scripted fetch stub (+ request log)
└── integration/
    ├── bluesky/{publish-e2e,images,ambiguous,sessions,no-secrets}.test.ts            # NEW, real runTick
    ├── scheduler/{step-content,publish-refresh,refresh-concurrency}.test.ts          # NEW, throwaway provider
    ├── scheduler/refresh.test.ts                                                     # + transient, displayName
    ├── accounts-credentials-connect.test.ts                                          # NEW
    └── accounts-ui, actions-authz, compose-check-route, no-plaintext .test.ts       # extended

README.md                        # + "Connecting a Bluesky account" (FR-028)
docs/adding-a-provider.md        # §4 connectAccount; §6 stepFor content + ctx.step; §7 credentialsExpired;
                                 # §9 needsRefresh, transient, displayName; §13 Bluesky worked example (FR-029)
docs/decisions.md                # + "004 — Bluesky provider" (FR-030)
```

**Structure Decision**: this is the same single Next.js app with 002/003 layering.

- Everything Bluesky-specific is under `src/providers/bluesky/`.
- The engine changes live in `src/server/scheduler/`, with a new `credentials.ts` so `publishing.ts` does not grow a second responsibility.
- The DAL additions sit next to `recordRefresh` and `claimDueTargets`.
- The UI change is one generic form and one action beside the existing accounts screen.

## Implementation notes for the tasks phase

These are ordering and risk notes, not tasks.

1. **Order**:
   1. Framework types (G1–G4), with the mock signature and the registry invariants. Typecheck the whole repo here, because `stepFor`'s new parameter must compile everywhere.
   2. DAL: `contentShape`, `acquireRefreshLease`, `RefreshPatch.displayName`.
   3. Engine: G4 in `publishing.ts` (content shape, `ctx.step`, missing post → fatal), with `step-content.test.ts`.
   4. `credentials.ts` (`applyRefreshResult`, `refreshForPublish`), the `token-refresh.ts` delegation (G3), and the proactive and reactive hooks in `execute`. Add the `publish-refresh`, `refresh` and `refresh-concurrency` tests, all with a throwaway provider, **before** Bluesky exists.
   5. `tests/helpers/fake-pds.ts`.
   6. The Bluesky provider, test-first, in this order: `settings` → `errors` → `validate` → `facets` → `steps` → `session` → `publish` → `index`. Then the registry line.
   7. The connect service, action and form (G1), with the connect, UI and authz tests.
   8. Bluesky end-to-end tests through `runTick`.
   9. Docs and decisions.
   10. Final gates.
2. **Do not use `CredentialSession`, `AtpAgent` or `agent.post()`.** `post()` needs `sessionManager.did`. Call `agent.com.atproto.repo.createRecord({ repo: did, collection: "app.bsky.feed.post", record })` directly. The constructor shape in the installed version is positional (R3). It does not matter here, but do not copy the doc comment.
3. **`fetch` capture.** Build the agent per call with `fetch: (i, o) => globalThis.fetch(i, o)`, so `vi.stubGlobal("fetch", …)` installed after module import still intercepts. Pass `ctx.signal` on **every** call; the fake PDS's "hang" mode relies on it.
4. **Classifying "reset" vs "pre-send".** Both reach the provider as `XRPCError` with status `Unknown` (1) and the original error as `cause`. Walk `cause` (bounded depth) for `code ∈ {ECONNREFUSED, ENOTFOUND, EAI_AGAIN}`. Only those are pre-send. The fake PDS must throw `new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }) })` for pre-send, and return a `Response` whose body stream errors for reset.
5. **Unparseable 2xx.** A 2xx with a non-JSON body surfaces as status `Unknown` (the parse failure is the cause). A JSON body missing `uri` surfaces as `XRPCInvalidResponseError`. Both are `ambiguous` on `create_post`. Test both.
6. **`RichText` mention `did` holds the handle** after `detectFacetsWithoutResolution()`. Normalise it (lower-case) before looking it up in `state.mentions`. Use the facet's `features` type guard (`AppBskyRichtextFacet.isMention`) rather than string-matching `$type`.
7. **Blob refs in state.** Store `blob.ipld()` (plain JSON) and rebuild with `BlobRef.fromJsonRef` when creating the post. Never store the class instance, because jsonb would lose the CID type.
8. **Proactive refresh threshold** is 5 min before the access JWT's `exp`. An idle account's access token is always expired at publish time, so the proactive path is the **common** one. The reactive path is the backstop. Make sure the e2e tests cover both.
9. **Lease recovery during refresh.** A process killed mid-refresh on a `mayPublish` step yields `recovered_ambiguous` (002 rule, unchanged). Record it next to 003's media-resolution note as an accepted outcome. Do not weaken the rule.
10. **Concurrency test.** Use separate pool connections (002 note 4). Make the fake PDS's refresh endpoint slow (await a latch), so that the races genuinely overlap. Loop 20×.
11. **Secret assertions.** Collect `accessJwt`, `refreshJwt` and the app password used in each test. Assert their absence from:
    - a dump of `publish_attempts`, `post_targets` and `social_accounts` (excluding `credentials_encrypted`);
    - `console` output captured with `vi.spyOn`;
    - action results and rendered HTML.
12. **`text_too_many_bytes`** must be blocking in every gate. The existing gates filter on `severity === "error"`, so no gate change is needed. Confirm it with the compose-check test.
13. **Decisions log (FR-030).** Append "004 — Bluesky provider", with at least:
    - FR-007 (app password never stored);
    - G1, G2, G3 and G4, each with what, why and how to reverse;
    - `released` reused for refresh busy / flagged;
    - the publish-time refresh recovery note (note 9);
    - JPEG/PNG only;
    - one image per step and its tick cost;
    - the PDS URL rules and not following didDoc;
    - `Retry-After` only, with Bluesky headers NEEDS RESEARCH (U1);
    - "verified with mocks only" for live publishing;
    - not using `CredentialSession` and why;
    - mention lookups being transient vs unresolved.
14. **Docs.**
    - **README "Connecting a Bluesky account"**: what an app password is, and that you create it in your Bluesky settings (keep the wording generic, because the exact menu path is unverified). Also cover:
      - the PDS field for self-hosted servers;
      - what is stored (the session tokens, DID and handle, encrypted) and what is not (the app password);
      - what "Needs reconnecting" means (Bluesky refused to renew the session, so enter an app password again);
      - that removing the account deletes the tokens, but revoking the app password is done in Bluesky.
    - **`docs/adding-a-provider.md`**: the sections listed in the source tree above, plus a §13 Bluesky worked example covering the connect exchange, publish-time refresh, the multi-step image flow, the outcome table and the dual text limit.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Constitution V ("no changes to the scheduler, composer or schema"): **G2, G4** touch `src/server/scheduler/publishing.ts`, and **G1** adds a generic connect path to the accounts service and screen | The spec (§ "Framework gaps") classes these as framework defects: there is no generic credential connect (G1); rotated refresh tokens cannot be persisted from a publish (G2); every refresh failure is fatal (G3); and `stepFor` cannot see whether a post has images or mentions (G4), so SC-003 and FR-013 cannot both hold. Every change is generic, optional or additive. The mock still works. There is no schema or enum change. Each is recorded in `docs/decisions.md` with how to reverse it | **A Bluesky-only path** in the scheduler or UI breaks V outright and FR-002. **Letting `@atproto/api` refresh inside `advance`**: unserialised, the rotated token is not persisted (account lockout), and it runs inside the may-publish step (R3, FR-023). **Always running a non-publishing first step**: a text-only post would take 2 ticks (SC-003). **Marking the first step `mayPublish`** when it only uploads or resolves: false `ambiguous` on crashes (US2-AS4, FR-013). **Same-tick continuation**: a larger engine change to tick, lease and attempt semantics |
