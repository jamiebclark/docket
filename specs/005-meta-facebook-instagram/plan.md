# Implementation Plan: Facebook Pages and Instagram providers (Meta, part 1)

**Branch**: `005-meta-facebook-instagram` | **Date**: 2026-10-03 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/005-meta-facebook-instagram/spec.md`

## Summary

Docket gains its first OAuth providers, `facebook` and `instagram`. One Facebook Login for Business connect flow covers both: a Page and its linked Instagram professional account are offered together and chosen in one step.

- **Shared Meta module** (`src/providers/meta/`, not a provider). It is parameterised by a `MetaApp`, so the Threads entry can reuse it. It contains:
  - env parsing (`META_APP_ID`, `META_APP_SECRET`, `META_GRAPH_VERSION` default `v26.0`, optional `META_LOGIN_CONFIG_ID`);
  - a one-`fetch` Graph client with typed outcomes;
  - **one** error-classification table (190 → credentials invalid; rate-limit and temporary codes as interim lists);
  - the login dialog URL, the code exchange and the long-lived exchange;
  - the Pages listing → candidates;
  - the `meta` connect group;
  - the token-paste exchange.
- **Facebook**:
  - text and link posts are one `mayPublish` feed request (the first URL becomes `link`);
  - a single photo is one `mayPublish` photos request;
  - N photos are N non-publishing unpublished-photo uploads, then one feed post with `attached_media` (**U1, mocks only**);
  - each account stores only a non-expiring Page token.
- **Instagram**: a pure, total step machine, one request per tick:
  1. create the item and carousel containers from the JPEG variant URLs, with `alt_text` and the caption;
  2. `check_status` repeatedly via `continue` + `notBefore` (10 s doubling to 5 min, 60-minute cap; `ERROR` → fatal, `EXPIRED` → recreate at most twice, `PUBLISHED` → ambiguous);
  3. `check_quota` against `content_publishing_limit` (full → retry in 1 h; unreadable → proceed on Docket's own 100/24 h counter);
  4. one `mayPublish` `media_publish`, where timeouts, resets, 5xx and unparseable replies are `ambiguous`.
- **Docs**: `docs/meta-setup.md` (dashboard steps, local options), a README section, the `docs/adding-a-provider.md` OAuth pattern and an Instagram worked example, and the `docs/decisions.md` entries.

Reading the framework exposed **four generic gaps**, numbered after 004's G1–G4. Each is fixed for every provider and recorded in `docs/decisions.md`:

- **G5 — generic OAuth connect**:
  - connect groups shared by several providers;
  - a candidate list;
  - one fixed callback `/connect/callback`;
  - a generic chooser page;
  - a new project-owned **`connect_attempts`** table (hashed single-use state bound to user + session + project, candidates encrypted, 10-minute life). This is the one schema change, justified in research D4 and Complexity Tracking.
- **G6 — paste a token → candidates**: `OAuthConnectGroup.pasteToken`.
- **G7 — credentials invalid**: `fatal_error.credentialsInvalid` makes the engine flag the account `needs_reauth`, conditionally on the ciphertext it used. There is no retry and no ambiguity.
- **G8 — provider-declared environment**: a connect group declares and validates its env vars. Startup merges those issues with the core env issues, so no `META_*` lands in `src/server/env.ts`.

The scheduler's claim, lease, backoff, limits, recovery and refresh logic is unchanged. The composer is unchanged.

## Technical Context

**Language/Version**: TypeScript 5 (strict) on Node 24 LTS (`>=24.10 <25`).

**Primary Dependencies**: all already installed (decision #19). **Nothing new.**

- Platform `fetch` (undici, Node 24) for Graph. No Meta SDK.
- zod 4.6.5.
- Next.js 16.3.8: Route Handlers for `/connect/callback` (`03-file-conventions/route.md`); `redirect()` to an absolute external URL from a Server Action (`04-functions/redirect.md`); `refresh()`.
- drizzle-orm 0.45.3 / drizzle-kit 0.31.11 for one migration.
- Vitest 5.
- `node:crypto` for the state and its SHA-256.

**Storage**: PostgreSQL 17.

- **One new migration** (`drizzle/0003_*.sql`, generated with `pnpm db:generate`) adds `connect_attempts` ([data-model §1](./data-model.md)).
- These existing columns are reused: `social_accounts.{credentials_encrypted, credentials_expires_at (null), settings, status, last_error}` and `post_targets.{step_state, external_id, external_url (null)}`.
- Media is read from the provider variant's public URL ([003 storage](../003-scheduler-ui-media/plan.md)). Meta fetches it, so a public bucket is required.

**Testing**: Vitest against real Postgres (the 001–004 harness).

- New `tests/helpers/fake-graph.ts`: a scripted `fetch` stub keyed by method + path, with a request log, hang-until-abort, reset mid-body and pre-send failure.
- Provider unit tests live beside the code.
- Engine tests use a throwaway provider for G5 and G7.
- End-to-end tests go through the real `runTick`.
- There are **no live calls** (FR-035).

**Target Platform**: the same `node:24-slim` image for `web` and `worker`. The worker bundle gains only pure TypeScript (no native code).

**Project Type**: the single Next.js app.

- `src/providers/**` stays a leaf (the lint rule bans `src/server/**` imports).
- Engine code lives in `src/server/scheduler/`.
- The service is in `src/server/services/connect.ts`, and data access in `src/server/dal/connect-attempts.ts`.

**Performance Goals** (SC-004 / SC-005):

- Every step makes at most **one** platform request, bounded by `SCHEDULER_PROVIDER_TIMEOUT_SECONDS` (default 10 s).
- Facebook text or a single photo publishes in 1 tick, and N photos in N + 1.
- An Instagram single image takes 4 ticks when the container is ready at the first check, and a carousel N + 4.
- Connect does at most 2 exchanges + ≤ 5 listing pages, each within the 15 s connect timeout.

**Constraints**:

- No provider I/O inside a transaction. Exchanges run outside, and the chooser transaction does only DB work.
- No session-level Postgres features (Neon pooler).
- No sleeps or loops in `advance`.
- Tokens, the app secret and codes never reach the browser, logs, attempts, step state, messages or URLs that Docket builds for the browser (FR-034).
- The state is single-use under concurrency (a conditional `UPDATE … RETURNING`).

**Scale/Scope**:

- 3 new folders under `src/providers/` (`meta`, `facebook`, `instagram`), about 20 source files.
- 4 generic fixes (G5–G8).
- 1 table and 1 migration.
- 1 route handler, 2 pages and 3 Server Actions.
- 4 env vars.
- Candidates are capped at 500 Pages per login (R9).

**Unknowns**: no `NEEDS CLARIFICATION` remains.

- The spec's R1–R6 and this plan's R7–R10 cannot be verified offline. Each is resolved as an **interim decision** in [research.md §1](./research.md): one constant, covered by mocks, and recorded in `docs/decisions.md` as unverified. This is the treatment the spec prescribes.
- U1 (multi-photo), U2 (localhost redirect) and U3 (all live behaviour) are reported as unverified or "verified with mocks only".

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design (below).*

| Principle | Status | How this plan complies |
|---|---|---|
| I. Verified facts over memory | ✅ | Endpoints, scopes, limits, token rules and container statuses come from `docs/research/meta.md`. Next.js usage comes from the bundled docs. Everything missing from the research (dialog URL, code exchange, error codes, text limits, quota fields, paging, encoding) is listed as R1–R10 with a conservative interim value in one constant and a mocked test. It is never presented as verified. |
| II. Nothing is "working" unless it ran | ✅ | Every path is covered by mocked-HTTP tests. Live connect and publishing, U1 and U2 are reported as "verified with mocks only" or "unverified". Quickstart §8 is the owner's live check. |
| III. Project isolation | ✅ | `connect_attempts` carries `project_id` and is registered in `projectOwnedTables`. Every repo method is project-pinned except two cross-project statements: the state-hash lookup and the purge, both with an explicit `crossProject` reason, mirroring invitation tokens. Roles (`account:manage`) are checked on the server at start, callback, paste, chooser and choose. The authz table and scope-check tests are extended. |
| IV. One service layer | ✅ | One connect service (`services/connect.ts`) serves every OAuth group and the paste fallback. The chooser saves through the same upsert as `saveConnectedAccount` (`saveConnectedAccountTx`). |
| V. Providers are plug-ins | ⚠️ justified | Facebook and Instagram are each one folder plus one registry line. The shared Meta code is a non-registered module under `src/providers/`. G5–G8 are generic framework fixes, which the spec explicitly classes as defects. G5 needs one **generic** table, the only schema change. See Complexity Tracking. The ambiguous-never-retried rule is untouched, and G7 only ever yields `fatal_error`. |
| VI. Boring, few dependencies | ✅ | No new dependency. Platform `fetch` and `node:crypto` only. No queue, cache or Redis: the connect state lives in Postgres. |
| VII. Secrets never leak | ✅ | Tokens and codes exist only in outgoing request bodies and queries and in two AES-256-GCM columns (with AAD bound to the row id). The state is stored hashed. Messages are scrubbed. Summaries use an allow-list of keys. The pasted and user tokens are never stored (FR-012). A dedicated no-secrets test covers connect, callback, paste, the chooser HTML and every advance path. The env vars are Zod-validated at startup (G8) and documented in `.env.example`. |
| Eng. constraints | ✅ | `runTick` stays bounded: one request per step, `continue` + `notBefore` instead of polling. No provider call happens inside a transaction. The UI follows `docket-ui`: server pages, client leaf forms, labelled checkboxes in fieldsets, alert-role messages, and keyboard-operable controls. Video, reels, stories and Threads stay out of scope. |
| Workflow | ✅ | Conventional commits with explicit paths. Gates: lint, typecheck, test, build (route and worker changes), and `pnpm db:check` (new migration). README, `docs/meta-setup.md`, `docs/adding-a-provider.md` and `docs/decisions.md` are deliverables (FR-036–FR-040). |

**Gate result: PASS.** The principle V deviation is justified below.

### Post-design re-check (after Phase 1)

Re-evaluated against [data-model.md](./data-model.md) and [contracts/](./contracts/):

- **Duplicate safety**:
  - The only `mayPublish` steps are Facebook `publish_feed` / `publish_photo` and Instagram `publish`.
  - Lease recovery on them stays `recovered_ambiguous` (002, unchanged).
  - Rate-limit codes are retryable on those steps only because a rate-limited request is refused, never partly executed.
  - Temporary codes, 5xx, unparseable replies and resets on those steps are `ambiguous`.
  - Instagram containers are recreated only before any publish request (`EXPIRED` at status check, or the 23 h age guard at the quota step). After `media_publish` was sent, the outcome is `done`, `fatal_error` or `ambiguous`, never a recreation.
  - `PUBLISHED` seen before our publish → `ambiguous`.
- **Single-use state under races**:
  - Two concurrent callbacks with one state: only one wins the conditional `UPDATE`, and the other is refused before any exchange.
  - Two concurrent chooser submits: the row lock plus `completed_at IS NULL` mean only the first saves.
  - This is tested with parallel requests on separate pool connections, 20× in a loop.
- **Lock order**:
  - The chooser transaction locks `connect_attempts`, then upserts `social_accounts`.
  - No other path locks `social_accounts` and then `connect_attempts`.
  - `markCredentialsInvalid` is one conditional `UPDATE` with no transaction held.
  - There is no deadlock cycle.
- **Stale reads (READ COMMITTED)**:
  - `markCredentialsInvalid` compares the ciphertext the step used, so a reconnect committed meanwhile is never overwritten to `needs_reauth`.
  - The callback re-resolves membership after the binding check (a demoted user gets `not_allowed`).
- **Time**:
  - `expires_at`, `notBefore` and the polling and age caps are computed from the DB clock (`ctx.now` / `clock.now()`), stored in UTC.
  - No wall-clock or DST maths is involved.
- **No scheduler, composer or enum change** beyond G7's flag handling in `execute`. The claim's `status !== 'active'` rule already stops other targets.

**PASS.**

## Project Structure

### Documentation (this feature)

```text
specs/005-meta-facebook-instagram/
├── plan.md              # This file
├── research.md          # Phase 0: R1–R10 interim decisions, D1–D18, unverified U1–U3
├── data-model.md        # Phase 1: connect_attempts, account/credential shapes, candidate, step states, summaries
├── quickstart.md        # Phase 1: mocked validation scenarios + owner's live check
├── contracts/
│   ├── providers.md     # G5–G8 types, registry helpers and invariants
│   ├── connect.md       # connect service, callback route, chooser page, actions, messages, authz matrix
│   ├── meta.md          # shared Meta module: config, graph client, error table, oauth, candidates, group
│   ├── facebook.md      # facebook provider: capabilities, steps, requests, results
│   ├── instagram.md     # instagram provider: capabilities, validation, steps, requests, timing constants
│   └── scheduler.md     # G7 engine + DAL change and its tests
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
src/providers/
├── types.ts                     # G5 OAuthConnectGroup, ConnectCandidate, CandidatesResult, oauth strategy carries group
│                                # G6 pasteToken; G7 fatal_error.credentialsInvalid; G8 ProviderEnvIssue/environment
├── registry.ts                  # + facebookProvider, instagramProvider (one line each); listConnectGroups/findConnectGroup
├── registry.test.ts             # + group invariants, env vars documented in .env.example
├── meta/                        # NEW shared module (not registered) — contracts/meta.md
│   ├── config.ts  graph.ts  errors.ts  oauth.ts  candidates.ts  credentials.ts  connect-group.ts
│   └── config.test.ts  graph.test.ts  errors.test.ts  oauth.test.ts  candidates.test.ts
├── facebook/                    # NEW — contracts/facebook.md
│   ├── index.ts  capabilities.ts  settings.ts  steps.ts  links.ts  publish.ts  validate.ts
│   └── steps.test.ts  links.test.ts  publish.test.ts  validate.test.ts
└── instagram/                   # NEW — contracts/instagram.md
    ├── index.ts  capabilities.ts  settings.ts  state.ts  steps.ts  quota.ts  publish.ts  validate.ts
    └── steps.test.ts  publish.test.ts  quota.test.ts  validate.test.ts

src/server/
├── db/schema/connect.ts         # NEW connect_attempts table (+ export from schema/index.ts)
├── db/project-owned.ts          # + { table: "connect_attempts", scopeColumn: "project_id" }
├── dal/connect-attempts.ts      # NEW repo (project-pinned + two crossProject statements)
├── dal/scope.ts                 # + scope.connectAttempts
├── dal/accounts.ts              # + markCredentialsInvalid (G7)
├── provider-env.ts              # NEW G8: providerEnvIssues, isGroupConfigured
├── startup/index.ts             # merge providerEnvIssues into the startup error
├── scheduler/publishing.ts      # G7: credentialsInvalid → "Reconnect … to publish" + markCredentialsInvalid
└── services/
    ├── connect.ts               # NEW G5/G6: listConnectGroups, startOAuthConnect, handleOAuthCallback,
    │                            #   pasteConnectToken, getConnectChoice, chooseConnectCandidates
    └── accounts.ts              # saveConnectedAccountTx extracted; oauth providers excluded from credential list

src/app/
├── connect/callback/route.ts    # NEW GET → handleOAuthCallback → redirect
├── connect/invalid/page.tsx     # NEW "expired or not valid" page
└── p/[projectSlug]/accounts/
    ├── actions.ts               # + startOAuthConnectAction, pasteConnectTokenAction, chooseConnectCandidatesAction
    ├── page.tsx                 # + one section per connect group, not-configured state, ?connect= banner, reconnect
    ├── ConnectGroupSection.tsx  # NEW start button + paste form (client leaf)
    └── connect/[attemptId]/
        ├── page.tsx             # NEW chooser (server)
        └── ChooserForm.tsx      # NEW nested checkboxes (client leaf)

drizzle/0003_<generated>.sql     # NEW migration (+ meta snapshot/journal)
.env.example                     # + META_APP_ID, META_APP_SECRET, META_GRAPH_VERSION, META_LOGIN_CONFIG_ID

tests/
├── helpers/fake-graph.ts        # NEW scripted Graph fetch stub
└── integration/
    ├── connect/{oauth-flow,state-security,paste,chooser-ui,choose-race}.test.ts   # NEW, throwaway group + meta group
    ├── scheduler/credentials-invalid.test.ts                                       # NEW, throwaway provider (G7)
    ├── facebook/{publish-e2e,multi-photo,outcomes}.test.ts                         # NEW, real runTick
    ├── instagram/{publish-e2e,carousel,container-status,quota,limits,outcomes}.test.ts  # NEW, real runTick
    ├── meta/{no-secrets,engine-unchanged}.test.ts                                  # NEW
    └── accounts-ui, actions-authz, compose-check-route, no-plaintext, scope-check .test.ts  # extended
src/server/startup/startup.test.ts                                                  # + G8 merge

README.md                        # + "Connecting Facebook Pages and Instagram" (FR-038)
docs/meta-setup.md               # NEW (FR-036, FR-037)
docs/adding-a-provider.md        # §4 OAuth groups/candidates/paste/env; §7 credentialsInvalid; §14 Instagram worked example (FR-039)
docs/decisions.md                # + "005 — Facebook Pages and Instagram" (FR-040)
```

**Structure Decision**: this is the same single Next.js app with the 002–004 layering.

- Platform code lives under `src/providers/{meta,facebook,instagram}/`.
- The generic connect machinery is split by layer:
  - DAL: `dal/connect-attempts.ts`;
  - service: `services/connect.ts`;
  - route and pages: `app/connect/*` and `app/p/[projectSlug]/accounts/connect/*`.
- The engine change is confined to G7 handling in `scheduler/publishing.ts` plus one DAL method.

## Implementation notes for the tasks phase

These are ordering and risk notes, not tasks.

1. **Order** (matches the spec's required order: shared Meta module → Facebook → Instagram → meta-setup):
   1. Framework types G5–G8, then the registry helpers and invariants. Typecheck the whole repo here: the `oauth` strategy shape changes, and `accounts/page.tsx` filters on it.
   2. The `connect_attempts` schema and migration (`pnpm db:generate`, then `pnpm db:check`), `projectOwnedTables`, and the DAL repo with the scope-check test.
   3. `provider-env.ts` and the startup merge (G8), with tests.
   4. The G7 DAL method and engine handling, with `credentials-invalid.test.ts` (throwaway provider) **before** any Meta code exists.
   5. The connect service, route, pages and actions (G5/G6) with a **throwaway two-provider group**: `oauth-flow`, `state-security`, `paste`, `choose-race`, the authz rows and `chooser-ui`.
   6. `tests/helpers/fake-graph.ts`.
   7. The shared Meta module, test-first: `config` → `errors` → `graph` → `oauth` → `candidates` → `connect-group`.
   8. The Facebook provider, test-first, then its registry line and e2e.
   9. The Instagram provider, test-first (`state` → `steps` → `quota` → `publish` → `validate`), then its registry line, e2e, limits, and the no-secrets and engine-unchanged tests.
   10. Docs: `meta-setup.md`, the README, `adding-a-provider.md`, `decisions.md` and `.env.example`.
   11. Final gates.
2. **`fetch` capture.** Call `globalThis.fetch` at request time, never a captured reference, so `vi.stubGlobal` set up after import still intercepts. Pass `ctx.signal` (or the connect timeout signal) on **every** call.
3. **Pre-send vs reset.** The fake must throw `new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }) })` for pre-send. For reset, it returns a `Response` whose body stream errors. Only `ECONNREFUSED`, `ENOTFOUND` and `EAI_AGAIN` in the cause chain are pre-send. An `AbortError` or `TimeoutError` is after-send.
4. **POST encoding.** Use `new URLSearchParams(params)` as the body, with the `content-type: application/x-www-form-urlencoded` header, and `access_token` in the body. GETs append to the query. Never log `request.url`. Tests assert the token is absent from every recorded URL **for POSTs**.
5. **Callback ordering** (research D5) is the security core. Test each refused case asserting **zero** fake-graph calls:
   1. shape;
   2. lookup;
   3. expiry and reuse;
   4. user and session binding;
   5. role;
   6. conditional consume;
   7. only then the exchange.

   The callback must treat `error`/`error_reason` query params (a cancelled login) after a successful consume, so the state cannot be reused.
6. **Chooser transaction.** Lock the attempt `FOR UPDATE`, re-check user, session, expiry and `completed_at IS NULL`, upsert each chosen account with `saveConnectedAccountTx`, then `complete()`. Any thrown error rolls everything back. A unique-violation race with a concurrent connect of the same Page retries once, as `connectWithCredentials` does.
7. **Candidate ciphertext AAD** is `connect_attempt:<id>`. Paste attempts insert first, then store the ciphertext in the same transaction. Before encrypting, cap the candidates at 500 and the ciphertext at 1 MB.
8. **G7 message.** The engine composes `Reconnect <name> to publish: <reason>`. The provider's own error should therefore read as a reason ("Facebook says the access token is no longer valid (code 190/460)."), not as an instruction.
9. **Instagram timing.** `notBefore` = `ctx.now` + the delay. The engine already uses `max(now, notBefore)`. Tests advance the DB clock (`tests/helpers/clock.ts`) between ticks rather than sleeping. The 60-minute cap and 23 h age use `state.createdAt`, which is reset on recreation. The engine's own `PUBLISH_MAX_DURATION_HOURS` (default 24 h from the first step) still applies on top. Note in `decisions.md` that with the default it usually fires before the 23 h guard.
10. **Quota retries count attempts.** `retryable_error` increments `attempt_count`, so `PUBLISH_MAX_ATTEMPTS` (default 5) quota refusals in a row fail the target. That is accepted and recorded: Docket's own counter defers its own posts before they start, so a full platform quota means other tools are also posting.
11. **Instagram `validate` rename.** Map the shared `text_only_not_allowed` to `media_required` (keeping the `postType` field), and leave every other shared issue as is. The composer's per-target issue list must show exactly one blocking issue for an Instagram target with no image. Assert this in `compose-check-route.test.ts`.
12. **Accounts screen.** Oauth providers must not appear in the credential-form list (`connect.strategy !== "oauth"` is already the filter). Each group renders once, even though two providers reference it. The "not configured" state shows `CopyField` with the redirect URI and the doc path as text (not a link to a repo file). For a `needs_reauth` Facebook or Instagram account, the card offers "Reconnect with Facebook" (start) and the paste form.
13. **No-secrets test** (SC-007). Use distinctive fake values (`EAAG-fake-user-…`, `EAAG-fake-page-…`, the app secret, `code-fake-…`, the pasted token). Dump `publish_attempts`, `post_targets`, `social_accounts` minus `credentials_encrypted`, and `connect_attempts` minus `candidates_encrypted`. Capture `console.*` and the chooser HTML (rendered server component) and grep all of them.
14. **Decisions log (FR-040).** Append "005 — Facebook Pages and Instagram" with:
    - FR-012 (no user token stored);
    - G5 (including the `connect_attempts` table: what, why, reverse);
    - G6, G7 and G8;
    - R1–R10 interim values as unverified;
    - the first-URL-as-link rule;
    - images taking precedence over the link;
    - the polling cadence and 60-minute cap;
    - the recreation rule and cap of 2, plus the 23 h age guard;
    - quota retry at +1 h and the attempt-cap note;
    - no post URLs (R5);
    - the Instagram display name (R8);
    - purging expired attempts on connect traffic (D9) and its limit;
    - an unauthenticated callback being refused after sign-in (D6);
    - "verified with mocks only" for live Facebook and Instagram publishing and connect, U1 and U2.
15. **`docs/meta-setup.md`** (FR-036/037), in this order:
    1. Create the app (Business type).
    2. Add the Facebook Login for Business use case. If a login configuration is used (R4), create it with the five permissions and copy its id to `META_LOGIN_CONFIG_ID`.
    3. Add the five permissions, and explain when `ads_management`/`ads_read` would be needed (Business Manager-only Pages). They are not requested.
    4. App roles: add every Facebook user who will connect as an admin, developer or tester, and check that each Page's Instagram professional account is linked to the Page.
    5. Stay on Standard Access, without App Review.
    6. Valid OAuth Redirect URIs: `https://<host>/connect/callback` for production, and `http://localhost:3000/connect/callback` for local development (**U2, unverified**, with a test procedure).
    7. The fallback: a hosts-file name plus an mkcert certificate.
    8. Where to find the app id and secret, and which env vars to set.
    9. Leave "Require App Secret" off (R6).
    10. The Graph API Explorer token-paste steps, with the five permissions to tick.
    11. A note that media needs a public bucket.
    12. A marked `## Threads (added by the meta-threads entry)` placeholder.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Constitution V "no schema change": a new generic **`connect_attempts`** table (G5) | FR-010 requires candidates and their tokens to be held **on the server, encrypted**, until chosen or expired. FR-007/FR-008 require single-use, session-bound state. This must work across several web instances and restarts, and stay single-use under concurrent callbacks. It is generic: any OAuth group (Threads next) uses it unchanged. The spec's G5 explicitly allows this if justified and recorded | **An encrypted cookie** is client-held, so it breaks FR-010; Page tokens for many Pages would also overflow the 4 KB cookie limit. **Process memory** fails with two instances or a restart. **Better Auth's `verification` table** belongs to the auth library and has no project scope (constitution III). **A stateless HMAC state** cannot be single-use. **Redis** is new infrastructure (constitution VI) |
| Constitution V "no scheduler change": **G7** adds handling of `fatal_error.credentialsInvalid` in `scheduler/publishing.ts`, plus one DAL method | Page tokens have no refresh. The only existing signal (`credentialsExpired`) asks for a refresh that cannot happen, so a revoked token would fail every post forever without flagging the account (US7, FR-017). The fix is generic and optional, and it is ignored by providers that do not set it | **Provider-side "mark needs_reauth"**: providers cannot touch storage (`docs/adding-a-provider.md` §4) and must not import server code. **Reusing `credentialsExpired` with a failing `refreshCredentials` stub**: misleading semantics, and it keeps the target retrying. **A new `StepResult` kind**: a wider change for every consumer |
| Constitution V "one folder + one registry line": the generic connect UI (G5/G6) adds a route handler, two pages and three actions, and **G8** touches startup | No OAuth redirect flow, chooser or token-paste path exists today. Without G8, the Meta env vars would have to be hard-coded in `src/server/env.ts` (Meta-specific server code, against FR-002) | **Meta-specific screens and env entries**: these break FR-002 and SC-008, and Threads would duplicate them |
