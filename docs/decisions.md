# Decisions log

Judgement calls made while building, newest last. Each entry: what, why, and
how to reverse it. The owner reviews these; anything here can be overturned.

## 2026-10-02/03 — step 0 (bootstrap, made by hand before the roadmap)

1. **pnpm + Node 24 LTS**, `engines: >=24.10 <25` (semantic-release needs
   ≥24.10). Owner answer.
2. **License: MIT.** Repo is public and meant to be self-deployable. Change the
   `LICENSE` file if another license is preferred.
3. **Instagram via Facebook Login for Business**, not Instagram Login — one
   OAuth flow yields Page tokens and linked IG account ids. See
   `docs/research/meta.md`.
4. **Better Auth organization plugin = projects**, plus Docket-owned hashed
   `invitation_tokens`, per-request membership checks, and a sign-up hook
   gate. See `docs/research/better-auth.md` for the gaps this covers.
5. **Time zones via `@js-temporal/polyfill`** (Temporal is not unflagged in
   Node 24).
6. **No Postgres RLS**; scope enforced by DAL + ESLint import ban + query-log
   test. Owner answer.
7. **OpenAPI via `zod-openapi`** (Zod 4 native JSON Schema). Not yet installed.
8. **CI** = one workflow: commitlint (PRs), lint, typecheck, `db:check` (once
   Drizzle exists), Vitest against a `postgres:17` service, `next build`,
   Docker build, then semantic-release on `main` after those pass.
9. **semantic-release** creates a git tag and a GitHub release (notes from
   conventional commits) on `main`; no npm publish. It does **not** commit back
   (`package.json` version / `CHANGELOG.md`) because the `main` ruleset requires
   pull requests. The tag/release is the source of truth for the version.
10. **Merge strategy**: the owner's `main` ruleset requires PRs and allows only
    the `merge` method, which keeps the small conventional commits. The repo-level
    "Allow squash merging" flag is still on, and the roadmap runner picks squash
    from that flag (then the ruleset refuses it). Until the flag is unticked,
    roadmap runs use a PATH shim for `gh` (scratchpad, not in the repo) that
    reports only `merge` as allowed. **Owner action**: untick "Allow squash
    merging" (and "Allow rebase merging") in Settings → General.
11. **speckit auto-commit stays off** (it runs `git add .`); phases commit per
    task with explicit paths per the constitution. `commit_style` set to
    `conventional` in case a hook fires.
12. **Docker image**: single `node:24-slim` multi-stage image for both `web`
    and `worker`; optional BuildKit secret `extra_ca` for building behind a
    TLS-intercepting proxy (the owner's laptop). Nothing machine-specific is
    baked in.
13. **Research lives in `docs/research/`** because pipeline phases cannot use
    the web. The `platform-researcher` agent refreshes it.
14. **UI guidance is a project skill (`docket-ui`)**, not a sub-agent, because
    pipeline phases cannot spawn agents but do load skills.
15. **Postgres 17** image for Compose and CI (current stable major supported
    by Neon). Bump deliberately.
16. **System font stack instead of `next/font/google`** (Geist). Removes the
    build-time download from Google Fonts, which broke Docker builds behind a
    proxy and leaks requests to Google for self-hosters. Reverse by using
    `next/font/local` with a vendored font file.
17. **Roadmap titles kept short** so the runner's fallback commit
    `feat(<slug>): <title>` fits commitlint's 100-char header limit.

## 001 — Foundation, auth, projects (D1–D18, condensed)

Full rationale lives in `specs/001-foundation-auth-projects/research.md`.

1. **Better Auth owns authentication**; Docket's DAL owns membership changes.
2. **Organization-plugin HTTP endpoints are blocked**; the sign-up endpoint
   always returns 400.
3. **`projects.id` = `organization.id`** (shared primary key, cascade delete).
4. **Invitation sign-up and first-user setup insert credentials directly** in
   DAL transactions rather than via the HTTP sign-up endpoint.
5. **Login posts to the HTTP endpoint** so Better Auth's rate limiter applies.
6. **Invitation tokens are 32 random bytes, hashed, single-use.**
7. **`InvitationDelivery` interface** with one implementation.
8. **Scope enforcement**: table registry + SQL recorder in tests +
   `crossProject` escape hatch.
9. **Hand-written Drizzle schema**, core query builder only.
10. **Extra constraints on Better Auth tables** added in Docket migrations.
11. **Invitation states** mapped onto Better Auth's stored values.
12. **Race-free last-owner protection**; membership changes serialised.
13. **First-run bootstrap guarded by a singleton `install_state` row.**
14. **Startup order** (env validation → migrations → bootstrap) runs from
    `instrumentation.ts`.
15. **`db:check`** = migration history check + "schema has no ungenerated
    changes".
16. **Secrets at rest**: `enc:v1:<kid>:<iv>:<tag>:<ciphertext>` (AES-256-GCM).
17. **Shared Zod schemas** for time zone and slug validation.
18. **Routing/UI structure**: `/p/[projectSlug]/...` with a shared shell.

### Dependencies
- `pg` — the Postgres driver Drizzle's node-postgres adapter and Better
  Auth's Drizzle adapter use; supports pooled Neon URLs.
- `@better-auth/drizzle-adapter` — Better Auth's supported adapter for the
  Drizzle schema Docket already owns, avoiding a second ORM.

### Spec assumptions
- Invitation TTL is 7 days by default (`INVITATION_TTL_DAYS`).
- Ownership transfer demotes the previous owner to admin.
- Only owners change roles.
- A non-member sees "not found" for a project, never "forbidden".
- The `/setup` screen is open until the first account exists; internet-
  reachable deploys should set bootstrap credentials.

### Unverified items (research.md U1–U3)
- **U1** (Better Auth schema check vs `timestamptz`): verified — `tests/integration/auth-schema.test.ts` boots Better Auth against the migrated `timestamptz` schema and `getSession` succeeds; no switch to `timestamp` needed.
- **U2** (`nextCookies()` ordering): not verified (needs a browser to observe the
  cookie on a server-action sign-in).
- **U3 / SC-011 Neon half**: **not verified** — no Neon connection string was
  available to the build (constitution II).
19. **Dependencies are installed from the front-end session, not by pipeline
    phases.** Headless phases cannot reach the npm registry (TLS-intercepting
    proxy + sandbox), which blocked foundation's T001 and most later tasks.
    Installed up front for all planned entries: better-auth 1.7.7,
    @better-auth/drizzle-adapter 1.7.7, @better-auth/api-key 1.7.7,
    drizzle-orm 0.45.3, drizzle-kit 0.31.11, pg 8, zod 4.6.5,
    @js-temporal/polyfill, sharp, @aws-sdk/client-s3 + s3-request-presigner,
    @atproto/api (resolved 0.22.x), openai, @anthropic-ai/sdk, zod-openapi,
    csv-parse. A phase that needs anything else must mark the task
    `NEEDS DEPENDENCY: <pkg>` instead of guessing APIs.

## T082 gate run (local)

`pnpm lint`, `pnpm typecheck`, `pnpm db:check`, `pnpm test` (29 files / 225 tests) and `pnpm build` all pass with only `DATABASE_URL` set (no other auth/crypto env in the shell), matching CI's `check` job env. Run against Postgres on :5433 (host Postgres owns :5432).
20. **esbuild bundles `scripts/prestart.mjs`** into `.next/standalone/scripts/`
    during `pnpm build`. The pre-start migrator runs outside Next's bundle, and
    under pnpm the standalone `node_modules` does not link `drizzle-orm` at the
    top level, so the unbundled script crashed the container. Verified with
    `docker compose up` (migrations before "Ready", health 200, fresh install →
    `/setup`, migration failure exits 1 before listening).
21. **Local test database runs on port 5433** (`docket-pg` container,
    `postgres://docket:docket@127.0.0.1:5433/docket_test`) because a host
    Postgres on the owner's Mac owns 5432. CI is unaffected.
22. **Sign-in is rate-limited per email, not only per IP** (review F1). Better
    Auth keys its limit on `X-Forwarded-For`, which a client can choose when
    port 3000 is published directly. The `before` hook now counts
    `/sign-in/email` attempts per normalised email (3 per 10 s, in memory,
    HTTP requests only), and the per-IP rule for that path is relaxed to
    30 per 10 s as a backstop so a malformed header's shared bucket cannot lock
    out other users. `TRUSTED_IP_HEADERS` / `TRUSTED_PROXIES` configure
    `advanced.ipAddress`; the README states the reverse-proxy requirement.
23. **Roadmap split to 10 entries** (owner-approved): `meta` became
    `meta-facebook-instagram` + `meta-threads` (separate app, OAuth hosts and
    token lifecycle), and `jobs-and-api` became `generation-jobs` +
    `public-api` (job engine lands and is tested before the API exposes it).
    The run started with 8 entries counts only 8, so the last two
    (`public-api`, `hardening`) need one more `spec-roadmap run`.

## 002 — Scheduling engine (implementation notes)

- **`stepFor(state, settings)`** takes the account's parsed settings as a second argument.
  The contract's `stepFor(state)` cannot express the mock's rule "multi_step starts with a
  non-publishing `create_container` step", which depends on per-account `behaviour`. The engine
  passes `provider.settingsSchema.parse(account.settings)`.
- **DST rule.** A slot's wall-clock time resolves with `disambiguation: "compatible"`:
  a time in the spring-forward gap moves later by the gap, and a time in the autumn
  overlap takes the first (earlier) instant. Two slots resolving to the same instant on
  one account collapse into one occurrence. Tested for New York, London, Sydney and Lord Howe.
- **Backoff and `attempt_count`.** `attempt_count` counts *failed* attempts at the current
  step (retryable errors and lease recoveries that retry) and resets to 0 after a step
  continues. Delay is `min(60 s × 2^(n−1), 3600 s)`, no jitter, and
  `next_attempt_at = max(now + delay, notBefore)`. `PUBLISH_MAX_ATTEMPTS` defaults to 5.
- **Lease and recovery.** A claim stamps `lease_owner`, `lease_until`, `in_flight_step` and
  `in_flight_may_publish`. An expired lease on a non-publishing step is retried
  (`recovered_retry`); on a step that may have published it becomes `ambiguous`
  (`recovered_ambiguous`) and is never called again. A record whose lease token no longer
  matches writes only a `stale_result` attempt.
- **Limit counting.** Both the provider default and the account limit are enforced. A target
  "starts" when a first step is leased (`publish_started_at` is re-stamped on every first-step
  lease, automatic and recovery retries included, so the attempt that may publish is the one
  counted); starts in the window (including ones that later failed) count, except the checked target's own earlier
  start, so an automatic retry follows its backoff instead of waiting a window. Re-arming a
  target (`retryTarget`, `addToQueue`, `scheduleAt` / `publishNow`) clears `publish_started_at`,
  so the new attempt is counted when it is leased. Excess targets are deferred to `oldest start + window`, with no attempt
  counted and no provider call.
- **Status derivation.** `posts.review_state` (`draft | needs_review | approved`) is stored;
  `posts.status` is derived from live targets (excluding `draft`/`cancelled`) and re-stored
  under a post row lock on every target change. `ambiguous` counts as not published.
- **`chars` means code points**, not UTF-16 units; the capability enum is
  `graphemes | code_points | utf8_bytes`.
- **`needs_reauth` has no transient retry.** Any refresh failure marks the account
  `needs_reauth`; due targets then fail with "Reconnect … to publish" without a provider call.
- **Heartbeat is system-wide** (`scheduler_heartbeats`, not project-owned). Sections write it
  only on completion; the indicator reads `publishing` and compares with
  `SCHEDULER_STALE_AFTER_MINUTES`.
- **Mock provider gating.** `MOCK_PROVIDER_ENABLED` defaults to true, except false when
  `NODE_ENV=production`; accounts can only be connected when it is on.
- **Soft deletes.** `posts.deleted_at` and `social_accounts.removed_at` keep the append-only
  attempt log intact; repositories hide soft-deleted rows by default.
- **"Move to next" excludes the current occurrence**, so the action always visibly moves
  the post; if no other occurrence is free the target is unchanged and a message is returned.
- **Two extra env vars:** `EXPLICIT_TIME_WARNING_MINUTES` (default 30, 0 disables) and
  `QUEUE_HORIZON_DAYS` (default 366).
- **Constants:** claim batch size 4 and token-refresh cap of 5 accounts per tick (not configurable).

### 002 quickstart walk (T082)

- **Verified:** every `pnpm vitest run …` selection in §2 passes (30 files, 143 tests).
- **Not verified here:** §3 manual `curl` against `pnpm dev` (headless run, no network tools;
  the same responses are covered by `tests/integration/tick-endpoint.test.ts`); §4/§6 running
  the worker and in-process loop by hand; §5 visual check of the indicator (rendered states
  covered by `scheduler-health.test.ts`); §7 `docker compose up` (SC-013, T084); Neon (T085).
24. **Faster checks** (owner asked to stop re-running expensive checks):
    - Vitest runs files in parallel, each worker on its own clone of the
      migrated test database (`CREATE DATABASE … TEMPLATE`, made once in
      global setup; `DOCKET_TEST_WORKERS` overrides the count, default
      min(4, cores − 1)). Suite on main: 46 s → ~20 s.
    - The constitution (v1.2.0) tells implement passes to run only affected
      tests per task and the full suite/build once at the end of the phase.
    - CI splits `check` into parallel `static`, `test` and `build` jobs and
      caches `.next/cache`.
    - The front-end session no longer re-runs full gates locally when CI will
      run them on the push.

## 003 — Scheduler screens and media (D1–D21, condensed)

- **Uploads:** one file per Server Action call, in sequence; body and Server Action limits raised to 26 MB (the proxy otherwise truncates silently, so the limits have a config test).
- **Live composer checks** use a read-only route handler (`compose/check`), not a Server Action, so they are cheap, cacheless and never refresh the page.
- **Storage interface** has `put`, `delete`, `publicUrl`, `signedUrl` plus `get` and `exists` beyond FR-001's four operations (variants and publish-time checks need them). One S3 implementation covers R2, S3 and MinIO.
- **Storage env** is an all-or-nothing group validated at start-up; without it media features are disabled and text-only posting keeps working.
- **Offline MinIO:** opt-in compose profile `offline`, image pinned by exact tag and overridable via `MINIO_IMAGE`, bound to loopback. The upstream image is frozen and unmaintained, which the docs say. Bucket creation and the anonymous-read policy are done by `scripts/storage-init.mjs` using the AWS SDK, not `mc`. MinIO is for the mock provider only; Instagram and Threads can never fetch from `localhost`.
- **Media constraints are provider capabilities** (`outputMimeType`, min/max dimensions, aspect ratios, `maxAltTextLength`), so a platform rule change stays inside the provider folder.
- **`ValidationIssue.severity` gains `"info"`** for adaptation notes; blocking logic still filters on `"error"`.
- **One validation path:** `planImage` (pure) then `validateTargetContent`, used by the composer check, `previewQueue`, the queue/schedule/publish gates and `updatePost`.
- **Variants** are generated before acceptance and cached by constraint hash plus pipeline version; they are re-checked at publish. Originals are cleaned and thumbnails made at upload.
- **Deleting media** is a soft delete with a post-first lock order; published history keeps showing "Image deleted". `media.get`/`getMany` hide deleted assets; `getPostView` uses `getIncludingDeleted`.
- **Tags** are a `text[]` column.
- **Move to occurrence** uses the same guarantee as the queue (unique-slot conflict becomes "That slot was just taken."), covered by a 20× parallel race test.
- **Pull-forward preview** runs the real function inside a transaction that is rolled back.
- **Explicit local time** resolves with `compatible` disambiguation (gap → later, overlap → earlier), matching 002's queue DST tests.
- **Thumbnails and previews** use the public URL by default; `S3_PREVIEW_URLS=signed` signs them for private buckets (not usable for publishing).
- **Server action tests** call the exported actions directly with mocked session, cache and navigation modules; `tests/integration/actions-authz.test.ts` tables every action × role.
- **No new runtime dependencies** beyond the AWS S3 client and sharp already chosen; sharp is `--external` in the worker bundle.
- **Media-resolution recovery (plan note 6), accepted outcome:** 002's rule is unchanged. Media resolution runs after the claim and before `advance`, under the leased step. If the process dies during resolution while that step has `mayPublish: true`, the expired lease is marked `ambiguous`, exactly like a death between claim and call; a missed post beats a duplicate. A non-publishing first step that dies in resolution is retried (`publish-resolution-retry.test.ts`). Resolution cannot move into the claim's `decide` because that would put slow I/O in the claim transaction.

## 004 — Bluesky provider

- **FR-007, app password never stored. ~~Accepted~~ — reversed 2026-10-16 (Jamie's call).** It used to store only the session tokens, DID and handle, so every refused refresh needed a human. In practice sessions were refused after ~2.5 days rather than the refresh token's ~90, and the Stencilvania Halloween run silently dropped Bluesky posts between the refusal and the reconnect. `connectAccount` now also stores the app password (encrypted, redacted like every other credential leaf), and `refreshCredentials` opens a fresh session with it — identifying by DID, so a renamed handle still signs in — when a refresh is definitively refused. Accounts connected earlier have no stored password and keep the old manual path. *Known cost:* an app password does not expire and survives session revocation, so a credentials leak is open-ended until it is revoked in Bluesky; the premature-refusal cause is still unexplained and this masks rather than fixes it. *Reverse:* drop `appPassword` from `blueskyCredentialsSchema` and the `reauthenticate` call in `refreshCredentials`.
- **G1 generic credential connect** (`CredentialField.optional/defaultValue/placeholder`, `connectAccount?`, `connectWithCredentials`, `ConnectCredentialsForm`). *Why:* there was no way to connect a non-OAuth provider without a provider-specific screen. *Reverse:* remove the optional fields and the form; no schema was touched.
- **G2 publish-time refresh** (`needsRefresh?`, `retryable_error.credentialsExpired?`, `scheduler/credentials.ts`, `acquireRefreshLease`). *Why:* Bluesky rotates the refresh token on every refresh, so it must be persisted under a lease before the publish step, and never inside a `mayPublish` step. *Reverse:* drop the two optional members and the hooks in `execute`; the scheduled refresh keeps working.
- **G3 transient refresh failure** (`RefreshResult.transient/retryAt/displayName`). *Why:* every refresh failure used to be fatal (`needs_reauth`), so one 5xx locked out an account. *Reverse:* ignore `transient` in `applyRefreshResult`.
- **G4 step content** (`StepContent`, `stepFor(state, settings, content)`, `PublishContext.step`, `ClaimContext.contentShape`; a missing post is now fatal). *Why:* a text-only post must publish in one tick (SC-003) while an image post needs a non-publishing upload first (FR-013). *Reverse:* make `stepFor` ignore `content`; the mock already does.
- **`released` reused** for "refresh busy / flagged" rather than adding an enum value, so there is no schema change.
- **Publish-time refresh recovery (accepted outcome):** a process killed mid-refresh on a `mayPublish` step is recovered as `ambiguous`, per 002's rule, unchanged. A missed post beats a duplicate. Same family as 003's media-resolution note.
- **JPEG and PNG only.** Bluesky image blobs are limited and we do not convert to other types; other formats are adapted or refused by `planImage`.
- **One image per step.** Each image is its own non-publishing `upload_image` step (one per tick), so a four-image post takes five ticks. Accepted for crash safety and per-step state.
- **PDS URL rules:** `https://` only (no credentials, query or fragment in the URL), default `https://bsky.social`; the DID document's service endpoint is not followed, so a hostile PDS cannot redirect traffic.
- **`Retry-After` only.** Rate limits read the standard `Retry-After` header. Bluesky's own `ratelimit-*` headers are NEEDS RESEARCH (U1) and are not used.
- **Not using `CredentialSession`, `AtpAgent` or `agent.post()`.** They refresh inside calls (unserialised, rotated token not persisted, inside the may-publish step) and `post()` needs a session DID. We call `createRecord` directly with a per-call agent whose `fetch` reads `globalThis.fetch`.
- **Mention lookups:** a failed handle lookup that is transient (network, 5xx) retries the non-publishing step; an unresolved handle (not found) stays plain text rather than blocking the post.
- **Verified with mocks only.** Live publishing has not been exercised. The live check (quickstart §7) is owed by the owner.
- **Quickstart walk (T053):** §1–§5 selections pass (23 files, 220 tests), verified with mocks only. §6 gates are recorded below.
- **Final gates (T051):** `pnpm lint` (0 errors), `pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm db:check` ("Migrations are current", no migration) all exit 0, including `tests/lint/worker-bundle.test.ts` and the import-boundary lint.
- **Scope (T052, SC-008):** outside `src/providers/bluesky`, tests, docs, README and specs, the diff against main is the registry line plus the generic G1–G4 files only: `providers/types.ts`, `registry.ts` (+ its test), `dal/accounts.ts`, `dal/scheduler.ts`, `scheduler/{credentials,index,publishing,token-refresh}.ts`, `services/accounts.ts` and the accounts screen (`actions.ts`, `page.tsx`, `ConnectCredentialsForm.tsx`). No schema file changed.

## 005 — Facebook Pages and Instagram

- **FR-012, no user token stored.** The short- and long-lived user tokens (and a pasted token) only reach the exchange. Only each Page's token is kept, encrypted, in `credentials_encrypted`. Pending candidates (with their Page tokens) live only in `connect_attempts.candidates_encrypted`. `tests/integration/meta/no-secrets.test.ts` scans every plaintext column, results and console output for fake secrets.
- **G5 generic OAuth connect, and the new `connect_attempts` table.** *What:* connect groups shared by several providers, a candidate list, one fixed callback `/connect/callback`, a generic chooser page and a project-owned `connect_attempts` table (hashed single-use state bound to user, session and project; candidates encrypted; 10-minute life). *Why:* FR-010 needs candidates and their tokens held server-side and encrypted until chosen, across instances and restarts, and single-use under concurrent callbacks. A cookie breaks FR-010 and the 4 KB limit, process memory fails with two instances, Better Auth's `verification` table has no project scope, and a stateless HMAC state cannot be single-use. *Reverse:* drop the table (one migration), the callback route, the chooser and the three actions; the `oauth` strategy goes back to a type only. This is the one schema change in the feature.
- **G6 paste a token to get candidates** (`OAuthConnectGroup.pasteToken`). A token from Graph API Explorer goes through the same exchange and chooser as OAuth, and can reconnect an existing account. *Reverse:* remove the member and the paste form.
- **G7 credentials invalid** (`fatal_error.credentialsInvalid`). The engine flags the account `needs_reauth`, conditionally on the ciphertext it used, with no retry and no ambiguity. *Why:* Page tokens have no refresh, so `credentialsExpired` (which asks for a refresh) would fail every post forever. *Reverse:* ignore the flag in `scheduler/publishing.ts` and drop the one DAL method.
- **G8 provider-declared environment.** A connect group declares and validates its env vars and startup merges the issues, so no `META_*` lands in `src/server/env.ts`. *Reverse:* hard-code the variables in `env.ts`.
- **R1–R10 are interim values, UNVERIFIED against the live API** (text limits 10,000/2,200; Facebook photos JPEG/PNG, 8,000,000 bytes, at most 10; Graph error table incl. 190 invalid token and 4/17/32/613 rate limits; `config_id` replaces `scope` when `META_LOGIN_CONFIG_ID` is set; `content_publishing_limit` read as `quota_usage`/`config.quota_total`; app secret proof not sent; dialog and exchange URLs; `/me/accounts` limit 100, at most 4 further pages; POST bodies form-encoded, GET tokens in the query and stripped from anything logged). Each lives in one constant, and none is reported as working. *Since re-checked against Meta's docs: see 017 (D2–D6, `docs/research/meta.md` "Limits verification, 2026-10-07").*
- **First URL as link.** Text with an http(s) URL sends the first URL as `link` in the single feed request. **Images take precedence over the link:** a post with images sends no `link` and the URL stays in the text.
- **Instagram polling.** `check_status` repeats through `continue` + `notBefore` (10 s, doubling to 5 min) and gives up after 60 minutes from `createdAt` with "Instagram did not finish processing the media." Tests advance the DB clock rather than sleeping.
- **Container recreation.** A container is recreated only before any publish request is sent: on `EXPIRED` at the status check, or by the 23 h age guard at the quota step. Cap of 2 recreations, then fatal. After `media_publish` was sent the outcome is done, fatal or ambiguous, never a recreation. `PUBLISH_MAX_DURATION_HOURS` (default 24 h from the first step) still applies, and with the default it usually fires before the 23 h guard.
- **Quota.** At or over the total the step retries no earlier than +1 h. Each wait is a retry, so the engine's attempt cap can end a very long wait before the container expires; accepted.
- **No post URLs (R5).** Neither provider stores a permalink; only the platform id is kept.
- **Instagram display name (R8).** The research listing returns `{ id }` only, so the name is "<Page name> · Instagram". A username lookup is deferred.
- **Purge on connect traffic (D9).** Expired attempts are unreadable at once; their rows are deleted by a cross-project purge at the start of start, paste and callback. *Limit:* in a deployment where nobody connects again, expired encrypted rows stay until the next connect.
- **Unauthenticated callback (D6).** `/connect/callback` stays behind the session gate. A visitor without a session is sent to sign in, and the new session then fails state binding, so they are told to start again. Safe, if a little unfriendly.
- **Verified with mocks only:** live connect and publishing for Facebook and Instagram, and the open questions U1 (multi-photo posts) and U2 (a `localhost` redirect URI). The owner performs quickstart §8 after merge and records "verified live on <date>" here.
- **Quickstart walk (T074):** §1–§6 selections pass (§1 6 files/49 tests, §2 5/44, §3 7/63, §4 9/98, §5 3/6, §6 3/46), each **verified with mocks only**. §7 is replaced by the Vitest UI tests; §8 is owed by the owner.
- **Final gates (T072):** `pnpm lint` (0 errors, 2 unused-arg warnings in test files), `pnpm typecheck`, `pnpm test` (162 files passed, 1 skipped; 1293 tests), `pnpm build` and `pnpm db:check` ("Migrations are current", one migration `0003`) all exit 0, including `tests/lint/worker-bundle.test.ts` and the import-boundary lint.
- **Scope (T073, SC-008):** outside the Meta/Facebook/Instagram provider folders, tests, docs, README and specs, the diff against main is the registry line (`providers/registry.ts`, `types.ts`, test) plus the generic G5–G8 files only: connect route, invalid page and chooser, accounts screen files, `dal/{accounts,connect-attempts,scope}.ts`, `db/{project-owned,schema/connect,schema/index}.ts`, `provider-env.ts`, `scheduler/publishing.ts`, `services/{accounts,connect}.ts`, `startup/index.ts` (+ test), the `0003` migration and `.env.example`.

## 006 — Threads

- **FR-013, only the long-lived token is stored.** The authorization code and the short-lived token only reach the exchange. The credentials are `{ v: 1, accessToken, issuedAt, expiresAt, expiryEstimated }` (epoch milliseconds, so the scheduler does not redact timestamps as secrets), encrypted in `credentials_encrypted`.
- **G9 custom counting rule** (`CustomCountingRule`: `kind: "custom"`, `name`, `unit`, `count`). *What:* a provider may declare its own text counting function; `TargetCheck.countingRule` carries its name. *Why:* Threads' rule (emoji by UTF-8 bytes, other characters by code point) is none of the three built-ins, and the composer's count must equal the enforced count. A fourth built-in would put Threads code in the shared counter. *Reverse:* narrow the type back; only Threads uses `custom`.
- **G10 callback-address requirement** (`OAuthConnectGroup.redirectRequirement`). *What:* a group can declare HTTPS and public-host requirements; when `BETTER_AUTH_URL` does not qualify, the group shows as unavailable with a reason and a doc link, and start is refused on the server; paste stays available. *Why:* Threads refuses `http://` and localhost, so the login would otherwise fail on its page with no explanation. A start-up error would break other providers on a local `http://` deployment. *Reverse:* remove the member, the helper `redirectUriProblem` and the unavailable state in the section.
- **G11 held refresh** (`holdTransient`, `RefreshPatch.refreshLeaseUntil`). *What:* a transient refresh failure with `retryAt` parks the refresh lease until then, capped at 24 h. *Why:* a token under 24 h old cannot be renewed; without this it is reclaimed every tick and `last_error` rewritten. *Reverse:* stop passing the option and drop the patch field. No schema change.
- **G12 callback hint.** *What:* a group's static `callbackHint` is shown after a failed callback, found through `&group=<key>` (a registered key only). *Why:* the tester-invite reminder (FR-014). *Reverse:* drop the member and the query parameter.
- **G13 account notes** (`accountNotes`). *What:* non-secret notes on the account card, such as an estimated expiry. *Why:* FR-015. *Reverse:* drop the member and `AccountView.notes`.
- **R1–R10 are interim values, UNVERIFIED against the live API** (`docs/research/meta.md` has no entry for them; each is one constant with mocked tests). R1 `v1.0` on publishing, profile, status and quota paths, none on the token paths. R2 `GET /me?fields=id,username`. R3 code exchange, `th_exchange_token` and `th_refresh_token` shapes; 60 days assumed when `expires_in` is unreadable. R4 the shared Meta error table. R5 carousel parameters, only the parent is status-checked. R6 container life assumed 24 h. R7 `threads_publishing_limit` read defensively; unknown never blocks. R8 `https://docket.local:3000/connect/callback`, with a 443 fallback and the base address for uninstall/delete fields; no such endpoint is built. R9 the emoji rule below. R10 no permalink; only the post id is kept. *Since re-checked against Meta's docs: see 017 (D2–D6, `docs/research/meta.md` "Limits verification, 2026-10-07").*
- **D3 emoji reading.** An emoji grapheme (`\p{Extended_Pictographic}`, two regional indicators, or containing U+20E3) counts its UTF-8 bytes; everything else counts per code point; limit 500. **Text-presentation pictographs (`☺`, `©`, `™`) count by bytes too** (`☺` 3, `☺️` 6, `©` 2) because they are `Extended_Pictographic`. `\p{RGI_Emoji}` was rejected. Unverified.
- **D4 readings.** The size limit is **8,000,000 bytes** (not 8 MiB). The aspect range is **1:10 to 10:1, inclusive**. Width 320–1,440 px, 20 images, 1,000-character alt text, JPEG/PNG. Publishing limit assumed 250 per 24 h until the live quota is read.
- **Cadence.** `check_status` waits 30 s, then 60 s, then 5 min (the cap), through `continue` + `notBefore`; no loop or sleep.
- **Recreation.** A container is recreated only before any publish request is sent: on `EXPIRED` at the status check, or by the 23 h age guard at the quota step. Cap of 2, then fatal. After `publish` was sent the outcome is done, fatal or ambiguous, never a recreation. `PUBLISHED` seen during a check is ambiguous.
- **Paste order and its network-stop refinement (D6).** Try `th_exchange_token`, then `th_refresh_token` if the exchange is definitively refused, then read the profile and save the token as is with an estimated expiry. **A network error, 5xx, rate limit or unreadable reply at any stage stops the sequence** ("Could not reach Threads…"), a deliberate refinement of FR-015's "the first that works": falling through could save a 1-hour token as a 60-day one.
- **Estimated expiry.** A token saved as pasted gets `issuedAt = now`, `expiresAt = now + 60 days`, `expiryEstimated = true`, and a note on the account. The paste time keeps the 24 h renewal guard conservative.
- **Not using `auto_publish_text`.** Every post type keeps the same two-step flow, so only `publish` is `mayPublish` and one ambiguity rule applies.
- **Tokens in GET queries (D10).** `th_exchange_token`, `th_refresh_token`, status and quota are `GET`s with the token in the query, as 005 does for Facebook. `graphRequest` never exposes the URL and `scrub` removes `access_token=`, `client_secret=` and `code=` from anything shown or logged. Recorded as a limitation.
- **Verified with mocks only:** live Threads connect, renewal and publishing, and the open questions **U1** (the `.net` host) and **U2** (where the token generator lives, and whether `localhost` or a non-default port is accepted in redirects). The owner performs the live check after merge and records "verified live on <date>" here.

## 007 — Generator core

latency: unmeasured; live path verified with mocks only.

Decisions made while specifying (each reversed by editing the named code):

- **Results saved immediately.** *What:* single-post results are saved as posts at generation time and the policies applied then. *Reverse:* hold results in a draft record and save on confirm.
- **Failed validation after one retry.** *What:* the post is saved and forced into review with problems listed; an unreadable response saves nothing and records a failure. *Reverse:* change `decidePolicy` and the failure path in `generation/index.ts`.
- **Scheduling policy remembered on the post.** *What:* `auto_approve` applies it at once; `review_required` applies it on approval. *Reverse:* drop the stored column and apply at generation only.
- **Override asymmetry.** *What:* editors may override approval only toward `review_required`; `auto_approve` needs owner/admin (`generation: auto_approve` access statement). *Reverse:* relax the check in `resolvePolicies`.
- **Rejected posts.** *What:* leave the queue, never scheduled, visible under a Rejected filter. *Reverse:* remove the `rejected` review state and the filter tab.

Plan-level decisions:

- **Alt text once per image** (research D9), under the strictest targeted limit, because alt text lives on the media asset. A generated alt text fills only an empty asset alt text; all are kept in the generation record. *Reverse:* ask per variant and store per target.
- **Model-input image constraints** (R1) are stricter than the spec ceilings (2,000 px, 5 MB raw, 24 MB base64 per request) and are UNVERIFIED for OpenAI. *Reverse:* raise the constants in `src/server/llm/images.ts`.
- **Failure rows store inputs, not the assembled prompt.** The prompt is rebuildable from inputs plus the recorded profile version. *Reverse:* add a prompt column.
- **Regenerate replaces content even if edited meanwhile.** It is explicit and the earlier record is kept. *Reverse:* compare an updated-at and return a conflict.

Generic changes to existing code:

1. `queueTargetsInTx` extracted from `addToQueue` (behaviour unchanged). *Reverse:* inline it back.
2. `validateTargetContent` takes `Pick<AccountRecord, "providerKey">` (type-only). *Reverse:* restore `AccountRecord`.
3. `ensureVariant` exports get-or-build for any `MediaConstraints`. *Reverse:* delete it; provider variants do not use it.
4. `rejected` review state, refused by `queueableGate`, plus a Posts filter tab. *Reverse:* drop the enum value (migration) and the tab.
5. Access statements `voice` and `generation`. *Reverse:* remove from `access.ts`.
6. Startup logs LLM problems and never fails. *Reverse:* throw from the startup check.
7. `failFromError` keeps the messages of `LlmNotConfiguredError` and `PolicyNotAllowedError`. *Reverse:* remove the two cases.

## 008 — Generation jobs, batch mode and item sources

latency: unmeasured; live path verified with mocks only. (`pnpm llm:check` needs a key; run it once with one and record the `job_call` and `jobs budget_ms=…` lines here.)

Decisions (full text in `specs/008-generation-jobs/research.md`):

- **D24 — Series stays in-request.** *What:* series generation is not moved onto jobs; single, series and jobs share one core and one save helper (`saveGeneratedPost`). *Why:* a series item carries angles, not template fields, and the series screen waits for the result. *Reverse:* add a `series` item source whose items carry the angle input.
- **D1 — One bounded model call per item per tick.** *What:* a job call's timeout is the time left in the tick minus a 3 s save reserve; an item starts only with 8 s + 3 s left; a correction retry that cannot fit is deferred, uncounted. *Reverse:* change `jobMinCallMs` / `jobPersistReserveMs` in `scheduler/config.ts`.
- **D3 — Throughput.** *What:* one claim round per tick, at most `GENERATION_TICK_MAX_ITEMS` (default 2) items, about 120 items an hour. *Reverse:* raise the setting.
- **D7 — Attempts.** *What:* 3 automatic attempts for temporary failures, backoff 60 s to 15 min; lasting failures are not retried. *Reverse:* the `JOB_*` constants in `scheduler/config.ts`.
- **Limits (interim).** 500 items per job; CSV 1 MB / 500 rows / 50,000 characters per row; instructions 2,000 characters. *Reverse:* one constant each.
- **D15 — Reservation by partial unique index** on active job items per media asset; the Media "Unused" filter excludes reserved images. *Reverse:* drop the index and the filter condition.
- **D18 — CSV upload is stateless**; the file is re-sent at job creation.
- **D26 — Live progress by periodic refresh** (every 5 s while active), no push channel. *Reverse:* replace `AutoRefresh` with a push channel.

Generic changes to existing code:

1. `generation/core.ts` gains the step API `runGenerationStep`; `runGeneration` behaves as before. *Reverse:* inline the step back.
2. `saveGeneratedPost` extracted from single and series generation (behaviour unchanged). *Reverse:* inline it back into both.
3. Prompt builder takes optional `itemData`; `null` leaves every prompt and snapshot unchanged. *Reverse:* remove the argument.
4. `GenerationRecord` gains `mode: "job_item"` and `job`; inputs gain optional `itemFields`; regenerate keeps item data. *Reverse:* drop the optional fields.
5. `forJobRunner` scope in `dal/scope.ts`. *Reverse:* delete it and the runner.
6. Worker bundle now includes the LLM layer and the generation services; `tests/lint/generation-imports.test.ts` rewritten accordingly. *Reverse:* restore the old assertion and remove the runner.
7. `MediaRepo.list` carries `reservedByJobId`; Media cards show "In a job". *Reverse:* remove the field.
8. `GENERATION_TICK_MAX_ITEMS` env setting (1–10, default 2). *Reverse:* remove it and use the constant.
9. New migration `0005` (job tables, `generation_job_item_id` link on posts). *Reverse:* a down-migration dropping them.
10. `pnpm llm:check` prints the jobs report; the unmeasured line is now `latency: unmeasured; live path verified with mocks only`.
11. Cancel discards in-flight work and is final; items that already saved a post are marked `done` with the post kept in review (review F3). *Reverse:* allow resuming a cancelled job by re-queuing its cancelled items.
12. Job policies are authorised once, at creation, against the creator's role. *Reverse:* re-check per item at save time.
13. CSV items are text-only (no image attached). *Reverse:* add an image-URL column type.
14. Filter selections skip used images by default and report how many were left out; the DAL lists used matches so the count is real (review F2). *Reverse:* default `includeUsed` to true.
15. "Row number" in CSV problems means the file line (header = line 1). *Reverse:* report data-row indexes instead.
16. Item field values reach the model wrapped in ⟦ ⟧ inside an `<item_data>` block, never as instructions (D20). *Reverse:* plain interpolation (not recommended).
17. An `incomplete` model result counts as a lasting failure (not retried automatically). *Reverse:* classify it as temporary.
18. Job items record failures on the item, not in `generation_failures`. *Reverse:* also insert a `generation_failures` row per failed item.
19. Generic changes: `applyApprovalPolicy` gained a guard against re-applying policy to an already-reviewed post, and the `[section]` placeholder route was removed now that every nav section has a screen. *Reverse:* drop the guard; restore the route.
20. The media library offers "Generate posts for these N images" for an active tag, missing-alt or search filter (review F1). *Reverse:* remove the link; picking images still works.

## 009 — Public API (implementation notes)

1. Key permissions that write also grant the matching view rights (`write_posts`, `generate`, `manage_jobs` → project, account, slot, media, post and voice `view`). The services read back, validate and check accounts and images, so a key holding only `write_posts` would otherwise get a misleading 403. The pipeline still requires the operation's own permission first, and `read` stays the only permission that opens the GET endpoints. *Reverse:* narrow `KEY_GRANTS` and make every write endpoint skip its read-back.
2. The media-by-URL fetch has no production switch for private addresses. Tests call `setUrlFetchOverridesForTests` (address policy and timeout) in `services/media-from-url.ts`. *Reverse:* none wanted.
3. A media image rejected by `processUpload` over the API maps to 413 (`too_large`, `too_many_pixels`) or 415 (anything else).
4. **Own hashed key table, not `@better-auth/api-key`.** Keys live in a project-owned `api_keys` table behind a DAL repository (hash only, shown once). *Why:* keys must act through `ProjectScope` with a project, a permission subset, a per-key rate-limit window and attribution columns on posts, jobs and media; the plugin's table is not project-scoped and has none of these. *Reverse:* migrate rows to the plugin and rewrite `forApiKey`.
5. **Multipart idempotency hash covers the file bytes plus the canonical JSON of the text fields, not the raw body.** The boundary is random per request, so raw bytes would turn every n8n retry of an upload into a 422. JSON bodies hash a canonical (sorted-key) form. This reads FR-014 by its intent. *Reverse:* hash the raw body.
6. **`POST /generate` links to its idempotency record through `requestId`** (`uuid(sha256("idem:" + record.id))`) passed to `generateSingle`, so 007's unique index `posts_generation_request_uq` dedupes the post without holding a transaction across the model call. A crash between save and policy leaves the post in review. *Reverse:* run generation inside the idempotency transaction (not allowed by the 008 constraint).
7. **5xx responses are never stored**; their idempotency claim is released so a retry runs again. 4xx results after the claim are stored and replayed. *Reverse:* store every response.
8. **Two error codes added to FR-010's list:** `generation_failed` (422, stored) and `generation_unavailable` (503, not stored), so a client can tell a bad model result from a provider outage. *Reverse:* fold both into `internal_error`.
9. **Failed deliveries count once per delivery**, after the eighth attempt; at 20 consecutive failed deliveries the endpoint is disabled (`disabled_reason = 'failing'`). *Reverse:* count each attempt.
10. **Closing a job with no items is refused** (409 `conflict`: add an item or cancel). Closing a closed job is a no-op. *Reverse:* allow the empty close, which completes the job at once.
11. **Generic changes:** `generation_jobs` gains `open` and `closed_at` and its item-count check becomes `0..500` with `open OR item_count >= 1` (UI-created jobs stay closed); list services gain optional `limit` and `offset` beside `page`; `created_by_api_key_id` columns on posts, jobs and media. *Reverse:* a down-migration dropping the columns and restoring the check; callers keep passing `page`.
12. **The import boundary test (FR-044) is two-tier.** Routes and `src/server/api/operations` may not import the DAL except types and `dal/errors`; the pipeline files directly under `src/server/api` may use the DAL scope but, like everything there, never the database, `pg` or `drizzle-orm`. *Reverse:* tighten the pipeline tier once `forApiKey` is re-exported from a service.

Decisions made while specifying (full text in `specs/009-public-api/spec.md`):

- **Key storage.** The spec preferred `@better-auth/api-key`; planning fell back to a Docket-owned hashed-key table (note 4 above, research D1). *Reverse:* see note 4.
- **The key decides the project.** *What:* paths carry no project slug (`/api/v1/posts/{id}`); a key works in exactly one project. *Reverse:* add a `/p/{slug}` path prefix and refuse a slug that does not match the key's project.
- **API keys only.** *What:* browser session cookies are not accepted under `/api/v1`, so the API has no CSRF surface. *Reverse:* accept the session in `src/server/api/auth.ts` and add CSRF checks for writes.
- **Keys belong to the project.** *What:* a key stays valid when its creator leaves or changes role; owners and admins can revoke it; actions are attributed to the key. *Reverse:* revoke a member's keys when their membership ends.
- **Permissions are independent.** *What:* `read` is not implied by the write permissions; the creation form preselects it. *Reverse:* make the write permissions imply `read` in the pipeline's permission check.
- **API-created posts behave like composer posts.** *What:* `POST /posts` makes an origin `api` post that is not put in review and can be queued or scheduled at once. *Reverse:* give origin `api` posts the review state generated posts get.
- **`PATCH /posts/{postId}` edits text, including on a scheduled post.** *What:* the body is partial — `text`, `overrides` (per account, `null` drops back to the shared text) and `mediaIds` — and anything absent is left as it is. It reads the live targets and re-sends them, because the `updatePost` service takes the *whole* desired target set: a target missing from that set is cancelled and a target sent without `overrideText` loses the text it had. Editing a scheduled post is deliberately allowed (fixing a typo should not mean cancelling and rebuilding the schedule); `updatePost` still refuses once publishing has started, which answers `409`. *Why not reuse `updatePostVariants`:* that one skips any target past draft by design, which is right for the generate screen and wrong for a correction. *Reverse:* restrict it to draft targets and make scheduled edits go through cancel-and-reschedule.
- **Idempotency records last 7 days.** *What:* covers an n8n execution re-run days later; afterwards the same key is new. *Reverse:* change `RETENTION_MS` (see the interim limits below).
- **In-flight duplicates get 409.** *What:* a duplicate arriving while the first request runs is refused with `idempotency_in_progress` and `Retry-After`; it never runs twice and never waits. *Reverse:* wait on the first request's hold instead of answering at once.
- **Webhook URLs may use `http` and private addresses.** *What:* owners and admins configure them and n8n may run on the same home server; the form warns about non-`https` URLs. *Reverse:* refuse them in the webhook URL validation (`src/lib/validation/api.ts`); belongs to the hardening security pass.
- **Media by URL is copied into the bucket** through the upload pipeline; fetches refuse loopback, private and link-local addresses. *Reverse:* store the remote URL as is (not recommended: platforms need a stable public URL).
- **`job.finished` fires on every move into a finished state** (`completed`, `completed_with_failures`, `cancelled`); a retried job that finishes again sends a new event with a new id. *Reverse:* emit only on the first finish.
- **The media library source is offered over the API** beside the `api` source; the CSV source is not. *Reverse:* drop `media` from the `POST /jobs` source union in `src/server/api/operations/jobs.ts`.

Interim limits (each one constant; *Reverse:* change the constant):

- Rate limit default 60 per minute, range 1–1,000: `rateLimitPerMinute` in `src/lib/validation/api.ts`.
- 25 keys per project and 10 webhook endpoints: `API_KEY_CAP`, `WEBHOOK_ENDPOINT_CAP` in `src/lib/validation/api.ts`.
- Idempotency retention 7 days: `RETENTION_MS` in `src/server/dal/idempotency.ts`. Hold: `max(300 s, 2 × LLM timeout + 120 s)`, `holdMs` with `MIN_HOLD_SECONDS` and `DEFAULT_LLM_TIMEOUT_SECONDS` (90 s, when no model is configured) in `src/server/api/idempotency.ts`.
- JSON body limit 8 MB: `JSON_BODY_LIMIT` in `src/server/api/handle.ts` (multipart gets the upload limit plus `MULTIPART_EXTRA`, 1 MB).
- 100 items per add call: `API_ITEMS_PER_CALL_MAX` in `src/lib/validation/api.ts`; 500 items per job: `JOB_ITEMS_MAX` in `src/lib/validation/jobs.ts`.
- Page size 50 by default, at most 100: `PAGE_LIMIT_DEFAULT`, `PAGE_LIMIT_MAX` in `src/lib/validation/api.ts`.
- Webhook delivery: 8 attempts, backoff 1 min doubling to 6 h, 10 s timeout, disabled after 20 failed deliveries, 30-day log, 10 deliveries per tick at concurrency 4: `WEBHOOK_DEFAULTS` in `src/server/scheduler/config.ts`. Secret rotation overlap 24 h: `ROTATION_OVERLAP_MS` in `src/server/services/webhooks/endpoints.ts`. Signature tolerance 300 s: `SIGNATURE_TOLERANCE_SECONDS` in `src/server/services/webhooks/sign.ts`. **Extended by 044's N60/N61/E17/E24**: email's delivery log and self-disabling pause reuse this shape (claim, backoff, a consecutive-failure threshold, a 30-day-style retention pruned by the section itself) with one departure — the log excerpts no reply text at all, because a mail server's refusal routinely quotes the recipient address (N60).
- URL fetches: 3 redirects, 30 s: `FETCH_MAX_REDIRECTS`, `FETCH_TIMEOUT_MS` in `src/server/net/safe-fetch.ts`.
- Housekeeping deletes in batches of 500: `HOUSEKEEPING_BATCH` in `src/server/scheduler/housekeeping.ts`.

Error codes added for media by URL: `url_not_allowed`, `url_too_many_redirects`, `url_fetch_failed` and `url_timeout`, all 400 (`src/server/api/errors.ts`), beside `job_item_limit` (400). *Reverse:* fold them into `validation_failed` with the reason in `details`.

The OpenAPI validity test uses the dev dependency `@seriousme/openapi-schema-validator`, so plan.md's `NEEDS DEPENDENCY` is resolved. *Reverse:* remove the dependency and the "is a valid OpenAPI 3.1 document" test; the structural checks remain.

Generic changes to existing code (plan.md):

1. `ProjectScope.actor`, `can()` by actor, the key re-check in `transaction()` and `actorColumns()`. *Reverse:* drop the `api_key` actor kind and `forApiKey`; member scopes are unchanged.
2. `created_by_api_key_id` attribution columns on posts, media and jobs; views show "API key: <name>". *Reverse:* a down-migration dropping the columns (note 11).
3. `applyDerivedStatus`, `refreshJobStatus`, `cancelJob` and the account-flag call sites emit webhook events in their transaction; `createSchedulingRepos` gains `webhooks`. *Reverse:* remove the emit calls and the `webhooks` repo from the scheduling repos.
4. `accounts.recordRefresh` / `markCredentialsInvalid` return `{ changed, previousStatus }`, and their four scheduler call sites run in a transaction. *Reverse:* return `void` again and drop the transactions.
5. Open jobs: `open`, `closed_at`, the relaxed item-count check, the `deriveJobStatus` open branch, `closeJob`, `appendItems`, and `cancelJob` closing the job. *Reverse:* see note 11; delete `closeJob` and `appendItems`.
6. `PreparedSource.mediaRules` (optional, 008 behaviour by default) and the `api` item source. *Reverse:* drop the field and unregister the source.
7. `uploadMedia` split into `prepareUpload` + `commitUpload` (behaviour unchanged); `registerMediaFromUrl` added. *Reverse:* inline the two steps back into `uploadMedia`.
8. `listUpcomingOccurrences` and `targets.heldOccurrences`; `listEmptySlots` unchanged. *Reverse:* delete both; the slots endpoint goes with them.
9. `listMedia`, `listJobs`, `listJobItems` take optional `limit`/`offset`; `getJobItem` is new. The API's job reads go through these services (review F4), and `appendItems` shares `createJob`'s rendered-instructions check, `assertRenderedFits` (review F1). *Reverse:* callers keep passing `page`; drop the options.
10. `createDraft` forces origin `api` for key actors; `prepareForScheduling` is exported. *Reverse:* take the origin from the caller; un-export the helper.
11. Access statements `api_key` and `webhook` (owner and admin). *Reverse:* remove them from `src/server/auth/access.ts`.
12. Auth gate: `/api/v1/` is public at the proxy, with authentication in the API pipeline. *Reverse:* remove the prefix from `src/lib/auth-gate.ts` (the API would then need a session).
13. `runTick()` gains a fourth section, `webhooks`, with its heartbeat; `TickSummary` gains `webhooks`. *Reverse:* remove the section; events stay in the outbox undelivered.
14. Audit enum values for key and webhook changes, with labels in the activity list. *Reverse:* a migration dropping the enum values once no rows use them.
15. `MediaRepo.reservedJobFor` so `GET /media/{id}` reports the reserving job (review F2). *Reverse:* delete it; the field is then always `null` on the single-asset read.

## 010 — Hardening

Baseline before any 010 change: `pnpm tsc --noEmit` clean, `pnpm lint` 0 errors (2 pre-existing `_ctx` unused-var warnings in `tests/integration/scheduler/`), `pnpm vitest run` 275 files passed, 1 skipped. No pre-existing failures.

- **G14 multi-limit provider default** (`defaultPublishLimit?: PublishLimit | readonly PublishLimit[]`, read through `providerPublishLimits`). *What:* a provider may declare several default publish limits that all apply, such as a per-day and a per-hour cap; a single limit still works unchanged. *Why:* FR-016, the limits audit needs more than one window per provider. *Reverse:* narrow the type back to `PublishLimit`, delete `src/providers/limits.ts`, and pass the single limit to `effectiveLimits` again.
- **G15 publish-time content validation** (`validateResolvedContent` in `execute()`, `src/server/scheduler/publishing.ts`). *What:* on a target's first step, after media is resolved and before credentials are read, the engine runs the provider's validation over the resolved content; the first error fails the target with `Can't publish to <platform>: <message>` and an attempt on step `engine-validate`, with no platform call. *Why:* FR-015, a capability lowered by a deploy after scheduling must not reach the platform. *Reverse:* delete the `ContentInvalid` class, the `validationFailed` flag and the validation block in `execute()`.
- **G16 Bluesky declares two approximate publish limits** (`BLUESKY_DEFAULT_PUBLISH_LIMITS`: 1,666 / 3,600 s and 11,666 / 86,400 s, `floor(points ÷ 3)`). *What:* enforced as declared and marked approximate (research U3). *Why:* FR-016. *Reverse:* remove `defaultPublishLimit` from the Bluesky provider.
- **Enforcement test scope (T034).** Publish-time and scheduling-time rows are driven end to end for text length and media-required (through `addToQueue` and a tick); image count, bytes and alt-text rows are driven through `validateResolvedContent`, the core both paths call, because attaching stored media needs the planner's storage. Oversize files on Instagram and Threads are compressed, not refused (D15), so they have no refusal row. Only `addToQueue` is exercised as a scheduling caller; the compose, API, job and generation callers share `gate` and are not repeated. T036 found no enforcement gap beyond G15 and Bluesky's missing limit. *Review F2:* the rows are now generated from each provider's capabilities by `tests/helpers/limit-rows.ts` and named `<provider key>: <category>`; media planner rows (formats, bytes for Instagram and Threads, width, aspect) drive `planImage` over `mediaConstraintsOf(provider.capabilities)`, a `none` publish limit is proved with an account-level limit, and Instagram's text-length row runs end to end with a stored JPEG. `limits-inventory.test.ts` requires every row to cite one of those names (or a literal title elsewhere) in the suite for its enforcement point.
- **D16/D17 same-origin guard, CSP nonce and headers** (`src/proxy.ts`, `src/lib/http/*`, `next.config.ts`, `src/app/layout.tsx`). *What:* the proxy refuses a state-changing request from another origin before anything runs, sets a per-request CSP nonce (also on the request so Next applies it) and HSTS for https; static headers sit in `next.config.ts` with the `/signup` no-referrer rule last; the root layout awaits `connection()` so every page renders per request. *Why:* Better Auth checks `Origin` only when cookies are present, and a login request without cookies from another site was accepted. *Cost:* no page is statically rendered. The proxy reads `BETTER_AUTH_URL` and `S3_PUBLIC_BASE_URL` from `process.env` directly rather than through `getEnv`, so a bad config cannot make every request throw there (startup validation owns that).
- **D18 tick refusals** (`src/server/scheduler/http.ts`). *What:* an unset secret now answers the same 401 as a wrong one, instead of 404. A query string is refused. *Why:* the 404 told a prober whether the endpoint was switched on.
- **D19 body bounds** (`src/server/http/body.ts`). *What:* `readBodyWithin` streams and cancels at the limit; used by the API pipeline and by compose-check (256 KB).
- **D20 webhook destinations** (`src/server/net/safe-fetch.ts`, `src/server/services/webhooks/destination.ts`). *What:* a `webhook` address policy (private ranges allowed, everything else refused); `postGuarded` checks the address inside the socket's lookup on a fresh connection per delivery; saves resolve the host once and refuse a refused address on the `url` field, or save with a warning if the lookup fails. *Test seam:* `setWebhookLoopbackForTests` (held on `globalThis`) is switched on for the whole suite in `tests/setup/webhook-loopback.ts` because every webhook test uses a receiver on 127.0.0.1; the destination tests switch it off. *Deviation:* the literal-address check lives in the service rather than in `webhookUrlSchema`, because that schema is shared with client code and the check needs `node:net`.
- **D21 audit guard** moved into `createAuditRepo().insert`; `recordAudit` delegates to it.
- **D25/D26 one configuration validator, reversing 007 change 6** (`src/server/startup/validate.ts`, `src/server/llm/config.ts#llmEnvIssues`, `src/server/config-registry.ts`). *What:* `validateConfiguration` merges core, connect-group and generator issues and is the only check used by `runStartup`, `src/worker.ts` and `scripts/prestart.mjs` (before it migrates). Setting any `LLM_*` or `*_API_KEY` variable without `LLM_PROVIDER`, or a malformed or incomplete generator setup, now exits 1 instead of logging; a wholly absent group only logs one "off" line. `NODE_ENV`, `PORT` and `HOSTNAME` are validated. `build:prestart` gains `--external:sharp`. *Why:* FR-031, FR-032; the same strictness in all three processes. *Reverse:* make `llmEnvIssues` return `[]` and log the problems in `runStartup`, as 007 did.
- **D28 empty means unset** (`drizzle.config.ts`, `tests/setup/global-setup.ts`, `directUrlOf`). *What:* `DATABASE_URL_DIRECT=""` falls back to `DATABASE_URL` everywhere (`||` rather than `??`). `drizzle.config.ts` inlines the rule instead of importing `directUrlOf`, since drizzle-kit does not resolve the `@/` alias. *Reverse:* switch back to `??`.
- **Spec decision: "Mark not published" requeues by default.** *What:* it moves the target to the account's next free posting slot through the same allocator the composer uses (D2–D4 below); with no free slot it becomes `failed` ("Not published — no free posting slot. Retry or schedule it."). *Why:* a person saying "it did not go out" almost always wants it to go out. *Reverse:* default `requeue` to false in the dialog.
- **Spec decision: retry keeps today's meaning.** Retry on a failed target re-arms it for the next tick and takes no slot. *Reverse:* make retry use the next free slot.
- **Spec decision: who may resolve and retry.** Anyone who may schedule posts (owner, admin, editor); every member may view Failures. *Reverse:* restrict the actions in the access statements.
- **Spec decision: external URLs are `http` or `https` only**, with no embedded credentials, wherever "Mark published" accepts one (`externalUrlSchema`). *Why:* the URL is rendered as a link (003 F15). *Reverse:* none wanted.
- **Spec decision: the Failures nav badge counts ambiguous targets only**; failed targets are counted on the page. *Reverse:* remove the badge.
- **Spec decision: webhook destinations** keep allowing `http` and private-network addresses (the owner's n8n runs on the same server) but refuse loopback, link-local, unspecified and the IPv6 edge ranges, at save time and at every delivery (D20 above). *Reverse:* tighten the shared address policy.
- **Spec decision: startup validation strictness.** A missing required variable, any malformed variable, and any half-set optional group stop startup naming each variable; a wholly absent group only logs that the feature is off (D25/D26 above).
- **Spec decision: security headers on every response**, with `Strict-Transport-Security` only when the public URL is `https`, so a local `http://localhost` run is not pinned to HTTPS. *Reverse:* send it unconditionally.
- **Spec decision: the clean-checkout verification is scripted** (D29 below) and not added to CI, since a Compose run in CI is heavy and the image build already runs there. *Reverse:* add a CI job that runs `scripts/smoke.ts`.
- **D2 `resolveAmbiguous` takes an input union** (`published` with optional `url`; `not_published` with `requeue` true or false). *What:* the legacy `outcome: "failed"` still parses as `not_published, requeue: false`, and the call returns a `ResolveResult` so the dialog can show where the target went. *Why:* FR-008. *Reverse:* revert to the two-outcome input; a separate requeue path would need its own locked transition.
- **D3 requeue transition.** *What:* inside the same `withLockedTarget` transaction it re-checks `ambiguous`, runs the content gate (a failure raises `ConflictError` and changes nothing), then calls `allocateNextFree`; success resets the attempt state and schedules, failure marks `failed` with `no_free_slot`. `publishStartedAt` is reset so the ambiguous attempt does not count against the publish limit. *Why:* one allocator and one lock keep one holder per occurrence (SC-003); loosening `queueableGate` would let Add-to-queue silently resolve a target. *Reverse:* make requeue a separate action.
- **D4 attempt outcomes `resolved_not_published` and `requeued`** (two enum values, migration 0007). Not-published without requeue still writes `resolved_failed`. *Why:* the log should not read "failed" for a target that was rescheduled. *Reverse:* none needed; existing rows never change.
- **D11 publish-time re-validation** is G15 above (`validateResolvedContent`, first step only, before credentials are read, step name `engine-validate`). Checking only on the first step means a container created on step 1 is never abandoned over a check that already passed.
- **D12 multiple default publish limits** is G14 above.
- **D22 engine pre-call failures (002 F21).** *What:* `execute()` sets `providerCalled` just before `provider.advance`; a throw while it is false is never `ambiguous`. Unreadable credentials and bad settings are `fatal_error` with a plain message, any other pre-call throw is `retryable_error`. *Why:* FR-012, a database blip before a request was sent cannot cause a duplicate and should not need a human. *Reverse:* remove the flag; pre-call throws then follow the old path.
- **D29 smoke script** (`scripts/smoke.ts`, `pnpm build:smoke`, run as `docker compose run --rm worker node scripts/smoke.mjs`). *What:* drives the mock flow against the live stack (health, project, mock account, publish now, wait for the running worker, scheduler freshness) and prints one ✓ or ✗ per step. *Why:* the clean-checkout verification must be repeatable by anyone. *Reverse:* delete the script and its build line.
- **D31 Compose hardening.** *What:* the web port binds to `127.0.0.1` by default, `MOCK_PROVIDER_ENABLED` is passed through unset by default, and no service is added. *Why:* plain HTTP on the LAN with no proxy is exposed by default otherwise (FR-036, FR-038). *Reverse:* publish `3000:3000` in `docker-compose.yml`.
- **Judgement call: the verified-run record is honest.** Docker was unavailable where this feature was built, so `docs/deployment.md` says **NOT VERIFIED** and the README marks the quick-start commands "(not run)"; a doc test refuses a claimed run without a date. *Reverse:* replace the notice with the commands, results and date once the stack has been run.
- **Judgement call: docs are tested, not trusted.** `tests/integration/docs/provider-guide.test.ts` parses `src/providers/types.ts` with the TypeScript compiler API and fails when a contract member or G1–G14 is missing from `docs/adding-a-provider.md`, or when a 004 F5 contradiction returns; `readme.test.ts` checks the README's section order, links, anchors, `pnpm` scripts and repository paths. *Reverse:* delete the two tests.
- **Judgement call (review F1): the session token in Better Auth's JSON responses is recorded, not stripped.** *What:* the secret scan signs in for real and finds the token in the sign-in body (`token`) and the `get-session` body (`session.token`) as well as in `Set-Cookie`; the test asserts those three appearances and scans everything else, and `docs/security.md` records it as a low, accepted finding. *Why:* it is Better Auth's response contract and goes only to the cookie holder; rewriting auth responses is a behaviour change beyond the review. *Reverse:* add an `after` hook that drops those fields for HTTP callers, then make the scan treat them as leaks.

### 010 — Final gate results (T074/T075)

- `git diff main -- package.json` shows script changes only (build chain, `build:prestart` externals, new `build:smoke`); no dependency added (FR-042).
- `pnpm tsc --noEmit`: clean. `pnpm lint`: 0 errors, 2 pre-existing unused `_ctx` warnings in scheduler integration tests.
- `pnpm db:check`: migrations current.
- `pnpm vitest run`: 306 files passed, 1 skipped; 2579 tests passed, 1 skipped.
- `pnpm build` (includes `build:prestart`, `build:storage-init`, `build:smoke`, `build:worker`): succeeds.
- Not verified headlessly: Docker compose bring-up and browser checks (no Docker/browser in this run).

## 011 — Account posting instructions

- **Job snapshot.** *What:* `generation_jobs.posting_instructions_snapshot` (`{ v: 1, byAccount }`) is written at job creation; the runner, deferred and manual retries and appended items all read it. *Why:* mirrors the pinned voice version, so editing an account mid-job changes 0 items (SC-006). *Reverse:* drop the column and read current instructions.
- **Migration and removal of per-platform guidance from the voice.** *What:* `0009_copy_platform_guidance` copies each project's default profile's highest-numbered version's non-empty `platformGuidance` onto matching not-removed accounts whose instructions are empty; idempotent, no audit rows. New voice input (`voiceContentInputSchema`) strips `platformGuidance`; the prompt never reads it; history shows old guidance read-only. *Why:* one source of per-channel advice (FR-023 to FR-025). Version rows are immutable, so they are not rewritten.
- **16-group limit, UNVERIFIED basis.** *What:* `assertGroupLimit` refuses more than 16 groups before any model call, on every caller. *Why:* 16 is the strictest number in the documented Anthropic structured-output limits (research R1, `docs/research/llm-and-storage.md` §2); no documented limit on required properties exists, so the real ceiling is unverified. It is one constant (`GROUP_LIMIT`). *Reverse:* raise the constant once measured.
- **2,000-character limit.** *What:* Zod `.max(2000)` on the normalised text (UTF-16 units) plus a DB check on code points, which never refuses what the service accepted. *Why:* matches the old per-platform guidance limit.
- **"Identical" rule.** *What:* accounts group when provider key and normalised instructions are equal: CRLF/CR to LF, trimmed, exact and case-sensitive, `null` equals `null`. *Why:* cheap, predictable, and the stored text is already normalised.
- **Pre-existing jobs use current instructions.** *What:* jobs with a `NULL` snapshot read each account's current instructions at run time; an over-limit result fails the item with `bad_request`, no model call. *Why:* no snapshot exists to honour (FR-018).
- **Regenerate uses current instructions.** *What:* `regeneratePost` builds groups from the live targets and their current instructions, and records them. *Why:* a regenerate is a new request, and the person expects the accounts' present settings.
- **Plan reading (a): stray `platformGuidance` is stripped.** A `platformGuidance` key in voice input (an editor tab opened before the upgrade, or an API caller) is dropped, not refused, so such a save still succeeds.
- **Plan reading (b): `/generate` limit 400 is replayed.** The too-many-groups 400 is a 4xx after the idempotency claim, so under 009 decision 7 it is stored and replayed under the same key; the replay is the refusal, not a model result.

## Release fix (2026-10-04)

- `conventional-changelog-conventionalcommits` is pinned to `^9`: `@semantic-release/release-notes-generator` 14 bundles `conventional-changelog-writer` 8, and preset 10 requires writer 9+, so releases failed on every merge to `main` until this fix. *Reverse:* move to preset 10 once release-notes-generator ships writer 9.

## Self-hosting docs pass (2026-10-04)

- **One Meta app per install, not per project.** *What:* `META_*` and `THREADS_*` stay install-wide in `.env`, and every project connects its accounts through that app. *Why:* an install has one operator, who owns the app; per-project apps would not change delegated access (Page access is granted on the Page, and Threads has no delegated access), and the app credentials are used only to connect accounts and exchange tokens (`src/providers/meta/oauth.ts`, `src/providers/threads/oauth.ts`). *Reverse:* add an optional, encrypted per-project app id and secret that falls back to `.env`, record which app issued each account's token, and keep one callback per install. Worth it only when a client must own the app (their name on the login screen, their control over revoking, isolation from a restriction on the operator's app).
- **Meta facts re-checked for self-hosters** (dated section in `docs/research/meta.md`). Business apps are documented as having no app modes, so `docs/meta-setup.md` no longer tells readers to stay in Development mode; login configurations use a User access token; Threads Testers are added under App roles. What could not be confirmed stays marked unverified in the docs.
- **New `docs/accounts.md`** for roles, who can connect accounts, the Bluesky steps (dropped from the README in 010), and scheduling for accounts other people own.

## Run-scoped test databases (2026-10-05)

- **Every test run gets its own databases.** *What:* global setup derives `<configured prefix>_<checkout>_<run id>_test` from `DATABASE_URL`, migrates it, clones it per worker and hands the URL to workers with Vitest `provide`/`inject`; the returned teardown drops everything the run created. *Why:* sessions sharing `docket_test` wiped each other's schema mid-run (random scheduler failures), and nothing was ever dropped (29 databases had piled up). *Reverse:* use the configured name again in `tests/setup/global-setup.ts`.
- **Ownership labels and a sweep.** *What:* each run database, worker clone and `createThrowawayDb()` database carries a JSON `COMMENT ON DATABASE` (run id, host, pid, start time, checkout). Every run first drops labelled `_test` databases whose owner pid has exited on this host or that are older than 12 h, and never one with open connections or without the `_test` suffix. `pnpm db:test:clean` runs the same sweep by hand (dry run unless `--yes`; `--include-unlabeled` for databases from before labels, `--keep` to spare names). Rules live in `tests/setup/test-databases.ts` with unit tests. *Reverse:* delete the sweep call; teardown alone still cleans up normal runs.
- **`KEEP_TEST_DB=1`** keeps a run's databases for debugging; the next sweep removes them once the run's process is gone.

## Design-system makeover (2026-10-05)

Full design in `docs/design-system.md`; the audit of the old UI is its §11.

- **Semantic tokens, dark mode from tokens.** *What:* `globals.css` defines surface, text, border, action, accent and four status families for light and dark; components use only those (`bg-surface`, `text-danger`, …), and the `dark:` colour twins were removed. *Why:* the old two-token theme needed ~400 opacity hacks and ~200 raw palette classes. *Reverse:* none practical; change token values instead.
- **Magenta CTA darkened to `#C2185B`.** *What:* filled magenta buttons use `#C2185B`/`#AD1457`; brand `#E91E63` stays in the logo, gradient and decoration. *Why:* white on `#E91E63` is 4.36:1, under WCAG AA. `scripts/check-contrast.mjs` enforces every pair. *Reverse:* set `--cta` back and accept large-text-only use.
- **Poppins + Inter vendored, `next/font/local`.** Supersedes decision 16's system-font stack; its constraint (no Google Fonts download at build) still holds. Files and OFL licences in `src/app/fonts/`. *Reverse:* delete the `localFont` calls; the stacks fall back to system fonts.
- **Inline SVG icons, no icon package** (`src/components/ui/Icon.tsx`). *Why:* 16 glyphs do not justify a dependency. *Reverse:* swap the component body for a library.
- **Nav grouped Publish / Create / Project.** Order within groups changed (Review now follows Compose); Review → Failures adjacency kept for the existing test. *Reverse:* reorder `NAV_SECTIONS`.
- **Avatar initials come from the user's display name only**, never the email.
- **Codemods kept in `scripts/codemods/`** (`design-tokens.mjs`, `shared-styles.mjs`). They are idempotent and document exactly how classes were mapped. *Reverse:* delete them once nobody needs the mapping.
- **UI sub-agent `docket-ui-designer` added alongside the `docket-ui` skill.** Decision 14 still stands: pipeline phases cannot spawn agents, so the skill (now pointing at the design doc) remains their guide. The agent serves interactive sessions, reading the same doc and skill. *Reverse:* delete `.claude/agents/docket-ui-designer.md`.

## 014 — X

- **G17 `exchangeCode` receives `state`** (`OAuthConnectGroup.exchangeCode({ …, state })`). *What:* the attempt's raw state, already validated, bound to the user and session and consumed, is passed to the group's code exchange. *Why:* X's OAuth 2.0 needs PKCE, and the verifier must be the same in `authorizationUrl` and `exchangeCode`. X derives it as `base64url(HMAC-SHA256(X_CLIENT_SECRET, "docket:x:pkce:v1:" + state))`, so nothing is stored and there is no schema change. *Reverse:* remove the `state` member and its pass-through in `services/connect.ts`; X would then need a stored verifier (a column on `connect_attempts`).
- **Request vs research (research wins, constitution I).** Chunked media upload for every image (the one-shot endpoint's schema is unverified). A 5xx on the create call is `ambiguous`, not retryable (no idempotency key, so it may have posted); 5xx on earlier steps is retryable. Every 403 on create is fatal and shows X's `detail`, matched on status, never on body alone. A 429 that is not clearly the rate window is held for `X_USAGE_CAP_WAIT_MS` rather than retried quickly. Only a readable OAuth error code on refresh is `needs_reauth`; anything unreadable is transient. GIF is excluded (the media library only accepts JPEG, PNG and WebP). The new generic hook is G17, not G15 (G15 and G16 were taken). The post URL is `https://x.com/<username>/status/<id>`, falling back to `https://x.com/i/status/<id>`. URL counting keeps a warning margin because Docket's URL detection differs slightly from X's. No ambiguity check against `GET /2/users/:id/tweets`, since the flow has no provider check. The constitution is not amended; this spec admits X only.
- **Interim constants (research D10, all in `src/providers/x/config.ts`).** Refresh-token lifetime 180 days (U3), refresh margin 5 minutes, refresh retry 5 minutes, default access lifetime 7,200 s, usage-cap wait 1 hour, count warning at 270, media expiry margin 60 s, status poll default 5 s (max 300 s, 30 checks). Each is one constant to change when the live value is known.
- **A refresh that succeeds without a refresh token keeps the old one.** *Why:* an omitted token must not log the account out; only a returned token replaces it.
- **Self-contained folder (D12).** `src/providers/x/` imports only generic modules (`../types`, `../validation`, `../media`, `../text`, `@/lib/docs`) and has its own small scrub and fetch wrapper (about 40 duplicated lines), so a Meta refactor cannot break X.
- **Verified with mocks only; no live check is owed.** The owner does not use X. Tests stub HTTP using the shapes in `docs/research/x.md`, and for the unverified items (U1–U9, listed in `docs/x-setup.md`) cover both a documented-looking body and an empty or unreadable one. If an X account is connected later and something differs, the setup guide asks for an issue.

## Published image and Unraid template (2026-10-05)

- **Images go to GitHub Container Registry, not Docker Hub.** *What:* `ghcr.io/jamiebclark/docket`, pushed with the workflow's `GITHUB_TOKEN`. *Why:* no account tokens to store or rotate; public GHCR pulls are not rate-limited the way anonymous Docker Hub pulls are; Unraid templates take any registry. Cost: the image is not found by Docker Hub search. *Reverse:* add a Docker Hub login and a second `images:` entry in `.github/workflows/image.yml`.
- **Pushed from the CI `release` job, not on `release: published`.** *What:* after semantic-release, the job reads the `v*` tag at `HEAD` and calls the reusable `image.yml`. *Why:* releases created with `GITHUB_TOKEN` do not trigger other workflows, so a `release` trigger would never fire. `image.yml` also runs by hand to publish an existing tag. *Reverse:* switch semantic-release to a PAT or app token and trigger on `release`.
- **amd64 and arm64, each on a native runner, merged by digest.** *Why:* an amd64-only image fails to pull on Apple Silicon, which breaks the README quick start; QEMU-emulated Next.js builds are slow and can crash. The repository is public, so `ubuntu-24.04-arm` runners cost nothing. *Reverse:* drop the arm64 matrix entry.
- **Tags `latest`, `X.Y.Z`, `X.Y`, `X`.** Pin `DOCKET_IMAGE` in `.env` to update deliberately.
- **`docker-compose.yml` pulls the image; `docker-compose.build.yml` builds from source.** *What:* the main file has no `build:`, so it works on its own after a `curl`; the override restores `docket:local` builds. *Why:* the main file is what self-hosters download, and a file with both `image` and `build` surprises both audiences. *Reverse:* put `build: .` back in `docker-compose.yml`.
- **Port binding is configurable but still loopback by default** (`DOCKET_BIND`, `DOCKET_PORT`). D31 stands; LAN exposure is now a `.env` line rather than a file edit.
- **`db-backup` service on by default.** *What:* `pg_dump -Fc` on start and every 24 h into `BACKUP_PATH` (default `./backups`), dropping dumps older than `BACKUP_KEEP_DAYS` (default 7); it writes to `.partial` and renames, so a failed dump never looks like a good one. *Why:* matches Screened's setup, and the format is the one §4 already restores. *Reverse:* delete the service.
- **Unraid template is one container with `RUN_WORKER_IN_PROCESS=true`.** *What:* `unraid/docket.xml` runs only the web container against the user's own Postgres. *Why:* a template is one container; a second worker template is easy to forget, and then nothing publishes. Optional fields ship empty because a default (e.g. `S3_REGION`) would switch on a group and fail startup; `tests/integration/docs/deployment.test.ts` enforces that and that every field is a variable Docket reads. *Reverse:* add a `docket-worker` template running `node worker.mjs` and set the flag to `false`.

## Release rules and the edge image (2026-10-05)

- **Every merge that changes the app cuts a release.** *What:* `.releaserc.json` adds patch rules for `refactor`, `revert`, `build` (any scope, since it covers the Dockerfile and build) and `chore(deps)`; `chore(deps-dev)`, `docs`, `test`, `ci`, `style` and plain `chore` still release nothing. Release notes gain "Code Refactoring" and "Build and Dependencies" sections so those patches are not blank. `tests/lint/release-rules.test.ts` runs the real plugins against sample commits. *Why:* `latest` only moves on a release, so a refactor or dependency update merged on its own never reached anyone running `docker compose pull`. *Reverse:* delete the `releaseRules` and `presetConfig` blocks.
- **`edge` and `sha-<short>` images on every green push to `main`.** *What:* the CI `edge` job calls `image.yml` with `edge: true`, which builds the pushed commit and tags only `edge` and `sha-<short>`; `latest` and version tags still move only on releases. A newer push cancels an edge build still running; release builds are never cancelled. *Why:* a way to follow `main` (and to roll back to an exact commit) without making `latest` less stable. Cost: a release push builds the same source twice, mostly from the GHA cache. *Reverse:* remove the `edge` job from `ci.yml`; `image.yml` keeps working for releases.

## 012 — Retry modes (2026-10-06)

Judgement calls from `specs/012-retry-modes/spec.md` (D1–D6) and its plan (`research.md`, P1–P12).

- **D1 — One "Retry…" dialog, "Now" preselected.** *What:* the single Retry button becomes "Retry…", opening a dialog with Now / Next free slot / Pick a time; the title names the account. *Why:* retrying immediately stays two keystrokes away and the other choices are always visible. *Reverse:* split back into separate buttons.
- **D2 — A failed target's own held occurrence counts as free for it.** *What:* the preview and the requeue both pass `ownOccurrence` to the one allocator; past occurrences are never offered; after a requeue the target holds only the new occurrence. *Why:* preview and allocation must agree, and a target should not be pushed past a slot it already owns. *Reverse:* stop passing `ownOccurrence`.
- **D3 — A refused requeue rewrites only `last_error` and logs a `retry_requested` entry.** *What:* "Not retried — {account} has no free posting slot / no active posting slots. Retry now or pick a time."; the entry has `error: "no_free_slot"` and the reason. *Why:* the person sees why, history shows someone tried, and the original failure stays in history. *Reverse:* throw a conflict instead and write nothing.
- **D4 — "Now" reports the retry instant.** *What:* the `now` result reports `scheduledAt = now`, no slot, no warnings; the stored target is unchanged from the pre-012 retry. *Why:* one result shape for every mode without altering the existing behaviour.
- **D5 — Content and account checks (`gate`) apply to requeue and at, not to now.** *Why:* `now` must stay identical (the engine validates when it runs); the other modes write a new schedule, so they refuse a post that cannot go out, as queueing and schedule-at do.
- **D6 — The requeue preview refuses a target that is neither failed nor ambiguous.** *What:* `ConflictError("This post is no longer failed.")`. *Why:* a stale dialog must not offer a slot. Side effect: a stale "Mark not published…" dialog shows that text instead of a slot.
- **P1 — Input is an exported Zod discriminated union; absent input means `now`.** Instants accept an offset (`z.iso.datetime({ offset: true })`) so the later API entry needs no widening.
- **P2 — `RetryResult` is returned for typed failures** (`no_active_slots`, `no_free_occurrence`, `in_past`, `validation`, `account_unavailable`); conflicts, permission, not-found and bad input still throw. The two no-slot codes stay distinct because their advice differs.
- **P3 — Retry lives in `src/server/services/posts/retry.ts`**, with the in-lock body `retryLockedTarget` exported for bulk retry; `withLockedTarget` moves to a module both can import without a cycle.
- **P4 — `ownOccurrence` is an option on `freeCandidates` / `peekNextFree` / `allocateNextFree`**, omitted by every other caller so their results are unchanged. Exact because the occurrence unique index allows one holder per instant.
- **P5 — Requeue holds the occurrence first, then flips the status under a `failed` guard; a guard miss throws** and rolls the hold back, so a target is never half-scheduled.
- **P6 — Refused-requeue wording and guard** as in D3; the write is guarded on `failed`.
- **P7 — "Pick a time" shares `explicitSchedulePatch` with `scheduleExplicit`;** a time not after now is refused with "That time has passed. Use Retry now instead."
- **P8 — One `retry_requested` entry per retry, no companion `requeued` entry, no migration.** `now` keeps an empty summary; requeue records `{ mode, scheduledAt, slotId, expected? }`, at records `{ mode, scheduledAt }`. Refusals that change nothing (past time, invalid content, unavailable account, conflicts) write no entry, as before.
- **P9 — `previewRequeue` stays the only preview**, gaining the D6 check and `ownOccurrence` for failed targets; ambiguous targets preview as before.
- **P10 — The dialog uses existing parts** (`SegmentedControl` cards, `Field`, `Dialog`) and the composer's `previewExplicitTime` (via a shared `explicitTimeText`) so DST wording and handling are identical; logic sits in pure helpers because there is no DOM test library.
- **P11 — Page-level `AnnounceProvider`.** *What:* the Failures and post pages keep one live region and a focus fallback (the page heading) mounted; `TargetResolution` falls back to its own region without a provider. *Why:* a successful retry removes the Failures row, which unmounted the row's live region and the dialog's focus target (also true of the pre-012 Retry button). *Reverse:* remove the provider; announcements return to the row.
- **P12 — Failures get their own docs page** (`docs/failures.md`), linked from `docs/index.md` and the README.

## 015 — Bulk retry of failed targets (2026-10-07)

Judgement calls from `specs/015-bulk-retry-failed/spec.md` (D1–D10) and its plan (`research.md`, P1–P14).

- **D1 — One short transaction per target, not one big transaction.** *What:* the run reads the matching ids without locks, then retries each target the way a single retry does: lock the post, lock its targets, re-read, apply the single-retry body, re-derive the post status, commit. *Why:* each transaction holds one post's locks and at most one occurrence of one account. That is the same order as a single retry and as queueing, so no cycle can form with the tick, a single retry, another bulk run or queueing. Nobody is blocked for longer than one target, and an interrupted run leaves finished targets retried and the rest untouched. *Rejected:* one transaction with a global lock order (it holds many post locks for the whole run and rolls everything back on any error).
- **D2 — Order is "meant to go out" order:** intended time ascending (none last), then time entered failed, then id. In requeue mode, within each account, earlier failures get earlier slots. Concurrent runs meet targets in the same sequence.
- **D3 — Skips are outcomes, not errors.** The reasons are `account_removed`, `needs_reconnecting`, `provider_unavailable`, `no_longer_failed` (including `publishing` and deleted posts, decided under the lock), `cannot_publish` (requeue gate) and `no_free_slot`. Only an unexpected error aborts the run, and committed targets stay retried.
- **D4 — Attempt logging is exactly a single retry's.** One `retry_requested` per retried target, with the actor. A `no_free_slot` skip writes the single refused requeue's `last_error` and entry. Other skips write nothing. There is no bulk-level entry and no migration.
- **D5 — Once an account is out of slots, its later targets in that run skip without an attempt** (counted `no_free_slot`, nothing written). *Why:* the answer cannot change within the run, and it keeps the work bounded.
- **D6 — At most 100 attempted targets per press,** with "{n} more failed posts were not retried yet. Press Retry all failed again to continue." Blocked and D5 skips do not count toward the cap. *Reverse/tune:* change `RETRY_ALL_CAP` (see P6).
- **D7 — A second press is safe by construction:** the set is re-read and every target is re-checked as `failed` under its own lock. A `no_free_slot` target is tried again by a later press, as a second single requeue would be.
- **D8 — The account filter is the only scope input** (`{ account?, mode }`). A foreign or unknown account matches nothing. Only `failed` targets are ever retried, whatever the tab.
- **D9 — "Retry now" is preselected,** as in the single-retry dialog. The engine's per-account spacing still applies.
- **D10 — Result shape follows `retryFailedItems`:** `changed`, `message`, `count`, plus `mode`, skip counts by reason, `remaining` and a per-account breakdown.
- **P1 — Bulk retry lives in `src/server/services/posts/retry-all.ts`** (`retryAllFailed`, `previewRetryAll`, `RETRY_ALL_CAP`). The wording shared with the UI lives in the pure `src/lib/failures/retry-all-text.ts`, so client components never import server modules at runtime.
- **P2 — Input is `z.strictObject({ account?: uuid, mode: "now" | "requeue" })`.** Extra keys such as `targetIds` are bad input, and `mode` has no default.
- **P3 — DAL `targets.listFailedForRetry({ accountId? })`** returns ids, post, account, intended and entered times in D2 order. It is unpaginated, unlocked, and uses the same `livePost` and project rules as the Failures list. `countAttention` gains an optional account filter.
- **P4 — Each attempted target goes through `withLockedTarget` + `retryLockedTarget` unchanged.** The run classifies `not failed` and blocked accounts under the lock before calling the body, maps typed outcomes to reasons, and maps `NotFoundError` / `ConflictError` to `no_longer_failed`. Any other error propagates.
- **P5 — `retryBlockedKey` is the one "blocked" predicate.** `retryBlockedReason` is built on it with unchanged sentences, and the row, the single retry, the preview and the run all use it.
- **P6 — Cap fixed at 100**, with no env knob. The implement phase records the measured wall time of a 100-attempt requeue press here, and lowers the cap to 50 if it exceeds 5 s (SC-004 allows 10 s).
- **P7 — The result is JSON-only**, always with all six skip keys and `inScope`. Per-account rows are sorted by name, with "Removed account" for removed ones. `count + Σ skipped + remaining = inScope`.
- **P8 — The preview reads only and does not depend on the mode.** It gives the in-scope count, account-level blocked counts, `willAttempt` and `capApplies`. It does not predict gate or slot outcomes.
- **P9 — Fixed message phrases**, for example "2 need reconnecting", "1 on a removed account", "3 no free slot". They are joined after "Skipped {k}: " in D3 order, and match D10's examples verbatim.
- **P10 — `failures/actions.ts`** has `retryAllFailedAction` (builds `{ account, mode }` from scratch, `refresh()` on ok) and `previewRetryAllAction`.
- **P11 — `listFailures` returns `failedInFilter`** (failed targets matching the account filter, independent of tab and page) for the label. The control is a client island keyed by the filter, so its result summary survives the refresh. Focus returns to the control while failed targets remain, otherwise it goes to the page heading.
- **P12 — `RetryAllDialog` reuses `Dialog`, `SegmentedControl` cards, `Alert` and `Button`.** It has a pending guard, an alert line, and "Some posts may have been retried. Reload the page to see where things stand." for unexpected errors. Its logic sits in pure `retry-all-ui.ts`.
- **P13 — Concurrency argument:** a bulk step holds post → targets → at most one occurrence of one account, and never waits on a post lock while it holds an occurrence. The tick never waits (`SKIP LOCKED`). Write guards on `failed` and the occurrence unique index rule out double effects. Tests force two runs, a run with a tick, with a single retry, and with queueing.
- **P14 — Docs:** a section in `docs/failures.md`, a README clause, the `docs/index.md` row wording, and this entry.
- **Measured (T017/T030/T036):** a requeue press that really attempts 100 targets (50 failed targets on each of two accounts, all given a free slot, `count` 100 and no skips) took about 2.0–2.7 s in the test database over three runs, under the 5 s threshold, so `RETRY_ALL_CAP` stays 100. An earlier figure of 1,369 ms came from a single account that had only 52 free occurrences, so it did not attempt 100.
- **Concurrency findings (T016):** forced races between two runs, a run and a tick, a run and a single retry, and a run and queueing all settled with no change needed. There was one `retry_requested` entry per target and no double holds.

## 016 — Public API retry and resolve (2026-10-07)

Judgement calls from `specs/016-api-retry-resolve/spec.md` (D1–D10) and its plan (`research.md`, P1–P15).

- **D1 — Paths.** `POST /posts/{postId}/targets/{targetId}/retry` (`retryPostTarget`), `POST /posts/{postId}/targets/{targetId}/resolve` (`resolvePostTarget`) and `POST /targets/retry-failed` (`retryFailedTargets`). *Why:* the single-target actions sit under the existing `GET /posts/{postId}/targets/{targetId}`. The bulk name mirrors `POST /jobs/{jobId}/retry-failed`, and it lives under `/targets` because it retries targets across posts and can never be confused with `/posts/{postId}`.
- **D2 — No new key permission.** All three operations need `write_posts`, which already grants `post: ['schedule']` and so lets a key queue and schedule the same posts. The UI gates retry and resolve with the same permission. Marking an ambiguous target published is the most sensitive of the three, but an editor can do it in the UI with the same right, and the action is attributed to the key. *Reverse:* adding an enum value later is backwards-compatible.
- **D3 — Typed outcomes are `200`, refusals are `409`.** Every outcome the service *returns* (`scheduled`, `published`, `failed` with `reason`/`message`/`issues`) is a `200`, as `queuePost`/`schedulePost` report `in_past` or `no_active_slots`. Every conflict the service *throws* is `409 conflict` with its user-facing sentence. A returned outcome may have written something (the no-free-slot last error and entry); a thrown conflict wrote nothing.
- **D4 — `409` bodies carry `details.reason`.** The reasons are `publishing`, `not_failed`, `account_removed`, `needs_reconnecting`, `provider_unavailable` (retry), and `already_resolved`, `cannot_publish` (resolve). *Why:* an automation must tell "wait" from "alert a person" from "already done" without parsing English. The reasons come from the predicates the service already uses.
- **D5 — Request bodies are exactly the documented shapes.** Retry takes `{mode:"now"}`, `{mode:"requeue",expected?}` or `{mode:"at",at}`. Resolve takes `{outcome:"published",url?}`, `{outcome:"not_published",requeue:true,expected?}` or `{outcome:"not_published",requeue:false}`. Bulk takes `{accountId?,mode}`. There are no defaults, extra keys are refused, and the legacy `{outcome:"failed"}` alias is not public.
- **D6 — Responses carry the outcome, not the post.** A replay returns the stored answer, so an embedded post would be a stale snapshot. Callers read current state through `GET /posts/{postId}`.
- **D7 — API actions are attributed to the key.** `publish_attempts.actor_api_key_id` and `post_targets.resolved_by_api_key_id` record the key. The user column records the key's creator only while that user row exists, and is never an empty string. The attempt log shows "API key {name}" (still the name after revoke or expiry) or "Removed API key". The post `createdBy` wording "Deleted key" is unchanged.
- **D8 — Bulk keeps 015's per-target commits under idempotency.** It claims the key, runs, then stores the answer. A crash mid-run lets a same-key retry run again, which is safe by 015 D7. Single retry and resolve keep the default mode, where the effect and the stored answer commit together.
- **D9 — The cap is visible, and continuing needs a new key.** With `remaining > 0`, the message says so. The docs say to call again with a **new** `Idempotency-Key`, because the same key replays.
- **D10 — Post/target pairing is checked before anything is written.** A wrong pairing, an unknown or foreign id, or a deleted post all give the same `404 not_found`, with no state change, attempt entry or webhook.
- **P1 — New module `src/server/api/operations/targets.ts`, OpenAPI tag `Recovery`.**
- **P2 — Strict shared schemas in `src/lib/api/schemas.ts`.** Resolve is a discriminated union nested on `outcome` then `requeue`, so a bad link is reported at `url`. Instants are RFC 3339 with an offset (`atSchema`).
- **P3 — Pairing lives in `withLockedTarget(…, { postId })`.** `retryTarget` and `resolveAmbiguous` pass it through. It is checked right after the first target read, before any lock-dependent write. A target's post never changes, so the check cannot go stale. Operations may not read repositories directly (the `api-imports` lint test).
- **P4 — `ConflictError` gains an optional `reason`.** The second constructor argument accepts `{ field?, reason? }`, and a bare string still means `field`. `mapServiceError` puts it in `details.reason`. Sentences and UI handling are unchanged.
- **P5 — One attribution helper, `actorRefs(scope)` → `{ userId | null, apiKeyId | null }`.** `actorColumns`, `attemptActor` and `resolverColumns` are built on it. It fixes the bug where an API-key scope whose creator's user row was deleted carried `userId: ""`, which every retry/resolve wrote into a `uuid` column and turned into a 500.
- **P6 — Migration `0010_api_key_attribution`.** Two nullable `uuid` columns, each with a composite FK `(project_id, col) → api_keys(project_id, id)`, like `posts_api_key_fk`. No index, no backfill.
- **P7 — `toAttemptViews` gains an `api_key` actor,** which wins over the user column. The name comes from `apiKeys.get`. The pure `attemptActorLabel` in `src/lib/failures/attempt-actor.ts` renders both pages. "Removed API key" can only happen if the FK is bypassed, and it is unit-tested with a stub.
- **P8 — New `idempotencyMode: "self_commit"`, handled exactly like `generate`,** for operations whose effects commit on their own. Only `retryFailedTargets` uses it. The name says why it is safe without implying `generate`'s request-id link.
- **P9 — The operation normalises resolve `expected` to UTC** before calling `resolveAmbiguous`, whose schema accepts `Z` only, so the public API takes offsets everywhere. Bulk maps `accountId` to the service's `account`. No service schema is widened.
- **P10 — Response mapping.** `localTime` becomes `scheduledAtLocal` (as in `TargetResult`). Warnings and issues use the shared `IssueSchema` shape through a new `operations/issues.ts`. The bulk `count` becomes `retried`, and `changed` is dropped.
- **P11 — Operations can declare OpenAPI `examples`** on the request and per response status, including error statuses. The three recovery operations do so for 200/400/401/403/404/409/422/429. The OpenAPI test asserts this for those three only; the 009 operations are not retrofitted.
- **P12 — Tests per operation** go under `tests/integration/api/endpoints/`, plus idempotency and attribution files and the scope, OpenAPI, secret-scan and attempt-view extensions. Parity with the UI is checked side by side through a member-scope service call.
- **P13 — No new locking.** The API path uses the UI's lock order inside a savepoint. One race test (two keys, one target) confirms one `200` and one `409 not_failed`.
- **P14 — Docs.** `docs/n8n.md` gets "Recover failed posts" (key `retry-{event.id}-{targetId}`, a per-target retry limit kept by the automation, never retry `ambiguous`, branch on 409 reasons, continue `remaining` with a new key) and the 409 reasons in its errors table. `docs/failures.md` gets an API note.
- **P15 — `retryAllMessage(…, { continueWith: "call" })`.** It replaces only the last sentence with "Call again with a new Idempotency-Key to continue." The UI wording is unchanged.

## Connect banner shows the platform's own message (2026-10-07)

- **G18: the accounts banner shows a group's own message.** *What:* after a failed OAuth callback, `handleOAuthCallback` passes the group's message on: the `message` of a refused `exchangeCode`, or `describeCallbackError(...).message`. It is sealed with `encryptSecret`, the AAD binds it to project, group and code, and it expires after 10 minutes (`src/server/services/connect-banner.ts`). The redirect carries it as `notice`, and the accounts page shows it in place of the generic text when it opens. A thrown exchange, a message over 500 characters, or a notice that is forged, foreign, expired or tampered with shows the generic text. The group's `callbackHint` is still appended. *Why:* the owner asked for each platform's own error ("X could not be reached. Nothing changed.") in place of "Could not finish signing in" (014 review F5). *Why sealed, not signed:* the text travels in a URL, and URLs land in proxy logs and browser history. Groups scrub secrets, but sealing keeps the text out of logs anyway, and a crafted link cannot put its own words in the banner. *Contract:* `describeCallbackError` messages are written by the provider and never echo the callback query. *Reverse:* drop `notice` from `CallbackOutcome`, the route and the page; the banner returns to the generic text.

## 017 — Requirements up front (2026-10-07)

Judgement calls from `specs/017-requirements-up-front/spec.md` (D1–D11) and its plan (`research.md`, P1–P15). Platform values come from `docs/research/meta.md` "Limits verification, 2026-10-07" and the 2026-10-07 re-check in `docs/research/x.md`.

- **D1 — The requirements summary rides on the composer's per-account check.** Each `TargetCheck` gains `requirements`, derived on the server from the provider's capabilities. *Why:* the check is already per selected account, capability-driven and refreshed on every selection change, including an empty composer. *Reverse:* drop the field; nothing else reads it.
- **D2 — Instagram's declared publish limit is 50 per 24 h.** The guide says 100, but the `media_publish` and `content_publishing_limit` references say 50, and 50 is the safe side. The existing pre-publish `quota_total` read is unchanged. Making the scheduler's spacing follow the live quota is not done (it would need a stored per-account reading). *Reverse:* raise the one constant if Meta settles on 100.
- **D3 — Facebook formats stay JPEG and PNG, now sourced to research.** Of the documented `.jpeg, .bmp, .png, .gif, .tiff`, only JPEG and PNG can be uploaded to Docket. WebP is not listed, so an uploaded WebP is still converted to JPEG.
- **D4 — Facebook bytes per file is 10,000,000** ("Files can not exceed 10MB"), written in decimal like the other providers. The 1 MB PNG recommendation is not enforced.
- **D5 — Facebook text length (10,000) and photo count (10) are kept and relabelled** "UNVERIFIED (not documented by Meta, checked 2026-10-07)", in `docs/limits.md` and in the source comments.
- **D6 — Instagram declares a minimum width of 320.** The earlier "scaled outside" note is not in the page text. The documented value is "Minimum width: 320", so the planner refuses narrower images, and the fit badges show that before the image is attached. *Reverse:* remove the declaration if Meta confirms scaling.
- **D7 — Hashtags and @mentions are counted per occurrence.** Repeats count. More than 30 hashtags or 20 mentions is a blocking issue for Instagram. *Why:* never let through a caption Meta would refuse.
- **D8 — Fit is per platform, not per account.** The planner's decision depends only on the provider's declared limits.
- **D9 — Badge coverage.** In the picker, the badges cover the composer's selected accounts. In the media library, they cover every active account in the project. With no qualifying account, there are no badges.
- **D10 — The summary is grouped into text, image and post parts.** Entry 2 adds a `video` part as a sibling of `image`, and no empty video fields are added now.
- **D11 — "No limit Docket checks" is never a number.** An undeclared field is `null` in the summary, and the UI says so.
- **P1 — `requirementsOf(caps, { uploadTypes })` in `src/providers/requirements.ts`** is pure. `checkComposition` attaches it, with `null` only for an unregistered provider. It reuses `countingRuleName`/`countingUnit`, so it always matches the counter and `text_too_long` (FR-004).
- **P2 — Display labels are computed on the server** (`JPEG`, `4:5`, `8 MB`). `UPLOAD_MIME_TYPES` and the MIME label map move to the client-safe `src/lib/media/types.ts` with the same values, so composer, picker and library UI hold no format literal (SC-004). `src/server/services/media.ts` re-exports `UPLOAD_MIME_TYPES`.
- **P3 — Caption rules are optional `text.maxHashtags` / `text.maxMentions` capabilities**, enforced in `validateAgainstCapabilities` as `too_many_hashtags` / `too_many_mentions` errors on `text`. One change reaches the composer check, the scheduling gate and the engine's publish-time re-validation.
- **P4 — Counting rule (FR-012).** URLs and email addresses are masked first. A hashtag is `#` at the start or after whitespace, punctuation or a symbol, followed by Unicode letters, digits or `_` with at least one non-digit. A mention is `@` in the same position, followed by letters, digits, `.` or `_` with at least one letter, digit or `_`. `#tag#two` counts once, because the second `#` follows a letter, the same rule as `C#`.
- **P5 — `fitOf(asset, provider)` reuses the gate's per-image path.** It applies `planFor`, then the preview item, then the provider's own validation of that one item, ignoring alt text codes. For every uploaded image, which always has dimensions, this equals the planner's decision. *Spec discrepancy:* the spec says an image with unknown dimensions is "refused, as the planner refuses undecodable images". In the code, undecodable files are refused at upload and never reach the library, and the planner sends a dimensionless row as is. The badge follows the code, so it says what publishing would do: for example, a dimensionless WebP is refused for Instagram by the type check, and a dimensionless JPEG fits.
- **P6 — `planImage` takes an optional `label`** (default `Image N`), so library badges read "This image is too wide for Instagram…". Decisions and existing messages are unchanged.
- **P7 — `fitPlatforms`.** Picker account ids are read through the project scope, and unknown or foreign ids are ignored silently. The library uses `status = "active"`. Unregistered providers are dropped. The rest are deduplicated by provider and sorted by name.
- **P8 — Fits travel with `listMedia`** through an optional `fit` input, adding `platforms` and a per-item `fit`. There is no new route.
- **P9 — UI.** Each preview card shows a one-line gist and a `<details>` list ("What {platform} accepts"), outside the preview's live region. Its details start open only when one account is selected. Badges are text plus tone ("Instagram: will be refused"), with the planner's sentences in a visible list below, and no tooltips.
- **P10 — `docs/limits.md` gains the categories `hashtags` and `mentions`.** The generated rows are `<key>: hashtags` / `<key>: mentions`, in both the core and the end-to-end text suites.
- **P11 — Instagram `minWidth` is a planner refusal only.** `validateInstagram` is unchanged. With `maxWidth` 1440, a downscale can never make an image too narrow.
- **P12 — Researched values are single constants.** The Instagram limits test moves to 50, and its fake `quota_total` stays 100, so it still proves Docket's own counter.
- **P13 — `tests/lint/ui-limit-literals.test.ts`** fails on a MIME literal, a counting-rule name, or a declared limit of 100 or more written as a literal in composer, picker or library UI code.
- **P14 — Docs.** `docs/limits.md` gains the sources and rows above, its audit notes record the 400-containers limit (not modelled), the existing Meta codes 80001 and 80002, and Bluesky's undocumented alt text maximum, and the inventory test pins the remaining UNVERIFIED rows to Facebook's text length and images. `docs/adding-a-provider.md` documents the new fields.
- **P15 — No migration, dependency, env var or `docker-compose.yml` change.**

## 018 — Video groundwork (2026-10-07)

Judgement calls from `specs/018-video-groundwork/spec.md` (D1–D12) and its plan (`research.md`, P1–P30). External facts come from `docs/research/upload-transport.md` and `docs/research/ffmpeg.md`. ffmpeg details those files mark UNVERIFIED are asserted by tests that run real ffmpeg in CI and inside the built image (P22, P23).

### Operator decisions (fixed before the entry)

- **Upload transport: presigned S3 multipart, straight from the browser to the bucket.** XHR is used per part for progress, and the server calls `ListParts` to collect the ETags, so browsers never read the `ETag` header. A chunked route through the app is the documented fallback only for buckets that browsers cannot reach. The browser-facing endpoint is a new optional setting (`S3_BROWSER_ENDPOINT`), documented with the CORS, IAM and lifecycle notes. *Rejected:* tus, which needs three dependencies and sends every byte through the app; a chunked route as the default, which costs server bandwidth and runs into body limits.
- **ffmpeg: Debian's apt package in the runner image.** It is a GPL build that includes libx264, run only as a separate process through `child_process.spawn`, with no wrapper library (fluent-ffmpeg is deprecated). `NOTICE` states that the image includes GPL ffmpeg and that its corresponding source is Debian's `ffmpeg` source package. CI installs ffmpeg for the fixture tests. This is a new runtime dependency (constitution VI), justified in plan.md Complexity Tracking. *Rejected:* static builds (per-arch downloads and checksums, no distro security updates); LGPL builds (no CPU H.264).

### Spec decisions

- **D1 — One upload path for every file.** Images and videos, in the library and in the composer's picker, share one component and one flow: browser checks, then bytes sent with progress, then processing. Images keep today's checks and results.
- **D2 — Library limits are separate from platform limits.** A video within the library limits is stored even when a platform would refuse it, and the fit badges and validation say so.
- **D3 — Library video limits.** `MEDIA_MAX_VIDEO_MB` (default 1,024, range 1–4,096) and `MEDIA_MAX_VIDEO_SECONDS` (default 900, range 1–3,600), plus a fixed 4,096 px ceiling on either side. Accepted containers are MP4 and MOV, judged by contents. Image limits are unchanged.
- **D4 — Real providers declare that they do not accept video yet.** Instagram, Facebook, Threads, Bluesky and X declare `video: { maxVideos: 0 }`. Their researched video limits arrive with entries 3, 4, 5 and 7. X video is not on the roadmap.
- **D5 — A post carries images or one video, not both, unless a provider says otherwise** (`video.withImages`). The mock declares one video, not mixed with images.
- **D6 — Transport selection.** Direct is the default. `S3_BROWSER_ENDPOINT` names the endpoint browsers use when it differs from the server's, and `MEDIA_UPLOAD_TRANSPORT=via_app` picks the fallback. The choice is never automatic, because a CORS refusal looks exactly like a network drop.
- **D7 — Resume lasts as long as the page.** Retry resumes from the parts the bucket confirmed. A reload abandons the upload, and expiry cleans it up. Leaving the page during an upload asks for confirmation.
- **D8 — Processing items can be attached but not published.** `media_processing` and `media_failed` are blocking issues from the shared validator, and they clear by themselves.
- **D9 — Location and descriptive metadata are removed from videos** by a remux without re-encoding. The result is verified, and a video that still carries such metadata is never stored. The worker needs temporary disk of about twice the file size.
- **D10 — The public API reads videos but does not upload them.** Upload and import by URL refuse video with 415 and a message pointing to the app. Recorded in `docs/feature-map.md` as unowned.
- **D11 — The generator never uses videos.** Posters as model input are recorded as unowned.
- **D12 — At most three files upload at once per page.**

### Plan decisions

- **P1 — Every upload, images included, is presigned multipart, driven by small JSON server actions.** The part size is fixed per upload at `max(8 MiB, ceil(size / 10000))`, so every part but the last is the same size, as R2 requires.
- **P2 — Sessions live in `media_uploads`, which is project-owned and belongs to one member.**
  - Only the member who started a session may sign, list, complete or cancel it.
  - A member may have 10 open sessions per project (`MEDIA_MAX_OPEN_UPLOADS`). The cap is made exact by locking the member's own Better Auth `member` row; no advisory locks are used.
  - Housekeeping expires open sessions after 24 h (`MEDIA_UPLOAD_EXPIRY_HOURS`, range 1–168). It runs wherever the scheduler runs, and the bucket lifecycle rule is the backstop.
- **P3 — Presigning uses a second S3 client.** It is set to `S3_BROWSER_ENDPOINT` (or `S3_ENDPOINT`), always with `WHEN_REQUIRED` checksums, and its URLs live 1 h. A `403` from storage is re-signed once automatically.
- **P4 — Completion is built from `ListParts`, and is idempotent.**
  - Every part's size and the declared total are checked.
  - A missing part sends the session back to Retry.
  - A size mismatch refuses the upload and removes its bytes.
  - `NoSuchUpload` during `completing` means an earlier attempt already completed it.
- **P5 — The fallback is a chunk route,** `PUT /p/<slug>/media/uploads/<id>/parts/<n>`. It checks `Content-Length` and the received length against the part's expected length, which guards against the proxy's silent truncation, and forwards the chunk as the same multipart part. The app requires `PART_SIZE + 1 MiB ≤ UPLOAD_BODY_LIMIT`.
- **P6 — The CSP gains the upload origin in `connect-src` and a `media-src`.** The origin helper is tested against the SDK's own presigned URLs.
- **P7 — Images are processed in the web process when their upload completes,** by today's `processUpload`. The results are unchanged, and no worker is needed for images.
- **P8 — Videos are processed by a worker-only media loop, outside `runTick`,** because `runTick` can run in the web process.
  - Claims use `FOR UPDATE SKIP LOCKED`, with a 120 s lease renewed every 30 s and a lease token.
  - An item gets at most 3 attempts, and a graceful shutdown refunds the attempt.
  - The loop polls every 2 s when idle.
- **P9 — The pipeline:** disk check, download, sniff, ffprobe, library limits, clean and verify, then the poster at `min(1 s, duration / 2)` with a sharp thumbnail, and a streamed multipart upload back. Commands use argument arrays, time limits, `-nostdin`, bounded output and `.tmp` outputs, and the shutdown signal reaches them.
- **P10 — The clean step:** `-map 0:v:0 -map 0:a:0? -c copy -map_metadata -1 -map_chapters -1`, in the same container family, without `+faststart` so that temporary disk stays about 2×. The output is verified on four counts:
  - the same facts and displayed size as the source;
  - format and stream tags limited to the container's own;
  - rotation re-applied if it was lost;
  - otherwise the item fails, and the source is never stored instead.
- **P11 — Video facts.**
  - The frame rate is ffprobe's `avg_frame_rate`, not `r_frame_rate`, which can far exceed a variable-rate clip's real rate.
  - Dimensions are displayed, with rotation applied. Sample aspect ratio is ignored, a recorded approximation.
  - The container comes from Docket's own sniff.
- **P12 — One magic-byte sniffer (`src/lib/media/sniff.ts`) serves both the browser and the worker.** It is tested against ffmpeg- and sharp-generated files.
- **P13 — Browser checks run in order: type, size, then for video duration and largest side, against limits served by the server.** A video the browser cannot read is uploaded with "Checks happen after upload".
- **P14 — The client engine is pure and tested in Node.**
  - It runs three files at a time and one part at a time per file.
  - A network failure is retried twice automatically, and then the row is interrupted.
  - Retry re-sends only parts that are not confirmed.
  - Progress is announced at 0, 25, 50, 75 and 100 %.
- **P15 — Processing state is shown by polling a status action every 2 s.** "Waiting for the worker" appears after 30 s queued.
- **P16 — `ProviderCapabilities.video` is required.**
  - `MediaItem` gains `kind`, `status`, `failureReason` and video facts, all optional so existing code is unaffected.
  - The shared validator checks image rules on images only, and adds the video limit codes plus `media_processing` and `media_failed`.
  - `video_not_accepted` replaces `unsupported_post_type`.
  - Videos are never planned as images.
- **P17 — The requirements summary gains a `video` part, and fit badges cover ready videos** (fits or refused, never converted). The text and image parts are unchanged.
- **P18 — The mock publishes a video through `upload_video` → `check_video` → `publish`.** `check_video` reports the video as still processing once. `StepContent` gains `videoCount`, and the account's behaviour applies at the publish step.
- **P19 — `libraryLimits()` is the single source for the services, the worker and the browser.** New settings: `S3_BROWSER_ENDPOINT`, `MEDIA_UPLOAD_TRANSPORT`, `MEDIA_MAX_VIDEO_MB`, `MEDIA_MAX_VIDEO_SECONDS`, `MEDIA_UPLOAD_EXPIRY_HOURS` and `MEDIA_MAX_OPEN_UPLOADS`. An http browser endpoint is refused when Docket runs on https.
- **P20 — Migration 0011.**
  - `media_assets.byte_size` becomes `bigint`, because 4,096 MB overflows `integer`.
  - `media_assets` gains processing and video columns.
  - A new `media_uploads` table.
  - Staging keys are `projects/<p>/uploads/<u>/source`.
- **P21 — No ffmpeg in the web process.** An import-graph test from `src/app`, the proxy, instrumentation and `runTick` enforces it, together with a `child_process` allow-list and a runtime guard set by `worker.ts`.
- **P22 — Packaging.**
  - Every Docker stage is pinned to `node:24-bookworm-slim`, and the runner gets ffmpeg from apt.
  - `NOTICE` is in the repository and in the image.
  - CI installs ffmpeg, and ffmpeg suites cannot skip in CI.
  - The `docker` job runs `ffmpeg -version`, the `libx264` encoder check and `scripts/video-smoke.mjs` in the image as uid 1001.
- **P23 — Fixtures are generated at test time with `lavfi`:** landscape, portrait, silent, MOV, rotated, located, audio-only and corrupt. Each UNVERIFIED ffmpeg detail is an assertion. Not committed.
- **P24 — API `MediaSchema` gains `kind`, `processingState`, `processingError` and `video`, an additive change.** Video upload and import give 415 with a pointer to the app.
- **P25 — The generator's library source returns ready images only, and `ensureVariant` refuses videos.**
- **P26 — A video that is not ready gets a placeholder thumbnail (`/media/video-processing.svg`),** so no thumbnail consumer changes.
  - The library shows each item's state, and a failed item offers only Delete.
  - The picker hides failed items.
  - A ready video's dialog shows its facts and plays it.
- **P27 — Deleting a video also removes its staging object.** If the worker finishes on a deleted row, it deletes what it wrote.
- **P28 — No `docker-compose.yml` edit is required.**
  - The offline profile needs `S3_BROWSER_ENDPOINT=http://localhost:9000` in `.env`.
  - An optional worker `/tmp` volume is documented with its exact edit.
  - Video processing needs the `worker` service: in-process mode processes images only.
- **P29 — `UploadPanel` replaces both upload loops,** and `uploadMediaAction` is removed. The public API keeps its buffered image path.
- **P30 — Out of scope, kept by construction.** No real provider gets video limits. Nothing re-encodes, crops or trims. Nothing handles `story` or `reel`.

### Implementation outcome

- All of Phases 1–8 landed as planned. The full gate (`lint`, `typecheck`, `test`, `db:check`, `build`) is green; lint reports only warnings.
- **Deviation:** `tests/integration/scheduler/step-content.test.ts` asserted the exact `StepContent` shape. `stepFor` now also receives `videoCount`, so the expectations were updated to include `videoCount: 0`.
- **Known flake, unrelated:** `tests/integration/x/connect.test.ts` compares an expiry against `Date.now()` and can miss by a few milliseconds under load. It passes on re-run.
- **Owed to the operator (not runnable in the pipeline):** a ~200 MB offline upload with Retry, a 1 GB direct upload to a real R2 or S3 bucket, a `via_app` upload behind a 9 MB proxy limit, and `ffmpeg -version` in the worker on Unraid (T053–T056).

## 019 — Instagram video (2026-10-07)

Judgement calls from `specs/019-instagram-video/spec.md` (D1–D13) and its plan (`research.md`, P1–P27). External facts come from `docs/research/meta-video.md` (Instagram section) and `docs/research/meta.md`. Real publishing is verified with mocks only; the owed live checks are in `docs/meta-setup.md`.

### Spec decisions

- **D1 — Feed video is a Reel shared to the feed.** Docket never sends `media_type=VIDEO` (removed by Meta on 2023-11-09). A single video is always a `REELS` container. **Feed video** (post type `video`) sends `share_to_feed=true`, and **Reel** (`reel`) sends `share_to_feed=false`.
- **D2 — The default for a single Instagram video is Feed video.** It applies when nobody chose: new targets, API posts without the field, generated and bulk posts.
- **D3 — A per-target post type choice, declared by the provider** (generic change G19, below).
- **D4 — Video limits may differ by post type** (G20).
- **D5 — Instagram's Reel and Feed video limits.**
  - The limits: MP4 or MOV; H.264 or HEVC; AAC or silent; at most 300,000,000 bytes (decimal "300 MB", the safe reading); 3–900 s; at most 1,920 px wide; aspect 0.01–10; 23–60 fps.
  - Not checked, because Docket has no facts for them: bitrate, audio sample rate and channels, scan type, GOP, chroma subsampling, edit lists and moov position. Instagram reports breaks as `ERROR`, with its detail.
- **D6 — A lowest frame rate** (G21). An unknown frame rate is not refused on it.
- **D7 — Video items in a carousel.** A carousel holds 2–10 items in any mix, all videos included. Each video item meets the Reel limits plus aspect 0.8–1.91; outside that range it is refused, not cropped (entry 6 owns cropping). No alt text is sent for video items, and the crop notice covers them.
- **D8 — Media type of a video carousel item:** omitted (plan P14).
- **D9 — Video polling.** The first check is 1 min after creation, then once a minute until 5 min, then every 5 min. The target fails at 60 min with "Instagram did not finish processing the video within 60 minutes; nothing was published", after at most 16 checks. Image containers keep 10 s doubling to 5 min.
- **D10 — Docket keeps within 400 containers per account per rolling 24 h** (G22). A target's whole need is checked and reserved before its first create.
- **D11 — Instagram fetches the video by its public `video_url`** (the stored, metadata-stripped original). There is no resumable upload; that is unowned and recorded in `docs/feature-map.md`.
- **D12 — No optional Reel fields:** no cover, collaborators, location, user tags, audio name, trial Reels or AI label. They are unowned and recorded in `docs/feature-map.md`.
- **D13 — A changed post or choice before publish restarts the target from its first create step.** Abandoned containers still count towards D10.

### Generic changes

- **G19 post type choices** (`ProviderCapabilities.postTypeChoices`, `post_targets.chosen_post_type`, `resolvePostType`).
  - *What:* a provider declares, for a post shape (`single_video` today), the post types a person may choose between, each with a label and a one-line description, and a default.
  - *Storage:* the choice is stored per target, kept while the shape does not offer it, and ignored then.
  - *Refusals:* an unoffered value gets a 400 or a form error.
  - *API:* `createPost` takes `postTypes`, and `Target.postType` is the effective type.
  - *Why:* the Reel-or-Feed-video choice without provider code in the composer or schema. Facebook (entry 4) reuses it.
  - *Reverse:* drop the column, the member and the composer fieldset; every target then uses the provider default.
- **G20 per-type video limits** (`VideoCapabilities.byPostType`, `videoLimitsFor`).
  - *What:* per-type overrides are merged over the base `video` block, and the validator, summary and badges use the target's resolved type.
  - *Instagram:* the base block holds the Reel limits, and the `carousel` override is 10 videos, mixed with images, aspect 0.8–1.91.
  - *Reverse:* remove `byPostType`; the base block applies to every type.
- **G21 lowest frame rate** (`VideoCapabilities.minFrameRate`, code `video_frame_rate_too_low`).
  - *What:* the floor is checked like `maxFrameRate`.
  - *Values:* Instagram declares 23; Facebook Reels (entry 4) needs 24.
  - *Reverse:* remove the member and the check.
- **G22 creation allowance** (`SocialProvider.creationAllowance`, `StepInfo.allowance`, table `allowance_uses`).
  - *What:* a provider declares a count per rolling window. `stepFor` says how many units a lease reserves: `units` on a first run, `retryUnits` on a re-run (`attemptCount > 0`).
  - *Enforcement:* in the claim transaction, with the account row locked, the engine sums the account's reservations in the window. It either defers the target with a message, without creating anything, or inserts a reservation. Housekeeping prunes rows after 7 days.
  - *Instagram:* 400 per 86,400 s. Its first create step of a build reserves the whole need (1, or items + 1), and any retried create reserves 1.
  - *Why:* D10, exact under concurrency, with no advisory locks (Neon). *Accepted:* it over-counts leases that fail before reaching Instagram, cannot see other apps' containers, and builds already in flight at deploy have no up-front reservation.
  - *Reverse:* drop the member, the table and the engine block.

### Plan decisions

- **P2 — `inferPostType` now calls any 2+ items a `carousel`** (it used to say `video` whenever a video was present). The validator still counts images and videos separately, so the mock's refusals are unchanged.
- **P3 — `chosen_post_type` update semantics.** An absent field keeps the value and `null` clears it, so text-only edits never wipe a choice.
- **P7 — No post update API.** FR-009's "update" applies to the service the composer uses. A public update operation is unowned (`docs/feature-map.md`).
- **P12 — Instagram video refusals** name the type ("for an Instagram Reel" or "carousel item") and end "Docket does not crop, trim or convert video yet."
- **P14 (D8) — Video carousel items are created with `media_type` omitted.**
  - *How:* `video_url` identifies them, as `image_url` identifies image items. The value is one constant, `VIDEO_ITEM_MEDIA_TYPE` in `src/providers/instagram/requests.ts`.
  - *Rejected:* `REELS`, because Reels are not carousel children per the research. `VIDEO` is forbidden by D1.
  - *Safety:* a wrong choice fails at `create_item_<n>` with Instagram's message, before anything is published. A live check is owed.
- **P16 — Status reads.** Video containers are read with `fields=status_code,status`; image-only containers keep `fields=status_code`.
  - *Why:* this is a spec-internal conflict between FR-017 ("every status read") and FR-005/SC-008 (image requests unchanged, asserted by an existing test). It is resolved for the image requirement, because the detail is only used in the video message.
- **P19 — Instagram state stays `v: 1`, with optional fields** (`REELS`, `shareToFeed`, `kinds`, `itemProgress`), so states saved by the previous release resume unchanged.
- **P20 — The 23 h guard for a carousel with video** measures from its oldest container (the first video item); otherwise it is unchanged. An item `ERROR` names its position.
- **P24 — The allowance wait** writes a `deferred` attempt and sets `lastError` ("Waiting for Instagram's daily container allowance (N of 400 used in the last 24 hours); nothing was created."). It retries just after enough reservations leave the window.
- **P26 — `docs/limits.md` uses a real `creation allowance` category** instead of the note row FR-029 asks for, so the inventory test checks it against the declaration. Per-type rows are prefixed with the type (`carousel video min aspect`).
- **P27 — No `docker-compose.yml` or `.env.example` change.** Migration `0012` runs at start-up.

---

### Implementation outcome

- **Judgement calls kept.** Status detail is read for video containers only (P16), so image requests are unchanged. `docs/limits.md` has a real `creation allowance` category (P26), so the inventory test checks it against the declaration.
- **Accepted approximations (creation allowance).** Reservations are kept when a lease fails before Instagram is called; a retried create adds 1 whether or not a container was made; other apps' containers on the same account are invisible; builds already in flight at deploy have no up-front reservation.
- **No deployment change.** `docker-compose.yml` and `.env.example` do not change (FR-031, P27). Migration `0012` runs at start-up.
- **Owed.** The four live checks in `docs/meta-setup.md`. Until then Instagram video is verified with mocks only.

## 021 — Facebook Page video (2026-10-07)

Judgement calls from `specs/021-facebook-video/spec.md` (D1–D15) and its plan (`research.md`, P1–P22). External facts come from `docs/research/meta-video.md` (Facebook Pages) and `docs/research/meta.md`. The branch and spec directory are numbered 021 because `020-activity-history` already exists in another session. Real publishing is verified with mocks only; the owed live checks are in `docs/meta-setup.md`.

### Spec decisions

- **D1 — A single Facebook video is a Page video or a Reel, chosen per target** (reuses G19). Post types `video` ("Page video", the `videos` edge) and `reel` ("Reel", the Reels Publishing API). No composer, schema or engine code is specific to Facebook.
- **D2 — The default is Page video.** Reels accept only 9:16 video of 3–90 s, so a Reel default would refuse most videos and every generated or API post with one. *Reverse:* change the declared default.
- **D3 — Facebook Reel limits.**
  - The limits: one video, no images; MP4 or MOV; H.264, HEVC, VP9 or AV1; AAC or silent; 3–90 s; at least 540 × 960; 24–60 fps; aspect 0.556–0.569 (9:16 ±1%, so 1,080 × 1,918 passes and no other shape does).
  - No size limit is declared, because none is stated. Audio sample rate, channels and bitrate are left to Facebook.
- **D4 — Facebook Page video limits:** one video, no images, MP4 or MOV, and nothing else. Facebook publishes no others, and Docket's upload limits apply.
- **D5 — Reels are uploaded by address.** The `rupload.facebook.com` request carries a `file_url` header pointing at the stored original, and no bytes. Byte upload is unowned (`docs/feature-map.md`).
- **D6 — Page videos are one `videos` request with `file_url`.** No `source` and no chunked upload.
- **D7 — Reel steps:** start → upload → upload check (repeated) → finish → publish check (repeated). Only finish may publish.
- **D8 — Polling.** Each check is first due 1 min after its request, then once a minute until 5 min, then every 5 min.
  - The upload check fails at 30 min (at most 10 checks).
  - The publish check is ambiguous at 60 min (at most 16 checks).
- **D9 — After finish, only Facebook's own error report may fail the target.** Every other outcome is published or ambiguous, and unreadable or dropped reads are checked again.
- **D10 — 30 Reels per Page per rolling 24 h** (reuses G22). Only the start step reserves (1, and 1 per retry). Page video, photo and text posts never use the allowance.
- **D11 — A Page video is published when Facebook returns its id.** There is no status polling, because it is UNVERIFIED for the `videos` edge. A later processing failure shows on Facebook, not in Docket.
- **D12 — No optional fields and no native scheduling.** No title, place, thumbnail, collaborators, draft state, `scheduled_publish_time` or link preview.
- **D13 — The Page token goes only to Meta.** The upload address must be `https` on `rupload.facebook.com` and name the started video id. Otherwise the target fails with no request.
- **D14 — Changes before finish restart from start.** The abandoned start still counts towards D10. Edits to publishing targets stay blocked as today.
- **D15 — One video per Facebook post, never with images.** Both are refused, with one message. Unowned (`docs/feature-map.md`).

### Generic changes

- **G23 steps after publishing** (`StepInfo.afterPublish`, `ambiguous.credentialsInvalid`).
  - *What:* `stepFor` may mark a step that runs after a step with `mayPublish: true` was sent. For such a lease, the engine never records failed on its own. These become **ambiguous**, with " The post may already be live; check before retrying.":
    - engine-side fatal results before the call (missing media, unreadable credentials, invalid settings);
    - a `retryable_error` reaching `maxAttempts`;
    - stale-lease recovery at `maxAttempts`, where the step is re-derived only in that branch.
  - A provider's own `fatal_error` still fails.
  - An `ambiguous` result may carry `credentialsInvalid`. The account is then flagged as for a fatal result, and the target stays ambiguous.
  - *Why:* D9 must hold on paths the provider never sees. Facebook is the first provider with a step after its publishing step.
  - *Rejected:* `mayPublish: true` on the check, because a killed worker would then be ambiguous instead of resuming, and FR-005 says only finish may publish. *Also rejected:* a lease column, which needs a migration for a rarely used flag.
  - *Reverse:* remove both members and the four engine branches. Facebook's `check_publish` then fails after 8 engine-side failures, as any other read step does.
- **Summary notes for any post type** (a fix to G20). `requirementsOf` shows `byPostType[type].notes` for the shown type, not only `carousel`. Instagram's output is unchanged.

### Plan decisions

- **P1 — The base `video` block is the Page video, and `byPostType.reel` holds the Reel limits** (the opposite of Instagram). Badges, two-item posts and unchosen videos then use the permissive limits with no special case.
- **P2 — Wording.**
  - Refusals name the type ("for a Facebook Reel") and end "Docket does not crop, trim or convert video yet."
  - A Reel aspect refusal says "Facebook Reels must be 9:16 (vertical)".
  - "Post it as a Page video instead." is added when Page video limits accept the file.
  - `too_many_videos` and `video_with_images` say "A Facebook post can carry one video and no images."
- **P4 — The allowance wait reuses G22's message,** which already says how many are used ("30 of 30 used in the last 24 hours").
- **P6 — State stays `v: 1` as a union.** The old photo shape is unchanged, and a Reel shape is added. A Page video saves no state.
- **P7 — Upload replies.** Any 2xx from rupload continues to the upload check, because the reply body is UNVERIFIED and the check is authoritative. An unreadable 2xx is not retried, because re-sending `file_url` for the same video is of unknown safety.
- **P9 — Reading `fields=status`.** One function, `readReelStatus`, reads `status.video_status` and the three phase objects. An unknown value is never complete, published or failed. "Published" needs `ready` plus a completed publishing phase or `publish_status=published`, so a bare `ready` ends ambiguous at 60 min until the live check says otherwise.
- **P10 — Facebook keeps its own pace constants,** equal to Instagram's video pace, so the two can be tuned apart.
- **P11 — "Check again" is a `continue`,** never a `retryable_error`, so checks do not count towards `maxAttempts` and only the ceilings end them.
- **P14 — Once `finishedAt` is saved, the step is always the publish check,** whatever the post now holds. Unreadable state on a video post is ambiguous, never failed, and never leads to a second finish.
- **P15 — Page video omits `published`** (Facebook's default is true). Today's tests assert that `published` is never sent on a publishing request.
- **P20 — No `docker-compose.yml`, `.env.example` or migration change.**

---

### Implementation outcome

- **Built as planned.** Page video and Reel post types for Facebook, Reel steps start, upload, upload check, finish, publish check, with G23 in the engine.
- **No deployment change.** `docker-compose.yml`, `.env.example` and migrations do not change (FR-028, P20).
- **Unowned.** Byte or chunked upload, Page video status checks, optional fields, Facebook-side scheduling, API video upload and generator video are listed in `docs/feature-map.md` (FR-025).
- **Owed.** The four live checks in `docs/meta-setup.md`. Until then Facebook video is verified with mocks only.

## 020 — Activity history (2026-10-07)

### Spec decisions

- **D1 — One event per target or account state change.** Changes that leave the state as it was write nothing: continue, deferral, a stale result, or a requeue that found no free slot. Post-level webhook transitions are not separate events.
- **D2 — Every path into a state counts.**
  - Engine settles and lease recovery are *failed* events.
  - An interrupted step that may have gone out is *ambiguous*.
  - The last retryable error is *failed* ("Gave up after N attempts").
  - An interrupted step being retried is *retrying*.
- **D3 — Resolutions are their own outcome**, counted as neither success nor problem. Successes are *published*. Problems are *failed*, *ambiguous*, *needs reauth* and *connect failed*.
- **D4 — Connect refusals are recorded with the text the person was shown:**
  - OAuth platform errors, refused or thrown exchanges, no accounts found, too many accounts;
  - token-paste refusals;
  - credential refusals, unreachable providers, and reconnecting as a different account.

  Not recorded: a cancel, a forged, unknown, expired or reused state, a caller without permission, local validation, and an empty or expired chooser.
- **D5 — The API uses the existing `read` key permission.** No new permission.
- **D6 — Paging is keyset, not offset**, so new events never repeat or skip rows. The API cursor stays opaque.
- **D7 — Days and "Today" use each project's own time zone**, including in the all-projects view.
- **D8 — Summary counts ignore the outcome filter**, and the label says so.
- **D9 — History survives post and account deletion.** Only deleting the project removes it.
- **D10 — The backfill covers current state, once.**
  - One event per published, failed or ambiguous target, at its real time, with the resolver as actor.
  - One event per account that needs reauth today.
  - It is idempotent and never duplicates live events.

### Plan decisions

- **P1 — A stored `activity_events` table, not a derived view.** Attempt outcomes cannot tell a change from a non-change (`retry_requested` with no free slot; `retryable_error` on exhaustion). Account and connect events have no attempts. The notifications entry needs durable ids.
- **P2 — One pure classifier, called at each site, inside that site's existing transaction.** Claim decisions carry `ClaimDecision.activity`, and `claimDueTargets` inserts it beside the attempts.
- **P4 — FKs and append-only.**
  - **FKs kept**: `project_id` (cascade), the actor user (set null) and `(project_id, actor_api_key_id)`.
  - **No FKs** to posts, targets or accounts, so history outlives them. An account FK would also add a post → account `KEY SHARE` lock inside `recordStepResult`, which reverses `removeAccount`'s account → post order.
  - **Append-only** is enforced by the DAL surface (insert, list, summary) and the no-raw-DB lint rule. No trigger, because a trigger would block the project-delete cascade.
- **P5 — Order is `occurred_at DESC, seq DESC`.** `seq` is a `bigint` identity column.
  - `occurred_at` is constrained to whole milliseconds, so a JS `Date` cursor is exact.
  - The cursor is base64url `{ v: 2, t, s }`.
  - Known bound: a transaction that commits after a reader passed its position can be missed by that walk. The n8n recipe re-reads with an overlap and dedupes by `id`.
- **P6 — Four indexes**: project/time, project/outcome/time, project/account/time (partial) and project/target (partial). Drizzle 0.45 has no `INCLUDE`, so none is used. SC-004 is shown by a seeded timing test.
- **P7 — `provider_keys text[]`** lets a group connect failure match each of its platforms with `@>`, without `OR`, which the scope check treats as unpinned.
- **P8 — Excerpts are read from the post at render time with `excerptOf`.** Posts are only soft-deleted, so a deleted post's row keeps its excerpt. No content is copied into events.
- **P9 — Messages and details.** Messages come from already-redacted sources. Connect messages are also redacted against the code, state or pasted token. Messages are clipped to 500 code points, enforced by a CHECK. `details` is a strict per-kind Zod union of at most 2,000 bytes.
- **P10 — The connect banner texts move to `src/lib/accounts/connect-banner-text.ts`**, so the event records exactly the banner's words.
- **P11 — All-projects queries.**
  - `forMyProjects` resolves memberships per request.
  - Each statement is a `UNION ALL` of single-project branches, each pinned to one id with its own Temporal day window and a `member` join for the caller.
  - The scope harness gains a named "project set" section: every project pin in it must be one of the caller's resolved ids.
- **P12 — One filter parser**, lenient for screens (ignore bad values) and strict for the API (400 with per-field details). Windows run from `PlainDate.toZonedDateTime` to the next day's start, so DST days are 23 or 25 hours long.
- **P14 — The backfill is a custom SQL migration (`0013`)** in the 0009 style, idempotent through `NOT EXISTS` on the target or account.
- **P15 — Failures gains `?target=<id>`** as the link target for still-failed or still-ambiguous rows. Other rows link to the post or to Accounts.
- **P16 — Screens.**
  - Routes: `/p/[slug]/activity` (Publish group, after Failures) and `/activity` (linked from the user menu and the project switcher).
  - Filters are GET search parameters.
  - A new `CursorPagination` atom.
- **P17 — `GET /api/v1/activity` (`listActivity`)**, with tag Activity, permission `read`, and the same filters and cursor.
- **No change** to webhooks, env vars, dependencies or `docker-compose.yml`.
- **Done by the front end:** `.claude/skills/docket-ui/SKILL.md` lists `/activity` and the Activity nav item. The pipeline could not write it.

### Implementation decisions

- **I1 — SC-004 is asserted by a seeded timing test** (`tests/integration/activity/performance.test.ts`): 100,000 events in one project and 200,000 across a member's 20 projects, seeded with `generate_series`. Every filter combination must return its first page and counts in under 1 s. On a development machine the slowest was about 0.6 s (all projects, no filter). The test logs `EXPLAIN (ANALYZE, BUFFERS)` for the slowest combination.

### After review (front end, 2026-10-08)

- **Migrations renumbered on merging main.** Main gained `0012_sudden_scarlet_spider` (019, Instagram video) while this branch was open. The activity schema is regenerated as `0013_foamy_colleen_wing.sql`, byte-for-byte the reviewed SQL, and the backfill is `0014_backfill_activity_events.sql`.
- **All-projects list: limit before joining.** CI measured 1.3 s for the unfiltered all-projects first page at 200,000 events, against the 1 s budget. Each per-project branch had joined posts, targets, accounts and members over all of its rows before sorting. Now each branch takes its `limit + 1` events off the `(project_id, occurred_at, seq)` index first and joins only those. The joined tables are pinned through `projects.id = $n` so the scope harness still sees every table pinned. The summary is one `UNION ALL` query instead of one per project, and actor names load in parallel. Measured on a loaded development machine: the list went from 1,720 ms to under 340 ms.

## 023 — Threads video (2026-10-08)

Judgement calls from `specs/023-threads-video/spec.md` (D1–D12) and its plan (`research.md`, P1–P21). External facts come from `docs/research/meta-video.md` (Threads) and `docs/research/meta.md`. The branch and spec directory are numbered 023 because `022-problem-notifications` already exists in another session. Real publishing is verified with mocks only; the owed live checks are in `docs/meta-setup.md`.

### Spec decisions

- **D1 — A single Threads video is a `VIDEO` post; there is no "Post as" choice.** One container with `media_type=VIDEO`, `video_url` and the text. Post types become text, image, carousel and video.
- **D2 — Threads video limits.** MP4 or MOV; H.264 or HEVC; AAC or silent; at most 1,000,000,000 bytes (decimal); at most 300 s, with no minimum; at most 1,920 px wide; aspect 0.01–10; 23–60 fps. Bitrates, sample rate, channels, scan, GOP, chroma, edit lists and moov placement are left to Threads, whose refusal is explained (D7).
- **D3 — Carousel video items.** 2–20 items in any mix, all videos included, with the same limits as a single video. Items are created with `is_carousel_item=true`, `media_type=VIDEO` and `video_url`, with no text and no alt text.
- **D4 — No alt text for video,** sent or checked. Image items keep theirs.
- **D5 — Video items are checked before the carousel is created.** It is UNVERIFIED whether Threads waits on its own. `ERROR` fails, naming the item; `EXPIRED` recreates the whole post. *Reverse:* drop the item checks once a live check shows Threads waits.
- **D6 — Video pace.** The first read is 30 s after creation, then once a minute until 5 min, then every 5 min. The target fails at 60 min after at most 17 reads. Image and text pace and the 5-minute cap are unchanged.
- **D7 — Plain explanations** for `FAILED_DOWNLOADING_VIDEO`, `FAILED_PROCESSING_VIDEO`, `INVALID_DURATION`, `INVALID_FRAME_RATE`, `INVALID_BIT_RATE` and `INVALID_ASPEC_RATIO` (Threads' spelling). Any other message is shown as sent, with secrets removed.
- **D8 — `video_url` is the public address of the stored original.** There is no byte, chunked or resumable upload (UNVERIFIED for Threads).
- **D9 — Outcomes unchanged.** Only `publish` may publish. Everything before it is retryable or fatal, never ambiguous. `PUBLISHED` while checking is ambiguous.
- **D10 — A changed post restarts from the first create step.** The state records the post kind, each item's kind, each video item's creation time and whether it is finished.
- **D11 — No new rate or creation limit.** 250 posts per 24 h. A carousel counts once. No container cap is documented.
- **D12 — One set of video limits** for the summary and the badges. The badge is "fits" or "will be refused", never "will be converted".

### Generic changes

These are fixes to existing helpers, inert for every provider before this entry.

- **"Post as" only with a choice** (a fix to G20). `requirementsOf` sets `video.postType` only when the provider declares `postTypeChoices`; a `byPostType` entry alone no longer turns it on. Instagram and Facebook are unchanged. *Why:* Threads declares carousel limits but has no choice, and would otherwise show "Post as: video".
- **Gigabyte labels.** `videoBytesLabel` prints GB from 1,000,000,000 bytes ("1 GB", "1.05 GB"). Smaller values are unchanged.
- **Enforcement rows for a carousel override.** `videoRows` skips the single-video `videos` and `video with images` rows when `byPostType.carousel` is declared, as it already did with a choice. Such posts resolve to a carousel, which the override allows. The two `docs/limits.md` rows cite the shared validator test, as Instagram's do.

### Plan decisions

- **P1 — The base `video` block is the single video** (1 video, no images). `byPostType.carousel` allows 20 videos mixed with images and gives the summary its carousel line. `byPostType.video` carries only the "9:16 recommended" note.
- **P4 — `validateThreads`.**
  - The image planner skips video items; it used to refuse a narrow video as `image_too_small`.
  - Video refusals end "for Threads. Docket does not crop, trim or convert video yet."
  - `too_many_items` is raised only for mixed posts over 20, so image-only results are unchanged.
- **P5 — Docket's 10-item post cap (`POST_MEDIA_MAX`) stays.** It already stops image carousels at 10 for every provider. Threads still declares its real 20, and 20-item carousels are proved at provider level. Raising the cap is unowned (`docs/feature-map.md`). This deviates from US2 #5 end to end.
- **P8 — State stays `v: 1`.** `mediaType` gains `VIDEO`, plus optional `kinds` and `itemProgress`, so in-flight image targets resume unchanged.
- **P10 — Threads keeps its own video pace constants,** equal in shape to Instagram's, so the two can be tuned apart.
- **P11 — Item reads fall due 30 s after each item's own creation.** After an `IN_PROGRESS` read, the next is due at the video pace. A finished item is never read again.
- **P12 — Every status read records `errorMessage`** (sanitised, at most 300 characters, token scrubbed) when Threads sends one, image reads included. The field is additive; image messages and outcomes are unchanged.
- **P13 — Error codes are matched as whole tokens, case-sensitively,** in one function. Figures come from the declaration. *Reverse:* if the live check shows another `error_message` form, only that function changes.
- **P14 — A refused create on a post with video says "Media must be at a public URL".** Image posts keep "Images must …".
- **P15 — The 23-hour guard measures from the oldest container,** video items included.
- **P19 — New test files only.** Existing Threads suites stay byte-for-byte unchanged.
- **P21 — No `docker-compose.yml`, `.env.example`, migration or dependency change.**

### Implementation outcome

- Built as planned: the `VIDEO` container, video carousel items checked before the parent, the video pace with its 60-minute ceiling, plain error explanations, and the shared limits for summary and badges.
- Three generic fixes landed (inert for other providers): "Post as" only with a declared choice (P2), gigabyte labels (P3), and no single-video enforcement rows when a carousel override is declared (P6).
- P5: the 10-item post cap (`POST_MEDIA_MAX`) was kept, so no post reaches Threads' 20 items from the composer.
- P12: `errorMessage` is now recorded on image status reads as well as video reads.
- No compose, env, migration or dependency edit was needed (FR-025, P21).
- Live checks are owed by the operator (`docs/meta-setup.md`, "Threads video: owed live checks").

## 022 — Problem notifications (2026-10-08)

### Spec decisions

- **N1 — Attention events are the *Problems* preset, minus other people's connect attempts.** Failed, ambiguous and needs reauth count for every member. Connect failed counts only for the member who tried; with no recorded actor it counts for nobody. Published, retrying and resolved never count. The count, the panel and the callout use the same rule.
- **N2 — Unread means "newer than where you last looked", not "still broken".** A problem stays unread until it is marked read, even after it has been fixed. **Half reversed by 056's N14**: the half above still stands, but "stays unread until *the whole project* is marked read" is reversed — a person may mark or snooze one problem without touching the rest or moving the floor past anything else. Nothing written under the old rule changes: `notification_states` rows and their `seen_seq`/`muted` are untouched.
- **N3 — One position per person per project, and it only moves forward.** There is no per-event read state. **Reversed by 056's N13**: `seen_seq` stays as a floor exactly as before, but a sparse per-event mark may now exist above it, for one person, one project and one event. No data written under the old rule changes — there was never a per-event row, so the new table simply starts empty.
- **N4 — Exactly three things mark read**:
  1. "Mark all as read" (every project the person belongs to, muted or not);
  2. the project's Activity with the *Problems* preset and no other filter, first page;
  3. All activity with the *Problems* preset and no other filter, first page (the projects it covers).

  Opening the panel, other Activity views, paging and prefetching mark nothing.
- **N5 — Muting is personal and hides; it does not delete.** Events stay in Activity. Notifications are on by default. **Extended by 044's N45** for the email channel specifically: email defaults *off* even where in-app notifications are on, because an inbox is not a badge a person only sees when they come looking.
- **N6 — Unmuting starts fresh**: turning notifications back on marks the project read at that moment. **Unaffected by 044**: email has its own forward-only mailed-through position (N55) and does not move the read floor, or move with it.
- **N7 — Starting points.**
  - A new member starts at the moment they joined.
  - A rejoin starts again.
  - The first deploy marks everything up to then as read.
- **N8 — Leaving deletes the state**, in the same transaction as the membership; it also goes with the project or the user.
- **N9 — The bell is always shown; the count hides at zero.** The display is capped at "99+", and counting stops at 100.
- **N10 — Muting is edited on a personal Notifications page** (linked from the user menu and the panel) and on each project's settings page, for every role. **Extended by 044's N46**: email cadence, hour, zone and quiet hours join that same personal page as one more card; which problems may be mailed is still the per-project rule above, not a second one.
- **N11 — The callout appears on the project home and on Posts.**
- **N12 — The refresh is quiet.** It runs every 60 s while the tab is visible and once on becoming visible. It is announced politely only when the count rises. **Reversed in its first half, kept in its second, by 045's N79/N80/N70**: the poll is replaced by a server push as the primary path, with the poll kept as its fallback; the announce-on-rise-only rule stands unchanged, because it was never about the transport. Nothing migrates — N12 stored no data.

### Plan decisions

- **R1 — A `notification_states` table**, one row per membership: `seen_seq`, `seen_at` and `muted`. **Extended by 044's E6–E8**: email adds its own per-person settings row and a per-person-per-project position row, on the same cascade-with-the-membership rule, rather than growing this table with a second channel's bookkeeping.
  - The primary key is `(project_id, user_id)`.
  - A composite FK to `member (organization_id, user_id) ON DELETE CASCADE` deletes the row with the membership, project or user, in the same statement.
  - It is not columns on Better Auth's `member`, where marking would contend with `lockSelf`.
- **R2 — The position is `activity_events.seq`, not a time.** `occurred_at` is the writer's clock taken before commit, and it is historical for the 0014 backfill.
- **R3 — Marking read is exact.** This closes 020's P5 bound for notifications.
  - **Writers.** `ActivityRepo.insert` takes `FOR KEY SHARE` on the project row before drawing `seq`. The FK check takes the same lock anyway, but only after the row is formed.
  - **Marking.** Each mark is its own transaction, in this order:
    1. `SET LOCAL lock_timeout = '2s'`;
    2. the project row `FOR UPDATE`;
    3. a membership re-check;
    4. the newest attention `seq`;
    5. `GREATEST` upsert.
  - **Why it is exact.** A writer that locked first is waited for, and its event is covered. A writer that locks later draws a larger `seq`, and its event counts.
  - **Deadlocks.** There are none: a mark waits only on its one project row, and only before it holds any other lock.
  - **Timeouts.** A timeout marks nothing.
  - **Nothing new.** When no attention event is newer than the position, the lock is skipped.
  - **Invariant.** The `seq` identity sequence must keep `CACHE 1`.
- **R4 — Two partial indexes on `activity_events`.**
  - `(project_id, seq)` where the outcome is failed, ambiguous or needs reauth.
  - `(project_id, actor_user_id, seq)` where the outcome is connect failed.

  They serve counting and the newest position. The panel reuses the outcome/time index, with one branch per outcome. Outcome lists are SQL literals, so partial-index matching works. These are the only changes to the log.
- **R5 — One counting statement over the caller's resolved set**, in the project-set section.
  - Each project contributes two branches.
  - Each branch re-joins `member` for the caller and the unmuted state, and is limited to 100, under an outer limit of 100.
- **R6 — Starting points are written with the membership**: `createProject` at 0, and `MembersRepo.insert` at the newest attention `seq` under the existing project lock. Custom migration `0016` starts every existing member at the global `max(seq)`. A missing row counts nothing and is repaired on the next write.
- **R7 — "The *Problems* preset" is the existing URL `?outcome=problems`.** The spec's `preset=problems` refers to it, and no parameter is added. The view qualifies only with no platform, account, range or dates, and with no `before` or `after`.
- **R8 — The view mark runs once per request.** A React-cached `ensureProblemsViewMarked()` reads the URL that the proxy forwards in `x-docket-path`. The bell calls it before counting, and both activity pages call it before listing, so the header count is right even without JavaScript.
- **R9 — Prefetches never mark.** Requests with `next-router-prefetch`, `next-router-segment-prefetch`, or a `Sec-Purpose` / `Purpose` header containing `prefetch` are ignored. This matters because a prefetch of a route with `loading.tsx` renders the layout and so the header. Links to problems views also set `prefetch={false}`.
- **R10 — The bell is a link to `/notifications` without JavaScript, and a disclosure button with it.** Its non-modal panel loads `GET /api/me/notifications/recent` when opened. `router.refresh()` is never used, because it would re-mark a problems view. **Kept deliberately by 045's N82/S31**: a stream push also never marks a problems view and never calls `router.refresh()`.
- **R11 — Two session-only GET routes under `/api/me/`.**
  - API keys get 401.
  - No input is read.
  - Responses carry `Cache-Control: private, no-store` and `Vary: Cookie`.
  - `/api/me/` is a public prefix in the auth gate, so a cookie-less request gets 401 instead of a login redirect. **Extended by 045's N68/S10**: the new stream route under the same prefix answers the identical 401, byte for byte, and reads no input either.
- **R12 — The poller is pure, injectable logic**, tested without a DOM. It also refreshes at once on a `docket:notifications-changed` event. **Left untouched by 045's S25/S26**: `poll.ts` is not edited; it becomes the fallback leg of a new supervisor that reuses its own refresh-on-entry hook.
- **R13 — Mutations are server actions over the caller's own resolved projects.** An unknown project and someone else's give the same "not found". The proxy's same-origin check refuses forged POSTs. The only allowed `returnTo` is `/notifications`.
- **R14 — Muting UI.** Each project has one form with a single "Turn off" / "Turn on" button, named with the project, and its state shown as text. A redirect confirms the change, so it works without JavaScript. **Extended by 044's E18/E29**: the email settings card is one form with one Save button on the same no-JavaScript, redirect-confirms shape; its pause/resume control is its own one-button form, the same pattern as this toggle.
- **R15 — The callout is a warning `Alert` with `role="status"`**, so it is polite. Screen readers rarely announce a status region that is present at load, so its place first in `main` is what makes it found. **Reused by 045's N70/S27**: the stream and the poll share one announce-on-rise-only baseline, so switching between them neither re-announces nor misses a rise.
- **R16 — A `RelativeTime` atom.** `SchedulerHealth`'s `ago()` wording moves to `lib/time/relative.ts`, with unchanged output. The absolute time and zone are the tooltip and screen-reader text.
- **R17 — No change** to dependencies, environment variables, the public API, webhooks, event kinds, filters or `docker-compose.yml`. **Owed to the operator:** `.claude/skills/docket-ui/SKILL.md` should list `/notifications` and the bell. The pipeline cannot write it.

## 024 — Per-target video formatter (2026-10-08)

Judgement calls from `specs/024-video-target-formatter/spec.md` (D1–D18) and its plan (`research.md`, P1–P27). External facts come from `docs/research/ffmpeg.md` and `docs/research/meta-video.md`. Exact ffmpeg option spellings the research marks UNVERIFIED are confirmed by a CI test against the installed tool's own help (P6). Real publishing of adapted videos is verified with mocks only; the owed live checks go in `docs/meta-setup.md`.

### Spec decisions

- **D1 — One edit per video in a post, shared by all its targets.** The edit holds a trim (default the whole video), a fit (crop, blurred pad or colour pad; default blurred pad), a pad colour (default black), a focal point (default the centre) and "use each platform's recommended shape" (default off). Each carousel video has its own edit. *Reverse:* per-target overrides on the same record.
- **D2 — Reframe only when required or asked.** It happens when the shape is outside the target's range, or when the person asks for the recommended shape and the target declares one. The new shape is the recommended one if it is in range, otherwise the nearest end of the range.
- **D3 — Crop and pad.** Crop keeps the largest area of the new shape, as close to the focal point as the frame allows. Pad centres the whole frame on a blurred copy or a solid colour. The focal point is set on the poster frame as displayed.
- **D4 — Never enlarge the picture.** Sides are even. The output is reduced to the target's maximum, and a target refuses a video below its minimum, saying what it has and what it needs.
- **D5 — Trim.** Start and end are set to a tenth of a second, keeping at least 1 s. Each target keeps up to its maximum, with a visible note, and refuses a kept part below its minimum. A trimmed video is always re-encoded.
- **D6 — As is, rewrap or re-encode.** A re-encode is H.264 High 8-bit 4:2:0 with closed GOPs, plus AAC (≤ 48 kHz, ≤ 2 channels), in MP4 with the index at the front. The frame rate is clamped to the target's range. Silence stays silent.
- **D7 — New declared limits.** These are the maximum video bitrate, the audio encode bitrate, the maximum sample rate and channels, a recommended aspect and "index at front". Instagram: 25 Mbps; Threads: 100 Mbps; 128 kbps, 48 kHz and 2 channels; 9:16 recommended for Reel and Feed video, Threads single video and Facebook Reel. Megabits are decimal. "128 kbps" is the encode target, not a refusal limit.
- **D8 — One planner,** with the image planner's pattern. Its answer drives the composer, badges, summary, gate, worker and publishing. Identical requests share one version.
- **D9 — Every video operation runs in the worker,** under leases, with a length-scaled time limit, 3 attempts, configurable concurrency (default 1) and the soonest due first.
- **D10 — Full versions are built for scheduled, queued and published-now posts,** and again on change. Drafts get previews only. A vanished file is rebuilt.
- **D11 — A due target waits for its version.** It makes no provider call and uses no attempt, and shows "Preparing video for <platform>". It fails with "The video could not be adapted for <platform>: <reason>" when the version fails or after 2 hours. Retry queues the version again.
- **D12 — A preview per target, at most 640 px with sound.** It is never a gate.
- **D13 — Every output is read back** against the plan and the limits before use.
- **D14 — Size fitting by computed bitrate and bounded retries,** never by truncating the file.
- **D15 — Badges say "fits", "will be adapted" (with the steps) or "will be refused".** The summary says what Docket adapts and what it cannot. The "Docket does not crop, trim or convert video yet." suffix is removed.
- **D16 — Edits follow the post's role and locking rules.** Versions belong to the video's project, live in the same bucket, are deleted with the video, and are removed when no current edit refers to them.
- **D17 — Mock, Instagram, Facebook and Threads use the formatter through capabilities only.** Bluesky (entry 7) and TikTok (entry 8) get it by declaring limits.
- **D18 — Stored originals get their index at the front from now on** (still a stream copy). Older originals are not rewritten; they get a rewrap when a target needs it.

### Plan decisions

- **P1 — `planVideo` is pure** and lives in `src/providers/video-plan.ts` beside `planImage`. It returns `original`, `derive{rewrap|encode}`, `refuse` or `checking`. The worker builds only from the frozen recipe; it never re-plans.
- **P2 — A version's key is the hash of its numeric recipe** (with `VIDEO_PIPELINE_VERSION` and the kind), not of the raw limits.
  - Identical limits and edits always share a version, and so do different limits that give the same output.
  - Fields that do not affect the output do not rebuild.
  - A result for a stale edit is never looked up.
- **P3 — Geometry is in even integers, computed in Node.**
  - **A padded canvas's long side is at most the larger of the source's long side and 1,920 px.** D4 allows a canvas larger than the source, but unbounded it would be 1920×3413 for a 1080p clip padded to 9:16. With the bound it is 1080×1920 (the platforms' recommendation), and a small source still gets a larger canvas: 640×360 becomes 640×1138, which meets Facebook's 540×960.
  - A reframe within 0.5% of the source shape is no reframe.
- **P5 — Mode order.** Re-encode wins over rewrap, which wins over as is. When ffprobe gives no stream bitrate, the bitrate is estimated from the file size (an upper bound, so nothing is assumed to fit). A rewrap keeps the source container when the target accepts it, and reuses entry 2's verified remux.
- **P6 — Encode settings.** libx264 High yuv420p, `veryfast`, CRF 23 with `-maxrate`/`-bufsize` only when capped, a 2 s GOP, AAC 128 kbps by default, and faststart. Every option spelling is checked in CI against `ffmpeg -h` (the research marks several UNVERIFIED; the planning machine had no ffmpeg).
- **P8 — The size floor.** The planner refuses up front when the size budget leaves under 150 kbps for video. The worker tries at most 4 encodes: two bitrate corrections, then one at 0.75× resolution.
- **P9 — New facts.** Bitrates, sample rate, channels and index position are recorded with `facts_version = 2`. Videos stored before this entry are marked 1; the worker re-reads each once (the file is not rewritten), and their badge says "checking" until then. After 3 failed reads, they are refused with "upload it again".
- **P10 — Edits live in `post_video_edits`,** not `post_media`, because `setMedia` rewrites `post_media` on every save. No row means the default edit, so API, generated and bulk posts get the default with no write.
- **P11, P12 — `video_versions` holds both full versions and previews.** The worker loop has `VIDEO_ENCODE_CONCURRENCY` lanes (1–4, default 1).
  - Work runs due soonest first; a preview is due when it is requested.
  - The time limit per attempt is `min(60 min, 2 min + 2 s per kept second)` for a full version and `min(15 min, 1 min + 0.5 s per kept second)` for a preview.
  - Output is uploaded only after the readback, and marked ready only while the worker holds the lease and the video is live.
  - A `video` heartbeat at most once a minute.
- **P13 — The claim-time gate.** The wait happens in the tick's claim decision, on the first step only, with DB reads and pure planning: no tool, storage or provider call, no attempt row and no lease. It sets `post_targets.video_wait_since`.
  - **It does not wait in `execute()`:** `release()` would write an attempt row every tick for up to 2 hours and set `publishStartedAt`.
  - **When no worker is running** (no `video` heartbeat for 10 minutes), the two-hour failure says "video adapting needs the worker process, which is not running".
  - **A lost version object** requeues the version (one `released` row). Nothing is ever built in the tick.
- **P14 — `syncVideoVersions` runs after the commit** of queue, schedule, publish-now, edit and retry. It requeues failed versions on scheduling and retry. Any miss is healed by the claim-time gate.
- **P16 — Previews only for re-encodes.** A rewrap is visually identical, so its preview is the original, marked "rewrapped".
- **P17 — Cleanup in housekeeping.** At most 20 rows per tick, after 24 h unrequested and unchecked. It recomputes the keys wanted by every post using the video, and deletes unwanted rows and their objects. It needs no ffmpeg.
- **P18 — Badge states.** `FitState` gains `adapted` and `checking`; images keep "will be converted". The summary gains "Docket adapts" and "Docket cannot fix" lists.
- **P19 — The gate sees the planned output for `derive`.** A missing version never fails the gate, because versions are built after scheduling. `checking` is a note, not an error.
- **P20, P21 — The composer edit dialog.**
  - Trim fields in `m:ss.s`, a fit control, a colour field and the recommended-shape checkbox.
  - The focal point marker is a keyboard slider: arrows move 5%, Shift + arrows 1%, Home centres it, with live announcements.
  - Edits travel as `videoEdits` in the composer's own schemas, never the public API's. The server checks them against the video's length.
- **P22 — One new optional setting, `VIDEO_ENCODE_CONCURRENCY`.** There is no required `docker-compose.yml` change. The optional `/tmp` volume edit is restated with the encode's disk needs: about the source plus twice the output.
- **P24 — Mock limits.** The mock declares a full small set (8 Mbps, 128 kbps, 48 kHz, 2 channels, index at front, 1,920 px, 9:16 recommended). Test factories default the new facts to fitting values, so existing as-is tests keep their outcome.
- **P25 — Generated enforcement rows change meaning.** Rows for limits the formatter now adapts (too long, too big, aspect, frame rate, codecs, container, bytes, bitrate, audio, index) become "adapted" rows proved by the video planner. Rows for what it cannot fix (too short, too small, counts, mixing, silence) stay refusals. This goes beyond FR-042's "wording only" for these generated rows, and SC-001 requires it.
- **P26 — SC-007 is measured in the docker CI job** with `--cpus=2` and recorded here in the implementation outcome.

### 024 — Implementation outcome

**What shipped.** A per-target video formatter: a pure planner (`src/providers/video-plan.ts`) picks as is, rewrap, re-encode or refuse for each target; the worker builds and reads back versions and previews (`src/server/video/`); the scheduler waits for versions at claim time; housekeeping removes stale versions; the composer has a video edit dialog (trim, fit, focal point, fill colour), previews and "adapted" badges. Existing providers declare the new limits; a new provider gets the formatter by declaring them.

**Judgement calls.**
- **P3 — canvas ceiling.** A padded canvas's long side is at most the larger of the source's long side and 1,920 px (1080×1920 for a 1080p clip padded to 9:16).
- **P25 — enforcement rows.** Generated rows for limits the formatter now adapts become "adapted" rows; rows for what it cannot fix stay refusals. This goes beyond FR-042's "wording only", and SC-001 requires it.

**Existing-test expectations changed.**
- `tests/integration/facebook/reel-refused.test.ts`: a 16:9 Reel is now adapted rather than refused, so the test uses a 2 s 9:16 Reel (too short, which cannot be fixed) and checks the "for a Facebook Reel" wording.
- `tests/integration/threads/video-fit.test.ts`: the fixture gained the new facts (bitrates, sample rate, channels, index position, facts version 2); a 120 fps video is now "adapted" (frame rate lowered) rather than "refused"; "never converted" no longer asserts empty `steps`.
- Earlier phases changed the unit expectations in `src/providers/*.test.ts`, `composer` and `requirements-ui` tests for the new wording and states.

**What ran where.** Locally: `pnpm lint` (0 errors, 18 pre-existing-style warnings), `pnpm typecheck`, `pnpm db:check`, `pnpm build` all passed; `pnpm test` ran 4,235 passing. This machine has **no ffmpeg**, so the ffmpeg suites and `scripts/video-smoke.ts --formatter` did **not** run here; they are owed to CI (docker job, which now runs the `--formatter` smoke at `--cpus=2`). Timing-sensitive suites (`activity/performance`, `notifications/performance`, `retry-failed-targets` cap, `retry-all-cap`, `jobs/budget`) fail on timeouts or thresholds only when the full run loads the machine; alone, all but `activity/performance` (1.0-1.2 s against a 1 s limit, unrelated to video) passed.

**SC-007** (30 s preview at `--cpus=2` within 60 s) is not yet measured; see T061.

## 025 — Bluesky video (2026-10-08)

Judgement calls from `specs/025-bluesky-video/spec.md` (D1–D13) and its plan (`research.md`, P1–P22). External facts come from `docs/research/bluesky-video.md` and `docs/research/bluesky.md`; library shapes were read from the installed `@atproto/api` 0.22.0. Real publishing of Bluesky video is verified with mocks only; the owed live checks go in `docs/accounts.md`.

### Spec decisions

- **D1 — A Bluesky video post is one video and nothing else.** Post types become text, image, carousel and video; two videos, or a video with images, are refused before scheduling. No post type choice.
- **D2 — Declared limits.** MP4; H.264; AAC or silent; at most 300,000,000 bytes; at most 180 s (the research's conservative product limit; the client's 10 minutes is unverified as a server limit). No other bound is declared. *Reverse:* raise to 600 s after a live check; drop the codec lists once Bluesky publishes them.
- **D3 — Upload in parts, one part per step,** so every step stays inside the provider time limit and a large upload resumes where it stopped. Host and auth of the parts calls are UNVERIFIED. *Reverse:* the single-request `uploadVideo`, only for files that fit one step.
- **D4 — Service tokens per step, never kept,** scoped to the method, expiring at most 5 minutes after the request. Upload calls use the account's PDS as audience; the limits and status reads use the video service (UNVERIFIED).
- **D5 — Upload limits are checked before an upload starts.** A refusal waits an hour and checks again; a refused check (other than a rate limit or server error) is skipped and the start's own `DailyLimitExceeded` is authoritative.
- **D6 — A daily allowance of 25 videos.** The 10 GB daily byte cap is not modelled (25 × 300 MB = 7.5 GB).
- **D7 — Job polling:** first read 30 s after the upload finished, every minute until 10 minutes, then every 5 minutes; fail at 30 minutes, after at most 16 reads. A blob completes the job; unknown states mean still processing; a deduplicated job is polled by its new id.
- **D8 — Plain explanations** for each start error and job failure code, with Bluesky's code and message (secrets removed).
- **D9 — The embed:** the blob as returned, the aspect ratio when both dimensions are known, alt text when not empty; no captions, no presentation hint.
- **D10 — The file sent is the one entry 6 planned:** the original as is, or Bluesky's version; its size is checked before the start declares it.
- **D11 — Only creating the post may publish.** Every earlier step is retried on a timeout, dropped connection, rate limit or server error and is never ambiguous. An expired upload restarts at most twice.
- **D12 — Saved state** records the upload's progress and never a token; a post whose media changed starts again.
- **D13 — Summary and badges** come from capabilities, with two notes: about 25 videos a day, and a verified email for Bluesky-hosted accounts.

### Plan decisions

- **P1 — Declaration** in `src/providers/bluesky/capabilities.ts`, with a notes-only `byPostType.video` entry (as Facebook's) for the two notes.
- **P2 — The allowance is reserved at `check_upload_limits`, the first step of an upload** (one unit; none on its retries or during a limit wait), and `start_upload` reserves one more only on a retry. *Why:* FR-005 names the start step, but US4 #6 requires a spent allowance to defer the target with no Bluesky call, and the limits check comes first. *Reverse:* move `{ units: 1, retryUnits: 1 }` back to `start_upload` and accept one limits check per deferred target.
- **P3 — Token audience and method per call,** `exp` = engine clock + 300 s, minted through the configured server (the entryway proxies it, as for every other call).
- **P4 — The PDS host comes from `getSession`'s DID document** (`#atproto_pds`, read the way the installed `getPdsEndpoint` does), once per upload, kept in the upload state, falling back to the configured server's host. *Why not at connect or refresh:* the credentials schema would change, old accounts would lack it, and the engine redacts every credentials string, which would hide every audience in the attempt log. `@atproto/common-web` is not imported because it is not a direct dependency.
- **P5 — The video service is called with a small `fetch` client,** not an `Agent`: its errors subclass `XRPCError` but keep the reply body, which carries an "already processed" blob and is needed for exact part headers.
- **P6 — Parts are read by HTTP `Range` from the media's public URL;** a store that ignores ranges is never read whole. No `Storage` interface change. That the public URL honours ranges is an owed operator check.
- **P7 — Part arithmetic** uses the service's own part size and count, checked for consistency before the first part.
- **P8 — Step names:** `check_upload_limits`, `start_upload`, `upload_part_<k>`, `finish_upload`, `check_job`, `create_post`.
- **P9 — The limit wait fails at the refusal 23 hours after the first,** not 24. *Why:* the engine fails a target `PUBLISH_MAX_DURATION_HOURS` (default 24) after its first step, which is at or before the first refusal, so a 24-hour rule would never be reached and the person would see "Publishing did not complete." instead of Bluesky's reason.
- **P10 — A refused limits check is skipped:** any 4xx other than 429 (401 and 403 included, since its token audience is UNVERIFIED), a refused token for it, or an unreadable 2xx.
- **P11 — G24: `continue` may carry `wait`,** recorded (redacted) as the target's `lastError`, so a provider wait can show its reason without spending an attempt (Threads' hourly quota wait spends one each time and fails after 5). Inert for every existing provider. *Reverse:* drop the member; waits show nothing.
- **P12 — Pace constants** and a last read at the 30-minute ceiling, so a blob arriving at the end is not missed.
- **P13 — Status-read auth fallback:** a 401 or 403 on a token-bearing read switches later reads to no token; a second refusal fails. *Why:* the token audience is UNVERIFIED, and a wrong guess must not fail every uploaded video.
- **P14 — One restart counter (0–2)** for expiry, a lost upload (`UploadExpired`, `UploadNotFound`, `UploadAborted`, `PartSizeMismatch`, `MissingParts`) and a stored size that changed. `UploadAlreadyCompleted` on a part moves on to finish. These part and finish error names are in the installed lexicon types, not in the research.
- **P15 — A blob in any start or finish reply,** success or error body, is used without polling.
- **P16 — A failed state wins over a blob** in the same status.
- **P17 — Bluesky's messages are sanitised** (control characters removed, at most 200 characters) and scrubbed of the step's tokens before they are shown.
- **P18 — `fitState`** restarts a state whose media kind no longer matches, and treats an inconsistent upload as unreadable; a changed file (URL or size) starts again from the first step.
- **P19 — Bluesky wording** for the two refused mixes.
- **P20 — One generic assertion changes:** `requirements.test.ts`'s "unchanged" loop drops `bluesky`, because FR-018 requires its notes. No existing Bluesky test file changes.
- **P21 — A part timeout names `SCHEDULER_PROVIDER_TIMEOUT_SECONDS`,** so a part that never fits the limit ends with a reason the operator can act on.
- **P22 — No `docker-compose.yml` or `.env.example` change.**

### Implementation outcome

- Built as planned (T001–T039): capabilities, G24, the upload in parts, limits check, job polling, error explanations, summary and badges, and the daily allowance, with unit and integration suites (`video*.test.ts`, including a no-secrets suite).
- `docker-compose.yml` and `.env.example` are unchanged (FR-025).
- Real publishing is verified with mocks only (FR-027); the live checks are owed in `docs/accounts.md` (T040, blocked on a real account).

## 026 — TikTok provider (2026-10-08)

Judgement calls from `specs/026-tiktok-provider/spec.md` (D1–D16) and its plan (`research.md`, P1–P41). External facts come from `docs/research/tiktok.md` only (checked 2026-10-07, nothing run live). All TikTok behaviour is verified with mocks only; the live checks are owed once the operator's TikTok app has passed TikTok's audit (`docs/tiktok-setup.md`). This is the last entry of the video roadmap, so anything not built here is owned by no spec (`docs/feature-map.md`).

### Spec decisions

- **D1 — One TikTok app per install, unaudited until the operator says otherwise.** `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET` (both or neither) switch TikTok on; `TIKTOK_APP_AUDITED` defaults to false, and while it is false every TikTok post is private (`SELF_ONLY`) and every view says so. *Reverse:* remove the variable and always offer the creator's own options.
- **D2 — Connect with TikTok's web login** (`user.info.basic,video.publish`, client secret, no PKCE, `https` public callback, no paste fallback); the account is the `open_id`, named "nickname (@username)" from creator info; a grant without `video.publish` is refused. *Reverse:* add PKCE if TikTok requires it for web.
- **D3 — Generic: per-target posting fields declared by a provider** (G25). *Reverse:* drop the declaration; stored values are ignored.
- **D4 — Generic: live account details for the composer** (G26), read on the server, refreshed through the engine's single refresh path, reused for under a minute. *Reverse:* providers that do not declare the read are unaffected.
- **D5 — Generic: explicit consent recorded when a target is scheduled** (G27): who, when and a fingerprint of the content, the fields and the details shown; any change clears it. **Risk (UNVERIFIED):** whether TikTok's audit accepts consent given at scheduling for a later automated send is not known; if not, a confirm-at-send flow is needed, owned by no spec. *Reverse:* remove the requirement; records are kept but unused.
- **D6 — Privacy:** the creator's options in plain words with no default; "Only me" disabled while branded content is on; a fixed "Only me (private)" while unaudited; "Private on TikTok" wherever a `SELF_ONLY` target's status is shown.
- **D7 — Interactions, disclosure and title:** Comment (video and photo), Duet and Stitch (video), all off and disabled when the creator disabled them; the disclosure toggle with "Your brand" and "Branded content", at least one when on; an optional photo title of at most 90 units. The declaration's policy links are NEEDS RESEARCH and left out. No AIGC label, cover choice or music.
- **D8 — Declared limits:** image, carousel and video; media required; 2,200 UTF-16 units; 1–35 JPEG or WebP images, 20 MB, at most 1080 × 1920; one MP4 or MOV video, never with images, H.264/H.265/VP8/VP9, 23–60 fps, 360–4,096 px, 4 GB, 300 s; 15 posts per day, approximate. The creator's own maximum duration is checked at the gate and at publish.
- **D9 — Video by chunked upload, one chunk per step, in order:** size ÷ 30 clamped to 5,242,880–64,000,000 bytes, the final chunk absorbing the remainder; only the final chunk may publish; a repeated or expired upload restarts at most twice. *Reverse:* a fixed chunk size is one constant.
- **D10 — Creator info re-checked at publish:** a privacy, interaction or duration the creator no longer allows fails with nothing posted; a posting cap waits.
- **D11 — Status checks after the publishing request:** 15 s, then every minute to 10 minutes, then every 5 minutes; `PUBLISH_COMPLETE` publishes with `publish_id` as the external id and no link (the link format is NEEDS RESEARCH); inbox or unknown statuses and the 60-minute ceiling are ambiguous. *Reverse:* webhooks could replace polling (unowned).
- **D12 — Outcomes:** everything before the publishing request is safe to retry; a refusal of a publishing request fails with nothing posted; uncertainty after the final chunk goes to status checks, after the photo `init` is ambiguous at once. A missed post beats a duplicate.
- **D13 — TikTok's refusals explained in plain words,** codes matched exactly, HTTP 200 bodies with codes treated as errors.
- **D14 — Photo posts pull from the media bucket's public `https` address;** the deployer must verify their media domain with TikTok; videos never need it.
- **D15 — Tokens:** renew within 30 minutes of the access token's expiry; keep the newest refresh token; refusal → reconnect; transient → retry in five minutes; warn 30 days before the refresh token's (estimated) expiry.
- **D16 — No live check is owed until the app is audited.**

### Generic changes

- **G25 — Posting fields** (`SocialProvider.posting`): a values schema and a pure `view()` returning field views, plus `targetNote()` and `summaryNotes()`; values in `post_targets.posting_fields`, reaching `validate` and `advance` as `PostContent.posting`. *Reverse:* drop the member and the column.
- **G26 — Account details** (`SocialProvider.accountDetails`): a server-side read of non-secret details, refreshed through `refreshForPublish`, cached in process for 60 s. *Reverse:* drop the member.
- **G27 — Consent** (`SocialProvider.consent`): the declaration text; consent stored in four `post_targets` columns and valid only while its fingerprint matches; checked by the composer, the gate and the engine's first step. *Reverse:* drop the member and the columns.
- **G28 — `exchangeCode` receives `callbackParams`** (the callback query), so a group can read what the platform reports there (TikTok's granted `scopes`). *Reverse:* drop the input.
- **G13 — `accountNotes` receives an optional `now`** (DB clock), so a note can depend on time. *Reverse:* drop the input.

### Plan decisions

- **P1–P3 — The three hooks' shapes** (contracts/generic-hooks.md). A pure `view()` per provider instead of a declarative rule language; consent validity by fingerprint match instead of clearing on every write path.
- **P4 — Consent is recorded on the save that precedes scheduling.** Every schedule path saves first; the server records it only when its own fingerprint equals the one the person agreed to. *Why against the letter of "when the post is scheduled":* that save is part of the same action, and the gate refuses scheduling without it.
- **P5–P6 — Consent is checked by the composer, the gate and the engine's first step through one implementation;** the gate and the engine use the details stored with the consent, the provider's own creator check reads them live.
- **P7 — G28** instead of trusting the token reply's `scope` (UNVERIFIED), which is kept as a fallback.
- **P8–P9 — G13 `now`; summary notes and target notes** are part of G25 (`RequirementsSummary.notes`, `note` on target views).
- **P10 — One migration (`0018`), five nullable columns on `post_targets`;** no backfill.
- **P11–P17 — Configuration, envelope, tokens and identity.** `TIKTOK_APP_AUDITED` is `true` or `false`; the reply envelope (UNVERIFIED) is read in one function; missing token fields default to the research's lifetimes, the refresh expiry estimated at 365 days; the account's expiry is the refresh token's, as for X; no PKCE.
- **P18–P22 — Declaration, validation, unaudited storage, privacy labels, declaration text.** Unaudited installs store `SELF_ONLY`; a stored privacy other than that fails at the gate and at publish rather than being silently changed. "Your brand" alone keeps the plain declaration (UNVERIFIED).
- **P23 — Step names:** `check_creator`, `start_upload`, `upload_chunk_<k>`, `publish_photos`, `check_status`; unreadable state after the publishing request is ambiguous, before it restarts.
- **P24 — A one-chunk upload declares `chunk_size` = `video_size`.** *Why:* TikTok says small files are uploaded whole, and it satisfies both the floor rule and D9's "one chunk of its whole size".
- **P25 — The upload address is sealed in the step state** with AES-256-GCM, keyed by HMAC-SHA256 of `TIKTOK_CLIENT_SECRET` (as X derives its PKCE verifier); an unsealable address restarts the upload.
- **P26–P28 — Chunk outcomes, repeats and renewal.** A 201 before the last chunk goes to status checks; a repeat is a chunk step with an attempt above 1; an address 55 minutes old restarts before sending.
- **P29 — The posting-cap wait fails at the refusal 23 hours after the first,** not 24. *Why:* the engine fails a target 24 hours after its first step, which would always fire first with a generic message (as Bluesky P9).
- **P30–P31 — Status pace with a read on the 60-minute ceiling;** a hanging final chunk is caught by the provider and goes to status checks (if the engine's own timer wins, the target is ambiguous, the safe side).
- **P32 — Byte-range reads move to `src/providers/media-range.ts`;** Bluesky re-exports them unchanged.
- **P33–P37 — Fit, request bodies, the creator check, refusal explanations, rate limits.** `auth_removed` in a failed status flags the account for reconnecting.
- **P38–P40 — A generic `PostingFieldsPanel`; "Private on TikTok" in every target view; `docs/tiktok-setup.md` and the doc edits.**
- **P41 — No new dependency.** `.env.example` gains three variables; `docker-compose.yml` does not change.

### Hook reversal notes

Each generic hook is optional, so removing a provider's declaration turns it off without touching the engine: drop `posting` (G25) and stored values are ignored; drop `accountDetails` (G26) and the composer shows no live details; drop `consent` (G27) and consent records are kept but unused; the extra `callbackParams` input (G28) and `now` (G13) are ignored by groups that do not read them. The migration (`0018`) only adds nullable columns, so reverting the code leaves the database valid.

### Implementation outcome

TikTok connect, tokens, refresh, posting fields, consent, video by chunked upload, photo posts, status checks, plain-word refusals, the unaudited behaviour and the operator docs are built and tested with mocked HTTP only. Nothing was run against TikTok's live service; the live checks are listed in `docs/tiktok-setup.md` (FR-037) and are owed once the operator's app is audited. Not built, and owned by no spec: the items in `docs/feature-map.md` (FR-041) and a confirm-at-send flow (FR-042), the fallback if the audit refuses consent given at scheduling.

## 027 — Project overview (2026-10-09)

- **D1 — Step 1 counts any account that isn't removed**, including one needing reconnecting or from an unregistered provider. Reconnecting is a Needs attention item, not a setup step.
- **D2 — Step 2 counts only slots on accounts whose provider is available.** Its action goes to the first such account without an active slot; if every account is unavailable, to the first account.
- **D3 — What counts as a first post:** status `scheduled`, `publishing`, `published` or `partially_failed`. The enum has no "partially published" value, and `partially_failed` means some targets went out.
- **D4 — Failed vs partially failed:** Failed = `failed` + `partially_failed`. A partially failed post counts both as a first post and under Needs attention; both are true.
- **D5 — Expiry and reconnect never both appear for one account.** A reconnect item wins; otherwise an expiry item shows when `credentialsExpireAt <= now + 14 days`.
- **D6 — Accounts status badge precedence:** Unavailable (provider not registered), then Needs reconnecting, then Connected.
- **D7 — The collapsed checklist is a native `<details>`/`<summary>`** reading "Setup complete"; opened, it shows unfinished optional steps and the owner's server-setup row.
- **D8 — Settings keeps the generic "Loading…" state** (`[projectSlug]/loading.tsx` unchanged); the overview skeleton is scoped to the home route group.
- **D9 — Who sees the invite step:** only viewers with `invitation: create` (owners, admins). Done when there is more than one member or a pending invitation.
- **D10 — When the platform item shows:** only to owners while the project has no accounts.
- **D11 — The Media "Upload" action** is shown to every role with `media: edit`, which today is all three roles.
- **D12 — Accounts page anchor** `#account-{id}-slots` is the only Accounts page change.

### Open item

- `.claude/skills/docket-ui/SKILL.md` (App shell bullet, line ~31) still needs "Overview first (project home, above the groups)" added before "Publish": the sandbox refused writes to `.claude/skills`. A human should make that one-line edit.

## 028 — Empty states and role awareness (2026-10-09)

- **D1 —** Role checks use the existing `scope.can` statements and, for server pieces, `role === "owner"`. Client components get booleans
- **D2 —** `joinNames` moves to `src/lib/roles/names.ts` with a fallback parameter. `managersOf` and `listManagers` give one ranking of owners and admins
- **D3 —** `listSlotCounts(scope)` with the pure rule `hasActiveSlot` (available provider and at least one unpaused slot), shared with the overview
- **D4 —** `countPosts(scope)` for Failures' "no posts at all", read only when the unfiltered list is empty
- **D5 —** `getGenerationReadiness(scope)` drops setting names for non-owners. `missingLlmSettings` gives the full list at once
- **D6 —** Non-owner scheduler banner: the headline's first sentence, then the exact FR-061 sentence
- **D7 —** `SchedulerHealth` has a required `viewer` prop; `ReauthBanner` has `askNames`
- **D8 —** The layout reads managers only when a banner needs names
- **D9 —** Accounts: section for managers only. Order: configured groups, mock, credentials, then the owner-only disclosure. Admin fallback line when nothing is connectable
- **D10 —** Calendar has five derived states; "any active slot" is project-wide, regardless of the account filter
- **D11 —** `hasActiveSlot` is optional on `AccountOption`; unknown means no hint
- **D12 —** A blocking reason wins. When no selected account has slots, Add to queue is disabled and secondary, and Schedule… is the headline action, placed last
- **D13 —** The compose empty-state href is unchanged (`/accounts`), now button-styled
- **D14 —** Review's action is "Generate a post", shown when the viewer can run generation, never linking to Voice or Accounts
- **D15 —** Jobs, when prerequisites are missing and no jobs exist: the list only, with no empty state. With jobs: the list above the table
- **D16 —** Prerequisite card title: "Before you can generate". New job from media adds item 4 last, reusing today's selection messages
- **D17 —** Media: the "No unused images" note becomes `alertStyles("info")` on a `<p>`, with no live role (it's static)
- **D18 —** Voice reads archived profiles only when the active list is empty and the archived tab isn't open
- **D19 —** Empty-state action variants: `primary` when it's the page's only next step, `secondary` when the header already has a primary action or when it's a navigation aid (contracts/ui.md lists each)
- **D20 —** Pinned tests updated, as in R12

### Open item

- `.claude/skills/docket-ui/SKILL.md` "States" section still needs one line after the "populated" bullet: "Empty-state actions use `buttonStyles`; unfiltered empty lists hide their filters; prerequisite lists use `Checklist`; 'ask' copy names owners/admins by display name." The sandbox refused writes to `.claude/skills`; a human should make the edit.

## 027 follow-up: browser walk-through (2026-10-09)

A walk-through as an owner and as an editor, on desktop and at 390 px, found the new home still repeated itself:

- **No dead-end primary action.** With no account, an editor gets no primary action instead of "Write a post", which led to a Compose page that cannot post. *Why:* every button on a first visit must lead somewhere useful.
- **Posts by status has no action of its own when empty.** The header, the checklist and Coming up already offer the next step; "Write a post" appeared four times.
- **Unconfigured platforms share one server-setup line** ("More platforms you can set up: …"), linking to the accounts guide. *Why:* a platform nobody here posts to is not missing; six "isn't set up" lines read as a broken server.
- **"Optional" once.** The step badge already says it; the descriptions no longer start with "Optional.".

At 390 px the page does not scroll sideways (the nav strip scrolls inside itself), no console errors, focusable controls have focus rings.

## 028 follow-up: browser walk-through (2026-10-09)

Walked every empty route as an owner and an editor. Editors are told who to ask (by display name) everywhere, see no actions they cannot take and no env var names; Accounts leads with the usable connect forms and collapses unconfigured platforms. One dead end remained:

- **Posts with no account** offered "New post" and "Write a post", both to a Compose page that cannot post. Owners now get "Connect an account first", editors "Ask {names} to connect an account first", and the header button waits for an account.
- **Failures with no posts** drops its "Write a post" button: the page explains what will appear there, and writing is not its job.

## 029 — Terminology, page descriptions and nav order (2026-10-09)

- **Nav order and groups.** Overview first, then Publish (Compose, Calendar, Posts, Review, Failures), Create (Generate, Brand voice, Media, Batch jobs), Project (Accounts, Settings, Activity). Review stays directly above Failures. Slugs and URLs are unchanged. *Why:* order follows the job a person does; Activity is project housekeeping, not publishing.
- **One name per thing.** "Voice" is "Brand voice" and "Jobs" is "Batch jobs" in the nav, headings and tab titles; the `## Jobs` heading in `docs/generator.md` stays because doc anchors are pinned by a test.
- **Every project page has a `PageHeader`** with one title and a one-line description; status badges sit beside the title through a small `aside` prop.
- **Roles have one source**, `src/lib/roles/roles.ts` (editor, admin, owner, with descriptions), used by the members panel, the invite form and the invitations page.
- **Invite and signup/Invitations copy** use those role names; Voice editor hints are linked to their fields with `aria-describedby`; the posting-slot definition is stated once.
- **`/p/new`** says what comes next (connect an account, choose when it posts) and the time zone field explains what the zone is for.
- **Readable target statuses** on the posts list; calendar title shows the project time zone.
- **No `docker-compose.yml` or env change.**

**Open item (needs a human):** the sandbox refused writes to `.claude/skills/docket-ui/SKILL.md`. Make these edits:
1. App-shell bullet: replace the nav list with "left nav — Overview first, then Publish (Compose, Calendar, Posts, Review, Failures), Create (Generate, Brand voice, Media, Batch jobs), Project (Accounts, Settings, Activity)".
2. After the "**populated**." bullet in "States", add: "Empty-state actions use `buttonStyles`; unfiltered empty lists hide their filters; prerequisite lists use `Checklist`; 'ask' copy names owners/admins by display name." (owed from 028)
3. Add a bullet: "Every route has a one-line `PageHeader` description. Role names and descriptions come from `src/lib/roles/roles.ts`."
- **Pinned assertion changed (review F1).** The Accounts ordering test in `tests/integration/accounts-ui.test.ts` now looks for the card heading `Posting slots (` rather than the bare words, because the new posting-slot definition mentions them earlier on the page.

## 033 — Accounts restructure and first-post flow (2026-10-09)

- **Navigation, not behaviour (FR-019).** Where the browser lands after a successful connect (the chooser action and the two in-page forms) changed. The callback route's redirects, data, permissions, activity entries and notifications did not. *Why:* success already went to the chooser; only the post-save destination moved.
- **Intl, not Temporal (research R10).** The first-post calendar link and local-time formatting use `Intl.DateTimeFormat`; Temporal is not relied on. One rule, `countsTowardFirstPost`, serves both the overview checklist and the Composer.
- **Prerequisite gates use `SetupNotice`**, an `EmptyState` variant; `Checklist` is for progress lists and gained a `footer`.
- **Not included (FR-062):** dismissible checklist, deep links from activity entries, focus moves for other slot links, a calendar link outside the Composer, and any change to connect data, permissions, activity, notifications or callback targets. No later roadmap entry owns them.
- **Intentionally changed assertions** in `tests/integration/accounts-ui.test.ts`: `Posting instructions</h4>` is now `Posting instructions · Set`, and the order test expects Posting slots before Posting instructions (instructions moved into a collapsed `<details>` below the slots).
- **No `docker-compose.yml`, env, schema or dependency change.**

**Open item (needs a human):** the sandbox refused writes to `.claude/skills/docket-ui/SKILL.md`. Make this edit: in the "Reuse components" list, add `SetupNotice` after `EmptyState`, and add the sentence "Prerequisite gates (you can't do this yet) use `SetupNotice`; `Checklist` is for progress lists only." This supersedes the "prerequisite lists use `Checklist`" wording owed from 028/029.

## 034 — Auto-growing, monospace prompt and instruction fields (2026-10-10)

- **`Example N` classification contradiction (R12).** The voice editor's `Example N` field renders mono per
  FR-018, even though an example post is post copy and FR-019's own rule would call for proportional. Kept as
  specified rather than silently reclassified, because the voice editor's five textareas share one wrapper and
  splitting it for one field would re-introduce the per-site divergence this entry exists to remove. A later
  review can revisit this as a decision, not an oversight.
- **`PostingInstructionsForm`'s hint id changes `-help` → `-hint` (R8).** Nothing in the test suite asserts
  `-help` for that field. `TextareaField` keeps `Field`'s `aria-describedby` order
  (`[hint, counter, errorId].filter(Boolean).join(" ")`), which is also why the voice fields' describedby grows
  from `"…-hint"` to `"…-hint …-error"` (FR-041) — the error id is always present, exactly as it is on `Field`.
- **Supporting-copy rule (R13).** A paragraph drops to `text-xs text-muted-foreground` only when it is inside a
  form or field group, explains a field/group/list, and the reader never typed or generated it. Labels, control
  text, typed/saved/generated values, dialog body copy, anything with `role="alert"`/`"status"`/`"note"`, and
  `PageHeader` descriptions/table typography/headings/`loading.tsx` stay at their current size.
- **Two accepted visual changes (R14).** The voice editor's five textareas lose their private `box` styling and
  gain the shared `controlStyles` chrome (hover border, focus ring, `aria-invalid`/disabled states) — the
  divergence this entry exists to end. Six fields (`Composer` ×2, `SeriesPlanEditor`, `MediaEditDialog`,
  `TryItPanel`, `MediaPicker`) had no `aria-describedby` before and now gain the reserved error line, adding
  16 px under each.
- **No `docker-compose.yml`, env, schema or dependency change.**
- **Review remediation (F1–F3).** `TextareaField`'s scripted fallback now releases `style.height` (sets it to
  `"auto"`) before reading `scrollHeight` in `resize()`, so a shrink is measured from content rather than the
  previous clamp (F1). The composer's post text now forces `!text-base`, so it actually renders at the 16 px
  `docs/design-system.md` §4 prescribes for long-form text and `ROW_REM_COMPOSER`'s floor/ceiling are correct
  against that real size, rather than silently computing bounds for a 14 px row; the now-dead `min-h-40` is
  removed (F2, F6). `JobForm`'s `{{field}}` chip row moved back out from inside the hint paragraph onto its own
  `beforeControl` slot in `TextareaField`, rendered after the hint and before the `<textarea>` and excluded from
  `aria-describedby`, restoring the one-sentence accessible description (F3).

**Open item (needs a human):** T032's browser walk-through (quickstart.md §6) was not run — this execution
environment has no running `pnpm dev` server and no browser tool. A human needs to sign in, run the
walk-through table (growth, ceiling/scroll, shrink, saved-value-at-load, the collapsed `<details>`, the
`Dialog` cases, monospace vs. proportional, read-only full height, the voice screen's caption-size copy,
keyboard/focus, 390 px width, no-JS) and report each row as pass or fail.

## 035 — Reusable week grid for posting slots (2026-10-10)

- **R2 — chips are not drawn at the y that placed them.** A click or drop is positional (`timeAtPosition` maps
  linearly across the column's own height), but each chip then lays out in its column's time order rather than
  at the pixel it was placed or dropped at. *Why:* proportional positioning cannot keep chips legible at the
  settled type scale inside a column short enough to satisfy SC-010 — a dense day would either overlap chips or
  force the column so tall it broke the one-screen layout. No hour gutter or hover readout ships; the
  announcement after a placement or move is the only thing that names the time it landed at, which review F6
  flagged as a built mitigation that review found did not exist — this is the corrected account. See research.md
  R2.
- **FR-022 — delete without a confirm dialog.** `docs/design-system.md` §7 says a `danger` action always
  confirms in a `Dialog` that names the thing; `WeekSlotGrid`'s Delete control is the one exception. A slot holds
  no content, costs one click to re-add, and deleting one changes no scheduled post, so the spec requires the
  exception rather than the confirm.
- **Retime has no callback of its own.** A typed time in the Move dialog goes through the same `onMove` as a
  drag, since a retime is a move whose weekday happens to be unchanged — this is also why a retime gets the same
  duplicate-slot refusal as a drag for free.
- **Old add-slot and table UI removed.** `SlotEditor` and `SlotRowActions` (the weekday-radios-plus-time-input
  form and the Day/Time/Status/Actions table) are deleted from
  `src/app/p/[projectSlug]/accounts/SlotEditor.tsx`; `ReconnectMockButton` and `MockBehaviourForm` stay. The
  post-connect focus hand-off now targets `#account-<id>-add-slot` instead of the deleted radio input.
- **Capability check moves from `account:["manage"]` to `slot:["manage"]`** for who sees the grid's editing
  affordances, per contracts/week-slot-grid.md and the spec's capability split.
- **No schema, migration, `docker-compose.yml`, env or dependency change.**

## 041 — External item ID ledger (2026-10-10)

- **One table, `external_item_claims`, keyed by its natural key.** Primary key `(project_id, source_key,
  external_id)` *is* the uniqueness the spec asks for, so there is no surrogate id and no second index to
  keep in step. Rejected: a surrogate id plus a unique index (no caller needs the id); a column on `posts`
  (cannot express "claimed id whose post was deleted", and no per-namespace uniqueness).
- **The claim is inserted by `saveGeneratedPost` itself, from an optional `external` argument**, not by any
  of its callers after the fact — one write path, one transaction, so no caller can save a post and forget
  the claim. `generateSingle` passes the request's id; the job runner passes the item's id and the job's
  namespace; series planning and the composer pass nothing and never claim an id.
- **An already-posted generate answers `200` with `alreadyPosted: true`; a deleted post answers `409`.**
  200-vs-201 already carries a signal callers watch, so a duplicate is not an error — except when the
  claimed post has since been deleted, which throws `reason: "already_posted_post_deleted"` rather than
  silently re-posting: a deleted post does not free its id.
- **Unique-violation recovery re-reads state; it never branches on the constraint name.** Two unique
  indexes can now fire in one transaction (generate's `request_id` and the ledger's natural key), and a
  constraint name is only as stable as a migration's index name. The catch block asks the database what is
  true instead: the claim first (the permanent, stronger fact), then the request id or job item.
  Rejected: branching on `error.constraint`.
- **A late skip is detected twice: cheaply before the model call, authoritatively at save.** The runner
  checks the ledger once it has its voice and accounts (catches the common case before spending a model
  call), and `saveGeneratedPost`'s claim insert is the one authority — a claim that lands mid-model-call
  still ends as a skip through the unique-violation recovery above.
- **`skipped` is a terminal job-item status with no reason column.** The only reason is "already posted",
  and the winning post is reachable from the claim, so the sentence is composed once in the view layer
  (`alreadyPostedReason`) from `external_id` plus the claim row, rather than frozen into a text column at
  write time.
- **Ingest filters already-claimed ids inside the existing write transaction** before the `JOB_ITEMS_MAX`
  check, so skipped items never eat the item-count allowance; a non-open create whose every item is
  skipped is refused naming the count, but an open job with everything skipped is created empty and stays
  open.
- **No release, no backfill, and no "have you posted this?" endpoint.** The ledger's permanence is the
  feature, so there is also no scheduled pruning.
- **One additive table, one column, one enum value, one unique constraint** (`posts_project_id_uq`); no
  existing caller changes behaviour when it sends nothing new.

## 049 — Table density and one control per question (2026-10-11)

- **Five columns is the ceiling for an output table.** A row answers four questions — who it is about,
  what it is, why it is in this list, what to do about it — and each gets one column; facts that only
  qualify an answer become `Sub` lines inside that cell. Rejected: horizontal scroll and per-screen
  column hiding, both of which hide the answer the person came for. The rule and the before/after column
  counts are `docs/design-system.md` §7 "Column grouping" and §14.
- **A column that is mostly "—" or mostly zero is a cell, not a column.** Batch jobs carried five
  per-status counts side by side; failures carried "Meant to go out" and "How" as columns that were empty
  on every seeded row. They now render only when there is something to say.
- **Mutually exclusive answers to one question are one `ButtonGroup`.** "Mark published" beside "Mark not
  published…" repeated the verb twice per row and wrapped onto two lines; it is now a joined
  **Published / Not published** pair whose group label asks the question once ("Did this post go out to
  <account>?"). The full sentence survives where it is actually needed — the dialog title and body are
  unchanged, so `resolveAmbiguous` and its spec text (010 FR-007/FR-008) still describe what happens.
  Rejected: a real two-state toggle, which would imply the decision is reversible, and a single
  "Resolve…" button, which adds a click to the most common path.
- **`Table` grew `grouped`, `RowGroup` and `DetailRow` rather than failures keeping raw markup.** The
  failures view needs status group headings (`<th scope="rowgroup">`) and a full-width attempt-log row,
  which the single-`<tbody>` primitive could not express — so it stayed hand-rolled and missed the card,
  the column heads and phone stacking. The primitive now covers both, and `.stack-table` skips the
  column label on any `td[colspan]`.
- **One `AttemptLog`, shared.** The six-column log was duplicated between the failures view and the post
  page, `Pairs` helper included. It is now one `text-xs`, four-column component (Time, What happened,
  Who, Details) and the post page collapses repeated runs the way the failures view already did.

## 050 — One date format (2026-10-11)

- **Every instant a person sees goes through `formatLocal(instant, timeZone)`** (`src/lib/time/format.ts`),
  in the project's zone. Six shapes had drifted into the app: the house "Mon, Oct 12, 9:00 AM EDT"; the
  calendar's own "Tue 6 Oct 09:00 Europe/London"; a raw `2026-10-11T11:30 America/New_York` leaking out
  of `PlannedTime.localTime` into the resolve and retry dialogs; `toUTCString()` on the invitations and
  audit lists (UTC, not the project's zone); an ISO slice for "Joined" and a revoked key; and an `en-GB`
  `dateStyle` pair in the reconnect message and the scheduler tooltip.
- **`PlannedTime.localTime` is machine data, not display.** It encodes the wall clock for the calendar's
  own parsing (`hm()`, chip placement, the schedule dialog's prefill), so it keeps its shape; the fix is
  that nothing renders it. Every call site had `scheduledAt` beside it already. Rejected: making
  `localTime` the friendly string, which would have broken the calendar's parsing.
- **`formatLocal` moved to `src/lib/time/format.ts`** so server code and providers can use it without
  importing a React component file; `LocalTime` re-exports it, and the long tooltip form is `formatFull`
  in the same module. That let the TikTok "Reconnect before …" note stop printing a bare ISO date — the
  `accountNotes` provider hook now receives the project's `timeZone`, since it composes user-facing text.
- **A lint test, not a convention.** `tests/lint/date-format.test.ts` fails the build on `toUTCString`,
  `toLocaleDateString`/`TimeString`, `toDateString`, an `toISOString().slice(…)` or a bare
  `Intl.DateTimeFormat`, with a five-entry allowlist for the places that detect, label or validate a zone
  rather than display one — plus a check that the allowlist has no stale entries. Conventions drifted six
  ways; a test does not.

## 056 — Per-event read state and snooze (2026-10-11)

### Spec decisions (N13–N24; see N2/N3 above for the two reversals)

- **N13 — Reverses N3.** `seen_seq` stays and becomes explicitly a floor: every attention event at or
  below it is read, for ever, with no row of its own. Above the floor only, a sparse per-event mark may
  exist for one person, one project and one event. The floor is still forward-only.
- **N14 — Reverses half of N2.** The half that stands: unread still means "newer than where you last
  looked", not "still broken". The half reversed: a problem no longer has to wait for the whole project to
  be marked read — one problem can be marked read or snoozed on its own, with no effect on the floor or any
  other event.
- **N15 — One meaning, "hidden until".** A sparse mark carries an instant from which the event counts
  again: `'infinity'` for "read", a finite instant for "snoozed". Every read of the state is one comparison
  against the current time.
- **N16 — Bounded growth.** A mark can only exist above the floor; the floor absorbs and prunes every mark
  at or below it in the same transaction it rises in; a hard cap of 200 sparse marks per person per project
  refuses further row actions for that project (pointing at "Mark all as read") rather than growing without
  bound.
- **N17 — Snooze offers three fixed choices in the project's time zone**: "1 hour" (an exact duration),
  "Tomorrow morning" and "Next week" (09:00, resolved once with explicit DST disambiguation and stored as
  an absolute instant — nothing recomputes it later).
- **N18 — A snooze is on the event, not the target.** A retry, publish or resolution of the target does not
  cancel the snooze; when it runs out the event comes back unread, linking wherever Activity links it.
- **N19 — The floor wins over a snooze.** "Mark all as read" and the N4 problems views raise the floor over
  everything that exists at that moment, including snoozed events, pruning their marks; the confirmation
  names how many snoozes were cleared.
- **N20 — A snoozed problem leaves the panel; a read one stays, without "New".** Neither action hides
  anything from Activity, for anybody.
- **N21 — The row actions are reachable, named and announced.** "Mark read" and "Snooze" are real controls
  with accessible names identifying the problem, in the normal Tab order, working with no client
  JavaScript, announced politely only on a real change.
- **N22 — The count payload gains the next change**: the soonest instant at which one of the caller's
  snoozes runs out, or nothing, so the bell can refresh exactly then instead of up to 60 s late.
- **N23 — A row action names the activity event by its existing id alone.** No new identifier and no
  internal position reaches the browser; an id in another project, a non-attention id, and an unknown id
  are all the same "not found", changing nothing and revealing nothing.
- **N24 — Nothing written under the old rule changes.** No per-event rows existed before this entry, so the
  new table starts empty and reproduces today's behaviour exactly; every existing `notification_states` row
  keeps its `seen_seq` and `muted` untouched, and the migration is safe against a live installation.

### Plan decisions (M1–M18)

- **M1 — One table, `notification_event_marks`**, keyed `(project_id, user_id, event_id)`, payload
  `event_seq bigint` and `counts_again_at timestamptz`. Not columns on `activity_events`, not a JSON blob on
  `notification_states`: the key is exactly "one person, one project, one event", so "at most one mark" is
  a database fact and the count's probe is the primary key's full prefix.
- **M2 — `counts_again_at` is `NOT NULL`; "read" is `'infinity'::timestamptz`.** "Hidden right now" is the
  single predicate `counts_again_at > now()`, with no `coalesce`/`OR`. Three Postgres behaviours this leans
  on are asserted by a test rather than trusted (`'infinity' > now()`, `'infinity' < 'infinity'` is false,
  `date_trunc('milliseconds', 'infinity') = 'infinity'`); `node-postgres` parses an infinite `timestamptz`
  to `Infinity`, so the column is never selected raw into TypeScript.
- **M3 — `event_seq` is denormalised onto the mark** at write time, inside the same locked transaction that
  read it, so the floor-follow and the prune are `WHERE event_seq <= $floor` with no join to the log — safe
  because the log is append-only and a `seq` never changes.
- **M4 — Two CHECKs**: `event_seq > 0` and `counts_again_at = date_trunc('milliseconds', counts_again_at)`.
  No CHECK asserts the instant is in the future — an expired snooze is a first-class state, and the
  future-ness of the three choices is the resolver's and the service's job, not the database's.
- **M5 — The membership FK does all the deleting; the event FK is insurance.** The same `(project_id,
  user_id)` → `member ON DELETE CASCADE` shape as `notification_states` makes US6 true for free, in the same
  transaction as the membership change. No composite FK to `(project_id, id)` on the log — a mark is only
  ever written from a row already resolved by project and id together, so the invariant is stated and
  tested rather than enforced by a new index on the largest table.
- **M6 — One extra index**, `notification_event_marks_floor_idx` on `(project_id, user_id, event_seq)`, for
  the prune, the cap count and the next-change scan. No new index on `activity_events`: R4's two partial
  indexes still drive every scan over the log.
- **M7 — Marking read pulls the floor up to just below the oldest uncovered event**, not just to the marked
  event's own `seq`, so any order of work — including newest-first — collapses every mark above the new
  floor back to empty, which is what makes the 200 cap survive ordinary use.
- **M8 — The snooze resolver is pure**, `resolveSnooze` in `src/lib/notifications/snooze.ts`, using
  `Temporal.PlainDateTime.toZonedDateTime(timeZone, { disambiguation: "compatible" })` — the same rule the
  scheduler already uses — truncated to whole milliseconds, with `MORNING_HOUR = 9` as one exported
  constant.
- **M9 — The cap refuses every row action for the project**, including an in-place replacement that would
  not grow the table, for one truthful message on every row rather than a rule that holds for some rows and
  not others.
- **M10 — An event at or below the floor short-circuits to "unchanged", never an error.** The stale
  second-tab case refreshes the count, announces nothing, shows no error.
- **M11 — A row action names the event id alone**; `resolveAttentionEvent` resolves the project inside the
  caller's project set with a `UNION ALL` of the attention branches per project, so no internal position or
  project slug ever reaches the browser, and a non-attention event is indistinguishable from a missing one.
- **M12 — Row actions reuse R3's transaction verbatim**: `SET LOCAL lock_timeout`, the project row `FOR
  UPDATE`, the membership re-check — nothing new is lockable, so no new lock-order question.
- **M13 — `write()` returns `{ outcome, snoozesCleared }`** so "Mark all as read" can say how many snoozes
  it cleared, counted inside the same transaction that pruned them rather than a second, racy query after
  commit.
- **M14 — `now()` comes from the database**, in every comparison — the count, the panel's snooze exclusion,
  the next-change query and the cap check — so the count, the panel and the callout cannot disagree about
  whether a snooze has run out.
- **M15 — Two anti-joins, so the SQL stays free of `OR`**, matching 022's SQL rules: `counts_again_at >
  now()` for "hidden now", and the same predicate narrowed with `< 'infinity'` for "snoozed now (not
  read)".
- **M16 — `listAttention` does the snooze exclusion in SQL and reports readness**, returning
  `AttentionRecord = ActivityRecord & { hiddenByMark: boolean }`; the generic Activity reader (`list`,
  `summary`) is untouched.
- **M17 — `nextChangeAt` lives on `UnreadSummary`**, the soonest finite `counts_again_at` strictly after
  `now()` over the caller's notifications-on projects, so the count route, the panel and the server-rendered
  bell all carry it from the first render.
- **M18 — Row actions are two server actions**, `markEventRead` and `snoozeEvent`, with
  `NotificationRowActions` a `"use client"` leaf rendering "Mark read" and a `<details>` "Snooze"
  disclosure of three submits, hiding `returnTo` only until hydration (the same trick
  `NotificationBellClient` already uses) so the no-JavaScript path still redirects with a confirmation.

## 043 — Per-kind and per-platform notification preferences (2026-10-11)

### Spec decisions (N25–N41)

- **N25 — Reverses half of N5.** The three halves of N5 that stand: muting is personal, it hides and
  never deletes (every event stays in Activity for everyone, including the person who muted), and
  notifications are on by default. The half reversed: the unit of choice is no longer the project. A
  person now chooses, per project, which of the four N1 attention kinds and which platforms may notify
  them; the project level becomes a roll-up of those switches (N33) rather than a stored flag.
- **N26 — `muted` is dropped, not kept as a derived column.** One source of truth; no boolean that can
  drift from the switches it would have to mirror. **Fate of the data**: every `notification_states`
  row with `muted = true` becomes all four kind switches off for that person and project, in the
  migration that drops the column; `muted = false` rows get nothing written, because absent means on
  (N27). No row's `seen_seq`, `seen_at` or sparse mark is touched.
- **N27 — Default on, stored as exceptions.** A new member, a new project, a platform a later release
  adds, and a project nobody has touched a switch for are all on with nothing written — the fact that
  makes the N26 migration a no-op for every unmuted row. **Not reversed by 044's N45**: N45 governs a
  different axis (which *channel* carries an already-eligible event), and deliberately inverts the
  default for email alone; this rule, for the bell, is unchanged.
- **N28 — Two independent axes, combined with AND.** An event may notify when its kind is on *and*
  either it records no platform or at least one platform it records is on.
- **N29 — A multi-platform event counts once if any of its platforms is on.** A connect failure spanning
  Facebook and Instagram is heard about exactly once, not per platform.
- **N30 — An event with no platform is governed by its kind alone** — the platform axis only excludes,
  never silently swallows an event with nothing to exclude it by. Unreachable under the log's own CHECK
  today (Q22); implemented and tested anyway.
- **N31 — The platform axis is keyed by platform, never by account.** Removing or renaming an account
  changes no preference and no past event's recorded platforms; there is deliberately no per-account
  preference.
- **N32 — Offered platforms**: the platforms a project has accounts for, plus any platform the person
  has already switched off for it, in registry order. A platform with neither is simply absent and, by
  N27, on.
- **N33 — "Off for this project" means no kind is on.** Derived, never stored — the same fact N26
  removed as a column is recomputed from the switches wherever it is described.
- **N34 — One click still turns a whole project off, and one click turns it back on** — the old mute's
  "Turn all off", plus a "Turn all on" beside it, each a single confirmed submit. "Turn all on" is
  subject to the fresh-start rule (N35) and so cannot deliver a backlog.
- **N35 — Extends N6: the fresh-start rule applies to every switch, not just the project.** Turning any
  switch on — a kind, a platform, or the project-level "Turn all on" — records with that switch the
  newest attention position at that moment; only events after it may notify through that switch. Events
  from while it was off never become eligible later, and remain in Activity for everyone.
- **N36 — Turning a switch on prunes the marks it makes redundant**, in the same transaction that
  records its new position, so N16's bound on sparse rows survives repeated switching.
- **N37 — The N4 floor paths (unchanged) still cover everything**, including events of switched-off
  kinds and platforms — exactly as N4.1 already covered muted projects — so a switch turned on later can
  never surface anything at or below the floor.
- **N38 — Extends N10: the personal Notifications page becomes a per-project grid.** One row per
  project, the four kinds as columns, that project's platform switches in a per-project disclosure, and
  the one-click all-off/all-on beside them. Each project's settings page carries the same control, for
  every member role. Both work with no client JavaScript.
- **N39 — One rule gates everything a person is told** — the bell, the panel, the callout and the
  project's unread number all ask `eligibility.ts`'s one question. Activity, the public API and webhooks
  are untouched: preferences gate notifications, never the record. **Reused unchanged by 045's N68**: the
  stream's message body is produced by the same service call, so a push can never disagree with the bell.
- **N40 — That rule is the shape `email-delivery` (entry 3) will consume unchanged.** Quiet hours are a
  delivery-timing rule with no meaning for an in-app badge, and are therefore not in this entry.
- **N41 — A preference is only ever the caller's own.** Mutations resolve through the caller's own
  project set; a foreign or unknown project and another person's preferences give the same "not found"
  (022's R13 shape), unchanged.

### Plan decisions (Q1–Q24)

- **Q1 — One table, `notification_preferences`**, one row per switch: `project_id`, `user_id`, `axis`
  (`kind`/`platform`), `switch_key`, `on_from_seq`, `created_at`, `updated_at`. PK `(project_id,
  user_id, axis, switch_key)`; the same composite FK to `member ON DELETE CASCADE` as R1 and M1, so
  FR-022's "deleted with the membership" is the database's job.
- **Q2 — `on_from_seq bigint NULL` carries all three states**: no row = on with no position (N27); row
  with `NULL` = off (N26); row with a value = on from that position (N35). A switch-on rewrites the row
  rather than deleting it — deleting would mean "on with no position" and reopen the backlog N35
  forbids.
- **Q3 — `OFF_SEQ` (`bigint` max) is the one named sentinel**, in TypeScript and interpolated as a SQL
  literal: `seq > coalesce(on_from_seq, OFF_SEQ)` is one comparison with no branching, the same shape as
  056's `'infinity'::timestamptz`.
- **Q4 — `src/lib/notifications/eligibility.ts` is the rule's one statement (extends R1-era design,
  next to N1/022's rule)**; `email-delivery` imports it unchanged. The SQL and the pure rule are two
  expressions of one thing, kept from drifting by a test that asserts they agree over the same seeded
  events, not by review habit.
- **Q5 — Extends R4/R5: the kind axis compiles into the branch list.** An off kind emits no branch; on
  kinds are grouped by position with outcomes as literals. With no preferences stored the SQL is
  exactly what R5 shipped — the partial indexes (R4) keep driving every statement.
- **Q6 — The platform axis is one correlated comparison over `unnest(provider_keys)` against a literal
  `VALUES` map** — no `OR`, no `NOT`, honouring 022's SQL rules (R4's note) in the one new expression
  this entry adds.
- **Q7 — Two costs, both only for a person with a stored platform switch**: a heap fetch per candidate
  row (no more index-only scan), and an unbounded-by-`LIMIT` scan for a person with every platform off.
  SC-007 is extended with that case rather than assumed; the named fallback (not taken speculatively) is
  a GIN index on `provider_keys` plus an `&&` pre-filter.
- **Q8 — Switch writes reuse R3's transaction verbatim.** Same lock order, same `NotificationsBusyError`
  failure mode. "Turn all off"/"Turn all on" write several rows in that one transaction (N34).
- **Q9 — An on-write only touches switches currently off**, so "Turn all on" never moves an
  already-on switch's position backward into a backlog, and a double submit is idempotent.
- **Q10 — `GREATEST` on conflict**, exactly as R3/M-series upserts use it: NULLs are ignored, so an
  off→on cycle can never record a position below an earlier one.
- **Q11 — Pruning happens only on an on-write, in the same transaction as the position** (extends M7's
  prune-on-rise to every switch, not just the floor); an off-write touches no position and prunes
  nothing, so the 200-mark cap (N16) is unaffected by switching off.
- **Q12 — "Turn all off" touches only the four kinds; "Turn all on" also turns on any off platform.**
  Keeping a platform choice through an all-off/all-on cycle is the kinder behaviour; one click on the
  way back still restores everything (SC-002).
- **Q13 — `nextChangeAt` (M17) now joins each live snooze back to its event** and applies the compiled
  plan, so a snooze whose kind or platform has since gone off never arms the poller.
- **Q14 — The floor paths (R5/N4, M-series) stay preference-blind** — unchanged, and still cover
  switched-off kinds and platforms, exactly as N4.1 covered muted projects.
- **Q15 — The panel keeps its wire state name `all_muted`.** FR-011 forbids a payload change; the
  sentence stays "Notifications are off for all of your projects," its meaning now N33's roll-up.
- **Q16 — `MyProject` drops `muted`, gains `preferences`; `unmutedIds` becomes `notifyingIds`.** One
  extra statement per caller loads every preference row inside the existing project-set section.
- **Q17 — `offeredPlatforms` (N32) needs two new reads**: `AccountsRepo.platformKeys()` (one project)
  and a `platformsByProject()` set reader (the grid), both in registry order; `platformOptions()`'s
  existing `mock`-unless-enabled rule needs no new code.
- **Q18 — Extends design-system §7: the switch control is a state-showing submit button, not a
  checkbox** — generalises `NotificationToggle`'s R14 shape from one button per project to one per
  switch, because FR-017 needs every change saved with no client JavaScript, which a checkbox cannot do
  alone. `aria-pressed` deliberately omitted — the visible label already says the state.
- **Q19 — Extends design-system §7's "five columns" ceiling with a control-matrix exception.** A row of
  fixed-width control columns does not wrap the way fact columns do, so `Table grouped` with a per-kind
  column plus a platform `DetailRow` is the shape, not a violation.
- **Q20 — Extends R14's confirmation shape**: a redirect carries `?changed=<slug>&axis=…&key=…&on=…`,
  resolved by pure, tested functions in `text.ts`; an unparseable code renders a generic confirmation
  rather than erroring.
- **Q21 — Extends R13: "not found" is decided before "invalid."** The caller's own project set is
  resolved first (foreign and unknown project give the same sentence); only then is the switch key
  checked, so an invalid key never reveals whether a project exists.
- **Q22 — N30's case is unreachable under the log's `cardinality(provider_keys) >= 1` CHECK today**,
  and is implemented and tested anyway (the pure rule, and the Q6 expression against an empty array)
  rather than leaving a trap for the day it stops being unreachable. The CHECK itself is not relaxed.
- **Q23 — Nothing is added to the stack**: no dependency, environment variable, infrastructure change,
  recurring work, public-API operation, webhook change, UI primitive or new index on `activity_events`.
- **Q24 — Migration 0021 is generated, then hand-ordered**: `CREATE TABLE` → FK → the `muted = true` →
  all-kinds-off insert (`ON CONFLICT DO NOTHING`) → `DROP COLUMN "muted"`, because the insert must read
  `muted` before it is dropped. `pnpm db:check` stays green because it only compares the snapshot with
  the journal.

## 044 — Email delivery (2026-10-12)

### Spec decisions (N42–N67)

- **N42 — One mailer capability, shaped like invitation delivery, injected and never imported by a
  screen.** A single `Mailer` with one send operation and a classified outcome — sent, permanently
  rejected, temporarily failed, or unavailable. Every caller asks one question: "is there a mailer?"
- **N43 — The SMTP group is the two variables that are meaningless alone; credentials are an all-or-none
  pair that requires the group.** `SMTP_HOST`/`SMTP_FROM` are the group; `SMTP_USER`/`SMTP_PASSWORD` are
  a pair, both or neither, and either without the group is an error, because an unauthenticated relay on
  a private network is a real deployment. Satellites have defaults; setting one without the group is an
  error. With the group unset, email is off and no validation message ever carries a value.
- **N44 — The wire transport is the one piece this entry cannot finish, and it is marked rather than
  faked.** `NEEDS DEPENDENCY: nodemailer`, `NEEDS RESEARCH: SMTP`. Configured-but-unavailable reports
  *unavailable*: one startup line, each would-be send recorded without a retry storm, no bookkeeping
  advance, nobody told they were emailed.
- **N45 — Email is opt-in per person, deliberately the opposite of N27's default-on.** Configuring a mail
  server must never, by itself, start mailing anyone who never asked. Default cadence is **off** for
  everybody, including people who already have notifications fully on; nothing in the migration opts
  anybody in. **Not a reversal of N27**: N27 governs which events may notify; N45 governs which channel
  carries them.
- **N46 — Email settings are per person and account-wide; what may be mailed is still the per-project
  rule.** Cadence, hour, zone and quiet hours are one set per person. Which problems may be mailed is
  N39's rule, imported unchanged via N40: no second notion of what someone cares about.
- **N47 — Three cadences: off, immediate, or a daily digest at a chosen hour.** Immediate and digest are
  the same assembly at a different due instant — one query at send time, never a per-event queue.
- **N48 — The person's time zone is stored with their email settings, shown in words beside every hour.**
  Until chosen, Docket uses the zone their projects agree on, UTC when they disagree or there are none —
  never guessed from a request. Pre-filled from the browser when JavaScript is available; still usable
  without it.
- **N49 — Quiet hours govern immediate mail only; a chosen digest hour is exempt.** A digest hour is an
  explicit instruction. Inside quiet hours, immediate mail is deferred, never dropped: everything still
  eligible when the window ends arrives as one message, not a burst.
- **N50 — Wall-clock rules are resolved per local day with explicit DST disambiguation.** A non-existent
  hour resolves to the next instant that exists; an hour occurring twice sends once, at the first
  occurrence. Quiet windows may wrap midnight. Resolved instants are stored absolute, never recomputed —
  entry 1's snooze rule (**M8**) applied to a second wall-clock promise.
- **N51 — The filter runs at send time, never at queue time.** A problem read, dismissed or snoozed, or
  excluded by a preference switch, is not mailed — including when it became so in the minutes between
  appearing and the mail going out.
- **N52 — An empty message is never sent.** No mail, no "all clear", no bookkeeping change; the next due
  instant simply rolls forward.
- **N53 — A missed digest is sent late only while it is still the same local day.** A worker down two
  hours sends late, same day; down two days skips the stale digest, its problems rolling into the next
  one, because the mailed-through position only advances on an actual send.
- **N54 — Never twice, even at the cost of never.** A crash between handing a message to the mail server
  and recording that it was handed over is recorded as sent and never retried — constitution V's
  publishing choice, for the same reason: a duplicate problem email teaches people to filter Docket into
  the bin.
- **N55 — What has been mailed is a forward-only position per person and project**, mirroring the read
  floor. A person's bookkeeping also carries their next due instant and a claim, so two processes ticking
  at once, and a tick killed mid-run, cannot both send.
- **N56 — The unsubscribe link carries a signed, scoped, expiring token and names nobody.** No user id,
  address, project slug or event id in the URL. Outlives the mail by a wide margin (60 days) and is not
  single-use. **Strengthened by E19**: implemented as AES-256-GCM ciphertext rather than a merely signed,
  readable payload, because FR-026 forbids a user identifier appearing in the URL at all.
- **N57 — The link lands on a page with one pre-filled submit; it does not act on the GET.** A mail
  client's own one-click unsubscribe button does act immediately, because that one is unambiguously the
  person pressing it. Either way the page afterwards says, in plain words, exactly what changed.
- **N58 — One click turns off every problem email for that person.** The same page offers stopping just
  one project's problems, switching to one digest a day, and a way back — all within the token's scope,
  without signing in. Turning email off never changes in-app notifications (**N5**'s "hides, does not
  delete", applied to channels).
- **N59 — Being unsubscribed is a fact about the person's settings, not a separate flag.** One-click sets
  cadence to off; the per-project variant excludes that project from email only. No second "suppressed"
  state that can disagree with the settings screen (**N26**'s lesson).
- **N60 — The delivery log stores no body, no subject, no recipient address and no free text from the
  SMTP conversation.** One row per attempt: person, cadence, problem count, outcome class, numeric SMTP
  code, duration, instant. A server's refusal routinely quotes the address, so it is classified and
  discarded — the one place this entry departs from the webhook log's shape, for the roadmap's secrets
  rule.
- **N61 — Repeated failure or a permanent rejection pauses that person's email with a reason they can
  see.** Permanent rejection pauses immediately; temporary failures retry with backoff and pause after
  enough consecutive ones — the webhook endpoint's self-disabling rule, with the person able to resume
  it. A pause never touches in-app notifications.
- **N62 — Only a rejection during the conversation is a bounce.** Docket receives no mail, so a delivery
  report arriving later is invisible to it — stated plainly in the docs rather than implied by silence;
  inbound mail is out of scope.
- **N63 — A person sees their own delivery outcome and nobody else's.** No administrative view, no
  public-API operation, no cross-person page.
- **N64 — Invitations are transactional and are emailed whenever email exists, in addition to today's
  in-app notification.** A 7-day deadline, so not governed by cadence, quiet hours, preferences or
  digest; carries no unsubscribe — nothing recurring to unsubscribe from.
- **N65 — The fallback is today's behaviour, unchanged, and the inviter is always told which happened.**
  No email configured, unavailable, or a failed send: the inviter gets the copyable single-use link
  exactly as now, and is told whether mail also went out. The link, its token, hashing, single use and
  expiry do not change.
- **N66 — Docket mails the address on the account and does not require it to be verified.** A permanently
  rejected address pauses that person's email (**N61**), the honest version of the same protection.
- **N67 — An email reveals nothing the person could not already see.** Each problem names its project and
  links into Activity, which still requires signing in; no credential, no token beyond the unsubscribe
  scope, no other person's data. A digest spans only the person's own projects.

### Plan decisions (E1–E34)

- **E1 — The group is `SMTP_HOST` and `SMTP_FROM`; the credentials are an all-or-none pair that requires
  it.** `smtpIssues(source)` is `storageIssues()`'s shape verbatim. *Rejected:* credentials in the group
  (breaks the private-relay case N43 names); one `SMTP_URL` string (one variable every log-scrubber has to
  know, and no per-variable message); a `MAIL_ENABLED` boolean (N26's lesson — a second switch that can
  disagree).
- **E2 — The satellites have no default in the env layer; the default is the transport's and is
  `NEEDS RESEARCH`.** `SMTP_PORT`/`SMTP_SECURITY` validate range/membership only and stay `undefined`
  when unset; `createSmtpMailer()` and `.env.example` get the real default from the one task that can
  know it. *Rejected:* writing `587`/`starttls` in now and fixing later — the guess constitution I
  forbids.
- **E3 — `src/server/mail/` is `src/server/storage/` with a different verb.** `getMailer(): Mailer | null`
  memoised from `getEnv().smtp`, `setMailerForTests()` the only seam; the unavailable transport collapses
  into a `Mailer` that always answers `unavailable`, so callers branch two ways, not three. *Rejected:*
  `requireMailer()` throwing — FR-005 wants a recorded outcome, not an exception.
- **E4 — The `Mailer` interface and its four outcomes.** One `send()` that never throws; `MailOutcome` is
  `sent | rejected | failed | unavailable`, each with `durationMs` and an optional numeric `code`.
  *Rejected:* throwing typed errors; a boolean plus out-parameter; one `failed` covering both permanent
  and temporary (FR-023 treats them completely differently).
- **E5 — The wire transport is one file whose body is the only thing the deferred task rewrites.**
  `src/server/mail/smtp.ts` ships today as `return null` with both marks named verbatim. *Rejected:*
  hand-rolled SMTP (constitution VI); shelling to `sendmail` (FR-005 forbids by name); a hosted HTTP
  provider (out of scope).
- **E6 — One sparse settings row per person; absence is "off".** `email_settings` is created only by the
  first save; no migration inserts a row — N45/FR-007's "nothing opts anybody in" as a fact about the
  database, Q2's move repeated.
- **E7 — The claim lives on the settings row, not in a second table.** `next_due_at`, `lease_owner`,
  `lease_until`, failure count, pause state and last outcome live on `email_settings`, because there is
  one claim per person and a second table could only ever disagree.
- **E8 — One per-project row carries the position, the exclusion and the in-flight high-water.**
  `email_project_state(project_id, user_id, mailed_seq, excluded, sending_seq)`, absence meaning neutral
  for both; the composite FK to `member` makes FR-025's cascade the database's job, R1/M1/Q1's shape.
- **E9 — Three transactions and a `sending_seq` column.** Claim → assemble (read-only) → write
  `sending_seq` under the lease → `mailer.send()` outside any transaction → record. Advancing the position
  before sending loses a message on the first temporary failure; advancing only after sending risks a
  duplicate on a crash between send and record. `sending_seq` is the smallest thing that tells recovery
  "may have finished" from "never started".
- **E10 — Recovery of an expired lease is "sent".** `recoverEmailClaims()` treats any row with
  `sending_seq` set and an expired lease as sent, logs the attempt as `internal`, and rolls `next_due_at`
  forward — N54's duplicate-avoidance made concrete.
- **E11 — One `next_due_at` drives both cadences, and ordering by it is the fairness rule.** The claim
  query is `ORDER BY next_due_at ASC LIMIT maxPerTick FOR UPDATE SKIP LOCKED`, serving the
  longest-overdue first (FR-024) off one indexed column.
- **E12 — `nextDue()` takes `lastSentAt`, because otherwise FR-020 cannot hold.** Comparing the local date
  of `lastSentAt` against `now` is what lets a digest-hour change mid-day send exactly once instead of
  twice or skipping a day.
- **E13 — "Same local day", and why a missed digest is skipped rather than sent stale.** Compares
  `Instant.toZonedDateTimeISO(zone).toPlainDate()`; a digest due on an earlier local day than now is
  skipped with no attempt row and no position movement.
- **E14 — Quiet hours are two nullable hour columns; equal ends normalise to none.** `CHECK` both-or-
  neither; the Zod boundary folds `start === end` into `(null, null)` so the clock module has no
  equal-ends special case.
- **E15 — Assembly reuses the existing attention branch builder, with one new marks mode and one
  `minSeq`.** `listBranch()` gains `exclude: "snoozed" | "hidden"`; `minSeq` becomes
  `max(groupThreshold, floor, mailed_seq)` — three reasons an event is not mailed, one comparison, no
  second attention query to drift from the first.
- **E16 — The bounds: 20 listed, 1000 scanned, the overflow counted exactly within that.**
  `EMAIL_LIST_LIMIT = 20`, `EMAIL_SCAN_LIMIT = 1000`; `sending_seq` is the scanned set's `max(seq)`, so the
  position advances over the counted overflow too — one bad day produces one message, not a run of them.
- **E17 — A sixth section, with constants beside `WEBHOOK_DEFAULTS` and no new environment variable.**
  `EMAIL_DEFAULTS`: `maxPerTick` 50 (SC-009's 500-in-10-ticks), `concurrency` 8, `minWindowMs` 11000,
  `backoffBaseMs`/`backoffMaxMs` the webhook section's values, `pauseAfterFailures` 5 (tighter than the
  webhook endpoint's 20 — five failed attempts to one inbox already span most of a day), `unavailableRetryMs`
  3600000, `retentionDays` 30.
- **E18 — The section's first line is the capability check.** `if (!getMailer()) return
  emptyEmailCounts();` before any query, clock read or heartbeat — SC-006's zero-behaviour-change install
  made structural.
- **E19 — The unsubscribe token is AES-256-GCM ciphertext, not a signed payload.**
  `encryptSecret(JSON.stringify(payload), { aad: "docket-unsubscribe-v1" })`; nothing stored. A
  signed-but-readable payload would carry the user id in the clear, failing FR-026, so AEAD is a
  strengthening of N56's literal "signed", not a substitution — recorded there.
- **E20 — The token's plaintext, and its 60 days.** `{ v, u, p: projectId | null, x: expiry }`; `p: null`
  for a digest spanning several projects. Expiry `now + 60 days` (N56).
- **E21 — A page for the human, a POST route for the mail client.** `GET /email/unsubscribe` renders and
  writes nothing; `POST /api/email/unsubscribe` is a session-less Route Handler, the one-click path, which
  does act immediately. The header names a mail client needs to find that route are `NEEDS RESEARCH`; the
  route already handles whatever body that research says the client sends.
- **E22 — One click is `cadence = 'off'`, and nothing else.** Every submit maps to exactly one settings
  write; no `notification_preferences`, `notification_states` or `notification_event_marks` row is ever
  touched by an unsubscribe action.
- **E23 — One neutral page, one status code, for every refusal.** A bad, expired, re-signed or
  scope-mismatched token all render the same sentence with HTTP 200 and write nothing — a different
  status or render time would be a probe.
- **E24 — The log is person-scoped, has no excerpt column, and allows a null person.**
  `email_delivery_attempts(id, user_id NULL, at, purpose, cadence, problem_count, outcome, smtp_code,
  duration_ms)`; an invitation to an address with no account logs with `user_id = NULL` rather than the
  address. Pruned at 30 days by the section itself.
- **E25 — The invitation result gains one field, and `manual_link` is returned whenever there is no
  account.** `InvitationEmail = "sent" | "failed" | "unavailable"` joins both `InvitationDeliveryResult`
  variants, so the inviter is always told which happened and the copyable link never disappears because
  mail also went out.
- **E26 — Invitation mail is a value, not a throw, and never rolls back the invitation.**
  `deliverAfterCommit()`'s `catch` no longer turns a delivery problem into `ConflictError`; the mailer
  never throws, so the normal path cannot reach it.
- **E27 — The person's zone default is derived, and the browser only pre-fills.** `derivedZone()` returns
  the single zone every project agrees on, else UTC; `BrowserTimeZone` sets the select only when no zone
  is stored, so opening the page on holiday never silently changes a chosen zone.
- **E28 — One extension to `docs/design-system.md` §7: a no-JavaScript exception for long lists.** Where a
  control must be changeable with client JavaScript unavailable, a long list (digest hour, time zone) uses
  `Select`, not `Combobox` — `Combobox` submits a hidden input carrying the server-rendered default when
  JavaScript is unavailable, so the visible control would silently fail to take effect. Cadence stays a
  `SegmentedControl` (native radios already work with no JavaScript).
- **E29 — The email settings are one form with one Save; pause/resume is its own one-button form.**
  Cadence, hour, zone and quiet hours are one coherent schedule saved together; resume-after-pause is a
  different question, answered by a separate Q18-shaped switch.
- **E30 — One pure renderer: text first, HTML derived, no remote anything.**
  `renderProblemEmail(model): { subject, text, html }` is pure; every instant goes through
  `formatLocal(instant, zone)` in the **person's** zone, not a project's. No images, remote stylesheet,
  tracking pixel or click wrapping.
- **E31 — No public API, no webhook event, no new settings route.** Settings live on the existing
  `/notifications` page and its existing actions; there is no handler to protect because none is added.
- **E32 — Nothing else is added to the stack.** No queue, no Redis, no second process, no infrastructure,
  no new UI primitive, no new index on `activity_events`; one runtime dependency, `nodemailer`, marked and
  recorded.
- **E33 — Retention is pruned by the email section itself.** `purgeEmailHistory(30)` runs at the end of
  `runEmailDeliveries()`, the shape `runWebhookDeliveries()` already uses — a purge inside the section, not
  inside `runHousekeeping()`.
- **E34 — The address has exactly one shape and one home.** A recipient address exists only as
  `MailMessage.to`, constructed inside `send.ts`/`invitations/delivery.ts` and passed straight to
  `mailer.send()` — never a DAL parameter, never in an outcome, heartbeat, thrown error or `console` call,
  so the secrets assertion is checkable by reading the call sites.

## 045 — Credit hold (2026-10-11)

Spec: `specs/043-llm-credit-hold`. The section number follows this file's own sequence (044 is Email
delivery, whose spec directory is 060), not the spec directory: parallel branches were each assigned spec
number 043 by speckit, because each was cut from a `main` whose highest spec was 042.

latency: unmeasured; live path verified with mocks only.

Roadmap entry 1 of 3 (`.specify/roadmaps/llm-credentials.md`, slug `credit-hold`): a provider refusing a
call on billing used to permanently fail every item it touched. Full text in
`specs/043-llm-credit-hold/spec.md` (C1–C14) and `specs/043-llm-credit-hold/research.md` (H1–H19).

### Spec decisions (C1–C14)

- **C1 — One new kind, `credit_exhausted`**, in both pgEnums (`llm_failure_kind`, `generation_job_item_error`),
  named for the condition rather than the provider, and distinct from `refused` (the model declining to
  write a post). *Reverse:* drop the enum value (migration) and its callers.
- **C2 — Detection is per provider, structured, and conservative.** Anthropic: an `invalid_request_error`
  (or declared `billing_error`) whose body names a credit balance. OpenAI: `code === "insufficient_quota"`,
  checked before the `RateLimitError → rate_limited` mapping. *Reverse:* make both predicates return false.
- **C3 — An unrecognised shape keeps today's behaviour.** A missed detection costs today's behaviour; a false
  positive would stall an install, so the predicate stays narrow.
- **C4 — `bad_request`'s sentence is untouched**; the new kind gets its own, and is not added to the
  in-request `RETRYABLE` sets (a correction retry cannot buy credit).
- **C5 — A billing refusal never fails a job item.** It returns to `queued`, immediately due, no attempt
  counted, lease released, following the existing deferred-correction-retry precedent.
- **C6 — The hold, not `TEMPORARY`.** Adding the kind to `TEMPORARY` was explicitly rejected: three attempts
  over about 20 minutes still mass-fails an outage that lasts until someone tops up. While held, the runner
  claims nothing for that credential.
- **C7 — The hold is scoped by credential owner from day one**, even though there is exactly one owner
  today, so roadmap entry 2 (`per-project-llm`) can widen the scope to per-project by changing one function
  and the stored owner values, without reworking the hold, the probe, the notices or the claim's shape.
- **C8 — No credential value, and no fingerprint of one, is stored.** The hold records that an owner is
  refusing, never which key, keeping the env-only invariant true and the new table outside the
  secret-scan's concern.
- **C9 — Recovery is detected by a successful call, never guessed.** While held, one item is let through
  every 5 minutes as a probe; any outcome other than a billing refusal clears the hold.
- **C10 — The probe is single-flight**, decided inside the same transaction that writes the next probe time
  — no advisory lock, per the Neon transaction-mode pooler constraint.
- **C11 — Interactive generation is not blocked**, and every call site (single, series, regenerate, voice
  "Try it", job item, `pnpm llm:check`) sets or refreshes the hold on a billing refusal and clears it on any
  other outcome — a free probe.
- **C12 — No give-up timeout.** A hold lasts until credit returns or the job is cancelled; nothing is
  destroyed.
- **C13 — Honest notices on both Batch jobs screens, naming billing**, in the shape and tone of the two
  existing notices; no new job or item status is introduced.
- **C14 — Items already failed by an earlier outage are not touched.** No migration rewrites history;
  "Retry failed items" is what recovers them, and after this entry it is safe to press during an outage.

### Plan decisions (H1–H19)

- **H1 — One install-wide table, `llm_credit_holds`**, keyed by `owner`, next to `llmFailureKind` in
  `src/server/db/schema/generation.ts`, registered in `notProjectOwned`. *Rejected:* a column on
  `scheduler_heartbeats` (overwritten every tick); a JSON blob on a singleton (loses "at most one per
  owner" as a database fact); a project-owned table (a hold belongs to a credential, not a project).
- **H2 — The credential-owner seam is `src/server/dal/credential-owners.ts`**, async and SQL-aware from day
  one (`credentialOwnerFor`, `jobsExcludingProjects`) even though today's implementation is a constant — the
  whole point of C7/SC-010, so entry 2 rewrites one file and nothing else.
- **H3 — Detection is one named predicate per provider**, reading structured fields (`error.type`,
  `error.code`), because `APIError.error` means a different thing in each SDK (the whole body in Anthropic,
  the inner object in OpenAI) — one shared body-walker would be wrong for one of them.
- **H4 — The predicate runs immediately after the timeout branch**, before every other branch, in both
  `kindOfError` functions — satisfies FR-003 literally and cannot shadow `auth`.
- **H5 — The gate is two statements inside the existing claim transaction**: an unlocked read of every held
  owner, then `FOR UPDATE SKIP LOCKED` on the due ones. A row locked by another tick reads as held-and-not-
  probing, never as not-held — the conservative direction, and why exactly one probe happens per interval
  with no blocking wait.
- **H6 — `next_probe_at` is always `now + CREDIT_PROBE_INTERVAL_MS`**, never accumulated, so a missed
  window, a long outage or a clock moving backwards all yield exactly one probe. The 5-minute interval is a
  documented constant, no environment variable.
- **H7 — A granted probe is rewound unless a model call was actually made** (`rewindCreditProbe`, update
  only, never an insert), so a probe skipped for tick budget, a lost lease or an exception does not consume
  the interval.
- **H8 — `itemDue` (queued-and-due, or `running` with an expired lease) is the item predicate for every
  owner, probing or not**; US1 AS5 is protected instead by gating the lease-recovery attempt increment and
  the `interrupted` failure on `!probe` (`job-claims.ts`). A probing owner whose only due work is a
  lease-expired `running` item can still probe it, without the probe ever counting an attempt or failing
  that item.
- **H9 — `claimDueJobItems` returns `{ items, held, probing }`** so the tick summary needs no second, racy
  read after the transaction.
- **H10 — Blocked owners are excluded in SQL; probing owners are capped in memory at one item**, so an
  empty hold table leaves the claim's SQL byte-identical to `main`'s (SC-007) and a held owner cannot starve
  a free owner's budget.
- **H11 — The requeue is `release()` plus the recorded reason**, counted as `requeued` — distinct from
  `retried` (counts an attempt) and `released` (no reason). The runner's dispatch becomes three-way:
  `credit_exhausted` → requeue, `TEMPORARY` → `retryLater`, otherwise → `fail`.
- **H12 — `withCreditHold(llm, owner)` wraps the provider inside `runGenerationStep` and `planSeries`**, the
  only two places a provider's `generate` is called, so a test-injected provider is observed too; the hold
  write is awaited and its errors swallowed, so a database hiccup never turns a good generation into a
  failure.
- **H13 — `pnpm llm:check` uses the same wrapper** and tolerates having no database, because write errors
  are swallowed by H12.
- **H14 — `credit_exhausted` is added to neither `RETRYABLE` set**, and `FAILURE_PROBLEM` gains no entry —
  the absence of a change.
- **H15 — One route-local notice component**, `JobNotice`, rendering `role="note"` (not `Alert`'s
  `role="alert"`, which would announce more aggressively than today's two existing notices).
- **H16 — The waiting row shows its reason only for a `queued` item whose kind is `credit_exhausted`**, so
  an old `rate_limited` error on a `queued` item renders exactly as it does today.
- **H17 — The fixed sentence names credit and what to do**, and says nothing about jobs resuming (the
  notice carries that), because the same sentence serves a single generation, a stored failure, an API
  503, a waiting job row and `llm:check`.
- **H18 — `credit_exhausted` maps to the existing 503 `generation_unavailable`**, with no new API error
  code — the honest reading, since nothing about the request is wrong and a caller is already told that
  retrying the same key later is safe.
- **H19 — The secret-scan extension**: a generation section inside the existing scanned run, with a real
  provider's error body embedding the configured key, a tick against a held job, and both Batch jobs screens
  rendered held — proven able to fail by the file's existing deliberate-leak test. `no-plaintext.test.ts`
  gains the two keys and their SHA-256 hex, and a hold row before its all-tables dump.

### What this entry does not do

- **Per-project or per-user LLM keys, models or settings** — roadmap entry 2, `per-project-llm`. This entry
  leaves the env-only invariant true and provides the credential-owner seam (H2) entry 2 widens.
- **Persisting token usage or cost** — roadmap entry 3, `llm-cost-visibility`. Usage stays logged and
  unpersisted.
- **Budgets, caps or throttling on spend** — out of the roadmap entirely.
- **Re-specifying the `bad_request` operator message** — already landed; untouched here (C4).
- **Notifying anyone about a hold**, and **a hold notice outside the Batch jobs screens** — the notifications
  roadmap owns attention events; interactive generation answers with its own sentence instead.
- **An operator control to lift, force or inspect a hold** — recovery is a successful call; the tick summary
  and heartbeat carry the fact.
- **A give-up timeout**, and **retro-classifying items failed by outages before this release** — neither is
  owned by any roadmap entry (C12, C14).
- **Detecting any other provider condition** (expired cards, suspended accounts, spend limits, regional
  restrictions) beyond the two verified shapes, and **any provider beyond `openai` and `anthropic`**.

## 046 — Real-time updates (2026-10-12)

The bell's count moves from a 60-second poll to a server push, with the poll kept as its fallback. See
the N12 reversal recorded in place above, and the extensions recorded next to N39, R10, R11, R12 and R15.

### Spec decisions (N68–N84)

- **N68 — One authenticated stream endpoint per person, under `/api/me/`, carrying count snapshots and
  nothing else.** Session cookie only; an API key gets the same 401 as no session; no query parameter,
  header or body is ever read. The body is exactly `GET /api/me/notifications`'s shape, from the same
  service call (N39). Never on the wire: problem rows, event text, project names, account names, platform
  keys.
- **N69 — Snapshots, not increments, which is what makes reconnection safe.** Every message is the whole
  current count; a missed message cannot be missed and a duplicate cannot double-count. No replay buffer,
  no server-side event log, no cursor, no message ids, and therefore no `Last-Event-ID`.
- **N70 — The announcement rule survives, measured against what the page last showed.** A snapshot higher
  than the last count the page displayed is announced; an equal or lower one, including a reconnect's
  repeated snapshot, is silent (N12, R15).
- **N71 — No process ever notifies another; every process discovers change in the database they already
  share.** One watcher per web process, not per connection, probing a fixed set of install-wide scalars
  every 2 seconds. Several web processes need no coordination, no shared memory and no Postgres `LISTEN`.
- **N72 — The cost stops growing with tabs; the promise is "seconds", not "instant".** The per-person
  count query moves from once per open tab per minute to once per connected person per actual change, in
  exchange for one small fixed probe per web process every 2 seconds whether anyone is connected or not.
- **N73 — The stream follows the visible tab**, exactly where N12's timer stopped and started, so a
  backgrounded tab still costs the server nothing, and a person with many tabs does not exhaust HTTP/1.1's
  roughly six connections per origin.
- **N74 — The caps are constants, not settings: 50 streams per web process, 5 at once per person.** An
  install's ceiling is 50 × the number of web processes, stated in `docs/deployment.md`. No environment
  variable; more capacity means another web process.
- **N75 — At the person's cap their oldest stream is closed; at the process cap the newcomer is told to
  poll.** A sixth tab displaces the first, which falls back with nothing lost (N69). A full process refuses
  the newcomer, never queues, never closes someone else's stream.
- **N76 — A connection is deliberately short-lived: the server closes it after 4.5 minutes and the client
  reconnects.** A proxy timeout, a container restart, a deploy and a rolling restart all then look like
  ordinary operation; the reconnect's opening snapshot arrives in well under a second.
- **N77 — A heartbeat every 20 seconds, and the client insists on the opening snapshot within 5 seconds.**
  The heartbeat keeps a proxy's idle timer off and is how the client detects a buffering proxy, which
  otherwise looks open while delivering nothing. An install behind one degrades to the poll by itself.
- **N78 — The proxy configuration is a documented requirement, not left to hope.** `docs/deployment.md` §7
  states what must be true — buffering off, a timeout above the heartbeat, HTTP/1.1-or-better with no
  response transformation — in that section's existing voice, plus the ceiling (N74) and that a proxy that
  cannot be changed still works on the fallback.
- **N79 — The poll is not deleted; it becomes the fallback, and the server-rendered count stays the
  floor.** Three complete layers: the no-JavaScript server-rendered count (022's FR-014), the unchanged
  60-second poll, and the stream when it works. `poll.ts` keeps its shape and its tests; only who starts it
  changes.
- **N80 — What counts as "unavailable", and what does not.** Unavailable: no `EventSource`, a cap refusal,
  a connection or server failure, no opening snapshot within 5 seconds, or more than 3 backed-off failed
  attempts — remembered per tab. Not unavailable: a 401 (N81) or an ordinary scheduled close (N76). A
  failure is silent; the last known count stays on screen.
- **N81 — Sign-out, session expiry and membership removal all end the right thing, and none leaves a stale
  count on screen.** The stream re-resolves the session and memberships on every recompute and at least
  once a minute, bounded at 4.5 minutes regardless (N76). A gone session ends the stream with a terminal
  message and the client stops reconnecting. Losing a membership is not an ending — the next snapshot just
  reflects it (022's FR-019).
- **N82 — A push never marks anything read and never refreshes the page.** The stream is read-only: it
  never runs the problems-view mark and the client never calls `router.refresh()` on a push (R10).
- **N83 — An open panel is refreshed by a push**, because a panel that disagrees with the bell is worse
  than one a second late. The bell bumps a `refreshKey` the panel's existing fetch effect depends on;
  nothing else on the page reacts to a push.
- **N84 — A snapshot yields to the person's own action for one probe interval.** A mark, snooze or
  preference change shows its own authoritative count at once; stream snapshots are ignored for 2 seconds
  afterward, so the badge never flickers back to a number the person just acted on.

### Plan decisions (S1–S32)

- **S1 — One Route Handler returning a `ReadableStream`**, under the existing personal prefix
  (`GET /api/me/notifications/stream`), `force-dynamic` like its two siblings. *Rejected:* long-polling the
  count route; WebSockets; a hand-rolled `fetch` reader instead of `EventSource`.
- **S2 — `Content-Encoding: identity` is how the stream escapes Next's own gzip.** Verified against the
  installed package: `compressible` has no `text/event-stream` entry, so the stream is gzip-compressible by
  default unless the response declares `identity`, which the bundled listener passes straight through.
- **S3 — `X-Accel-Buffering: no` as well**, for nginx-family proxies; every other proxy is covered by the
  documented requirement (N78) and the client's own buffering detection (N77).
- **S4 — The response headers, and the ones deliberately absent.** `Content-Type`, `Cache-Control`,
  `Vary`, `Content-Encoding`, `X-Accel-Buffering`. No `Connection` header (meaningless on HTTP/1.1, illegal
  on HTTP/2); no `Content-Length` (there is none, which is what signals chunked transfer).
- **S5 — Five named events, no event ids, no `retry:` field.** `snapshot`, `ping`, `reconnect`,
  `unavailable`, `ended`. No `id:` is ever sent, so the browser never sends `Last-Event-ID` (N69).
- **S6 — The heartbeat is a named `ping` event, not an SSE comment**, so the client's silence watchdog
  (S17) can actually observe it, as well as keeping a proxy's idle timer off.
- **S7 — The refusal at the process cap is a 200 stream carrying one `unavailable` event**, not a 503,
  because `EventSource` cannot read a failed connect's status or body.
- **S8 — A displaced stream gets the same `unavailable`, and the displaced tab remembers it**, so six tabs
  of one person do not round-robin displace each other forever.
- **S9 — Admission order: session, then the person's own displacement, then the process cap, then the
  count.** Displacing before the process check means a person at their own cap is never refused for a slot
  they were about to free; computing the summary last means a refused request costs no query.
- **S10 — 401 is the count route's own refusal, byte for byte**, including for an API key, which is simply
  not a session.
- **S11 — `EventSource`'s own reconnection is overridden entirely.** `onerror` closes the source and the
  client's own state machine decides what happens next, because the browser's built-in retry cannot
  distinguish a 401 from a refusal from an ordinary close.
- **S12 — A 401 is learned from the existing count route, not from the stream.** One probe to
  `GET /api/me/notifications` on a failed connect: 401 ends things for good (N81); 200 means back off and
  retry, and refreshes the count for free.
- **S13 — One watcher per web process, discovering change in the database they already share** (N71): a
  sequential loop — probe, round if due, sleep — so a problem from any writer is seen within one interval
  with nothing added to the stack.
- **S14 — The fingerprint: nine scalars, one statement**, each sparse table contributing a `count(*)` and
  a `max(updated_at)` so additions, changes and deletions are all visible; `member` likewise, with no
  `updated_at` needed because all three roles already count.
- **S15 — One new partial index, migration `0023`, and why the probe needs it.** `max(seq)` restricted to
  attention outcomes needs a dedicated partial index to be both O(1) and independent of install size; pure
  additive DDL, no operator action.
- **S16 — `updated_at` is stamped by the database, not by the web process.** One pre-existing path in
  `src/server/dal/notifications.ts` built it in JavaScript; fixed in passing so the fingerprint's instant
  comparisons are sound against a web process whose clock lags.
- **S17 — A 45-second silence watchdog on the client**, just over two heartbeats, for a socket that dies
  without a FIN — a sleeping laptop, a network change, a proxy that starts buffering mid-stream. Counts as a
  drop, never a terminal end.
- **S18 — The connection lifetime is 4.5 minutes, not 5**, so Docket is always the party that closes first
  under the common 300-second proxy/Node read-timeout default, and a scheduled close never races a timeout.
- **S19 — Teardown does not depend on `request.signal` or `cancel()`**, neither being documented for this
  installed framework. Every write is guarded; a throw deregisters and clears timers; the 20-second
  heartbeat is therefore also the liveness check.
- **S20 — The session re-check is a read-only `SELECT`, never `auth.api.getSession`**, because the latter
  can refresh and write a cookie a response whose headers are already sent cannot deliver (N81).
- **S21 — Two tabs of one person share one recompute.** A round groups connections by user id and computes
  each person's summary once, comparing it against each connection's own last-sent value.
- **S22 — At most three recomputes at once, and a sequential loop**, against a default pool of 10, leaving
  7 for ordinary page requests; a worst-case round at the cap is well inside the 2-second interval.
- **S23 — The watcher starts with the first connection and stops with the last**, guarded by the same
  `Symbol.for` singleton pattern `src/server/scheduler/in-process.ts` uses, so a quiet process probes
  nothing and a hot reload cannot start two.
- **S24 — A failed probe changes nothing; a failed recompute keeps its connection.** The baseline advances
  only on a successful probe; a failed recompute retries next round rather than sending a wrong count or
  closing anyone.
- **S25 — One pure state machine, and `poll.ts` untouched.** `refresh.ts`'s five states — `hidden`,
  `connecting`, `streaming`, `polling`, `ended` — hold the stream in exactly the two states where the poll
  must not run, and vice versa (022's FR-019).
- **S26 — The fallback leg refreshes at once on entry, through `poll.ts`'s own hook**, by pulling its
  existing `onChanged` trigger the moment the supervisor enters `polling`, with no edit to `poll.ts` itself.
- **S27 — One announcement baseline across both legs**, so switching between stream and poll can neither
  re-announce a count already shown nor miss a rise across the switch (N70, R15).
- **S28 — The 2-second yield is driven by the bell's own local changes** — a row action, "mark all", the
  in-page changed event — never by the poll leg, whose own fetch always runs after the write that triggered
  it (N84).
- **S29 — The panel refetches on a push through one new prop**, `refreshKey` added to the dependency array
  of the fetch effect `NotificationPanel` already has. `router.refresh()` is still never called (N83, R10).
- **S30 — Nothing else moves.** No table, environment variable, runtime dependency, infrastructure,
  `docker-compose.yml` or `next.config.ts` change, security header, UI atom or visible control.
- **S31 — A stream request cannot be mistaken for a problems view.** The route never calls
  `ensureProblemsViewMarked()`, and the client never calls `router.refresh()` on a push (N82, R10).
- **S32 — Every interval and cap is a shared constant, not a setting.** `stream-protocol.ts` holds the
  path, the event names, the codec and every number; server and client import the same module, so the
  client's deadlines and the server's heartbeat cannot drift apart.

### Revision, same day — the probe reads a marker row, not an index on `activity_events`

N71 and N72 were written against an install-wide probe that asked `max(seq)` over `activity_events`
behind a partial index covering the four attention outcomes. CI rejected it: the planner then preferred
that index for the recent-problems panel too, and the panel's SC-003 budget went from passing to
**155.7 ms against 100 ms** at twenty projects, while `count` and `refresh` stayed comfortable. The probe
index and the panel's per-project index filter on the same outcomes, so no predicate separates them — the
index that makes the probe O(1) is also attractive to the panel, and worse for it.

- **N71 stands as written** — no process notifies another; every process still discovers change in the
  database they already share, with one watcher per web process probing every 2 seconds.
- **N71.1 — what it probes changed.** The first of the nine scalars now reads
  `notification_change_marker`: one row for the whole install, holding a counter the activity writer
  bumps in the same transaction when, and only when, the outcome is an attention outcome. The probe is a
  primary-key read, and **no read plan on `activity_events` changes at all**.
- **N71.2 — the hot path is untouched.** A post publishing successfully writes no attention outcome, so
  it never touches the marker. Only failures, ambiguities, reauth and connect attempts do, and those are
  rare by comparison. Writers already take KEY SHARE on their project row before drawing `seq` and take
  the marker after it, so the order is always project then marker.
- **N71.3 — the writer upserts rather than updates.** A plain `UPDATE` against a missing row would touch
  nothing and change detection would stop silently, which is a worse failure than any cost of the
  `ON CONFLICT` path. The migration seeds the row as well.
- **N72 stands, with a cheaper probe than it claimed.** Per-person count queries still fall to zero in
  exchange for one fixed probe per web process every 2 seconds; that probe is now a single-row read
  rather than an index scan, so SC-004's "same work with 1 connection and with 50" holds more easily.

Measured on the same machine, same seeded test: the 20-project panel went from 125–168 ms with the index
to **79.5 ms** with the marker, with `count` and `refresh` unchanged at about 72 ms.

## 047 — Per-project LLM (2026-10-12)

Spec: `specs/065-per-project-llm`. Roadmap entry 2 of 3 (`.specify/roadmaps/llm-credentials.md`, slug
`per-project-llm`): a project may store its own LLM provider, model and API key, so its generation spends
its own credential instead of the install's, widening the credential-owner seam (H2) entry 1 left for
exactly this. Full text in `specs/065-per-project-llm/spec.md` (K1–K16) and
`specs/065-per-project-llm/research.md` (L1–L33).

**An install that only ever used environment variables needs to do nothing.** With no project credential
stored, every project keeps using the install default exactly as before — same prompts, calls, logging,
timings and existing test expectations; the only visible addition is a settings section telling an owner or
admin that the project uses the install default (K4).

### Spec decisions (K1–K16)

- **K1 — The override is one atomic credential: provider, model and key together, or nothing.** No
  field-by-field fallback; resolution is a choice between two complete configurations.
- **K2 — Timeout and output-token limits stay install-wide.** They are operational safety limits tied to
  the tick budget, not spend choices; both apply unchanged to a project credential.
- **K3 — A project credential makes generation available for that project even when the install has
  none.** `LLM_PROVIDER` unset now means "off for projects without their own credential", not "off
  everywhere".
- **K4 — Nothing changes for an env-only install**, beyond one settings sentence saying the project uses
  the install default.
- **K5 — One project-owned row per project, with the key in a single encrypted column**, through the
  scoped DAL like every other project-owned table, keyed as associated data to the project.
- **K6 — Nothing but the ciphertext is kept.** No plaintext, hash, prefix, last-four, length or
  fingerprint — nothing here ever needs to recognise the key, only use it.
- **K7 — The key is write-only in every direction.** Read only to make a provider call; never in an
  action result, page, log line, error message, audit row, API payload or test snapshot.
- **K8 — Leaving the key field blank keeps the stored key**; switching provider requires a key, because a
  key belongs to one provider.
- **K9 — A key that cannot be decrypted makes generation unavailable for that project; it never falls
  back to the install default.** The project is told, in a fixed sentence, that an owner or admin must
  re-enter the key; the stored row is left alone.
- **K10 — Provider error text is still never surfaced.** The fixed per-kind sentences remain the only
  user-facing failure text, for the check too; no new failure kind and no new API error code.
- **K11 — A new permission statement for the credential, granted to owner and admin only.** Editors do
  not see the section at all (absent, not disabled), and the server refuses their actions whatever the UI
  shows.
- **K12 — Every set, change and removal is audited** — actor, provider and model before and after, and
  whether the key changed; never the key.
- **K13 — Removing the override is one explicit, confirmed action**, because it silently moves spend back
  onto the install's account.
- **K14 — One check service, two callers.** A single function performs the per-project check; both the
  settings surface and the command line call it, reporting source, provider, model, outcome and latency,
  and never a key.
- **K15 — The check is serialised per project with a short cooldown**, and runs through
  `withCreditHold`, so a billing refusal during a check sets that project's hold and any other outcome
  clears it (C11).
- **K16 — The credential owner becomes the credential, and a credential change clears that owner's hold
  at once.** A project with its own credential is its own owner; everything else about the hold — the
  5-minute probe, single-flight probing, nothing failed or unreserved while held, no give-up timeout, no
  operator control to lift it — is unchanged, simply now per owner.

### Plan decisions (L1–L33)

- **L1 — One new project-owned table, `project_llm_settings`**, primary key `project_id`, carrying the
  optional credential, who last changed it and when, and the check lease bookkeeping.
- **L2 — The row may exist with no credential; the credential is `provider IS NOT NULL`.** A CHECK makes
  K1's atomicity a database fact; removal nulls all three credential columns and keeps the row.
- **L3 — `provider` is `text` with a CHECK naming the two providers**, not a new pgEnum, matching the
  email tables' shape.
- **L4 — The associated data is `project_llm_credential:<projectId>`**, the shape
  `webhook_endpoint:<id>` already uses.
- **L5 — Nothing but the ciphertext.** No hash, prefix, last-four, length or fingerprint column exists to
  populate; status is computed from `api_key_encrypted IS NOT NULL`.
- **L6 — The one named place is `src/server/llm/resolve.ts`, `resolveLlmForProject(projectId)`**, the
  only code that reads the credential table or calls `getLlm()` on a project's behalf.
- **L7 — No provider-instance cache for a project credential.** The install branch keeps its existing
  memoisation; a project credential constructs its SDK client per resolution.
- **L8 — Install-wide limits are parsed on their own** via a new `parseLlmLimits(source)`, fixing in
  passing a hard-coded 90 000 ms fallback that was wrong the moment a project could generate on an
  install with no `LLM_PROVIDER`.
- **L9 — `credentialOwnerFor` becomes a read of the table**; owner values are `"install"` and
  `project:<uuid>`, so every existing hold row keeps its meaning.
- **L10 — A batch sibling, `credentialOwnersFor(projectIds)`**, one statement for many projects, used by
  `resolveBlockedProjectIds` inside the claim transaction.
- **L11 — The resolved credential carries its owner**, so `runGenerationStep` and `planSeries` stop
  asking twice.
- **L12 — Readiness, overview, job creation, the Batch jobs screens and the job page take their answer
  from `resolveLlmForProject`.** `getLlmStatus()` survives for startup-adjacent code and as resolution's
  install branch.
- **L13 — Test seams: `setLlmForTests` is untouched and still wins everywhere.** A new
  `setLlmFactoryForTests((config) => provider)` is consulted only when that override is unset.
- **L14 — A new permission statement, `llm_credential: ["manage"]`**, granted to `owner` and `admin`,
  absent from `editor`.
- **L15 — A settings sub-page, `/p/[projectSlug]/settings/model`**, beside API keys and Webhooks. An
  editor reaching the URL directly gets `notFound()`.
- **L16 — The key input is a `type="password"` field with `autoComplete="off"` and no value, ever.**
- **L17 — One shared Zod schema for provider and model**, `projectLlmCredentialSchema`, bounding the key
  at 500 characters after trimming.
- **L18 — One audit action, `llm_credential_update`**, covering set, change and removal, with details
  `{ fromProvider, fromModel, toProvider, toModel, keyChanged }` — never the key.
- **L19 — Removal is a confirmed `Dialog` submit** naming the project and saying plainly that generation
  moves back onto the install's account.
- **L20 — The surface reports, and never renders a fragment of the key**: provider and model in force,
  whether that is this project or the install default, whether a key is stored, and who last changed it.
- **L21 — One check implementation, two callers**, in `src/server/services/generation/check.ts`:
  `runLlmCheck(projectId, repo)` is resolve, gate, one call through `withCreditHold`, release, map; and
  `checkProjectLlm(scope)` is `need(scope)` plus that call.
- **L22 — The gate is a lease plus a cooldown on the settings row**, claimed and released in two short
  transactions with the live call in between, the shape webhook delivery and email already use.
- **L23 — Documented constants, not environment variables**: `LLM_CHECK_COOLDOWN_MS = 30_000`,
  `LLM_CHECK_LEASE_MS = 60_000`, call timeout `min(installTimeoutMs, 30_000)`.
- **L24 — The CLI grows one optional argument.** `pnpm llm:check` with no argument is byte-identical to
  today; `pnpm llm:check --project <slug>` resolves and checks that project with no session.
- **L25 — Saving, changing and removing clear the project's hold inside the same transaction as the
  write**, so "its items resume on the next tick" is a committed fact.
- **L26 — The notice gains one sentence naming whose account needs credit.** `CreditHoldNotice` takes a
  `scope: "project" | "install"` prop.
- **L27 — The runner's global gate becomes "the install is configured, or some project has a
  credential".** Per item, `not_configured` or `key_unreadable` releases the item — no attempt counted,
  no failure.
- **L28 — Orphan hold rows are swept by housekeeping**: `pruneOrphanCreditHolds()` deletes
  `project:<uuid>` rows with no matching project.
- **L29 — The undecryptable-key sentence is a resolution state, not a failure kind.** No `LlmFailureKind`
  is added; the public API maps it onto the existing `generation_not_configured`.
- **L30 — The runner's `logLine` redacts the *resolved* key, not just the environment's.**
- **L31 — A new guard test extends the existing one.** `key-reads.test.ts` gains a sibling asserting
  `api_key_encrypted` / `apiKeyEncrypted` is read and decrypted only in `project-llm.ts` and `resolve.ts`,
  and that `runLlmCheck` is imported only by its siblings and the CLI script.
- **L32 — The secret-scan extension is one more section of the existing scanned run**: a project key
  saved, changed and removed through the real server actions; the settings page rendered for owner, admin
  and editor; a check; a tick that generates on that credential; and a billing refusal whose provider
  error body embeds that key. `no-plaintext.test.ts` gains the stored key and its SHA-256 hex and dumps
  the new table before its all-tables scan.
- **L33 — Docs.** `docs/generator.md`'s env-only sentence is replaced in place, with a new "Per-project
  provider, model and key" subsection and a widened "Jobs" hold paragraph; `docs/decisions.md` gains this
  entry; `docs/security.md`'s four secret rows are updated and one row added, each naming tests that
  exist; `.env.example`'s generator block notes a project may store its own, adding no variable.

### What this entry does not do

- **Reporting spend, cost or token usage, per project or at all** — roadmap entry 3,
  `llm-cost-visibility`. This entry stores a key and resolves it; it persists nothing about what a call
  consumed.
- **Any provider beyond `openai` and `anthropic`** — closed by the roadmap; nothing here opens it.
- **Letting a non-admin see, change or check a key** — editors see no credential section at all.
- **Budgets, caps or throttling on spend** — outside the roadmap entirely.
- **Per-project timeouts or output-token limits** (K2), and **per-user credentials** — no roadmap entry
  owns either.
- **Changing entry 1's hold mechanics** — the probe interval, single-flight probing, "nothing failed
  while held", the absence of a give-up timeout and the absence of an operator control to lift a hold all
  stay exactly as entry 1 specified them; only the owner's identity widens.
- **Notifying anyone that a project's credential failed** — the notifications roadmap owns attention
  events.
- **Image generation credentials** — image generation is an extension point only on `main`.
- **Validating model ids against a provider catalogue**, and **retro-fitting anything onto generations
  already made** — neither is owned by any roadmap entry.

## 048 — A time booked across the whole week (2026-10-12)

- **`ON CONFLICT DO NOTHING`, not read-then-write.** `SlotsRepo.insertWeek` inserts the candidate weekdays in
  one statement and returns only the rows actually created. The service still reads the account's slots first
  to decide which days to attempt, but that read is an optimisation, not the correctness argument: two people
  booking the same time at once each get the days they won, and neither sees the `ConflictError` that
  `addSlot` raises. A read-then-write would have had to either hold a lock across the whole week or surface a
  conflict for a request whose entire point is "make sure this time is set".
- **`alreadySet` is derived from the rows that came back, not from the pre-read.** A day lost to a concurrent
  insert was absent from the pre-read's `taken` set but is set all the same, so the result reads the created
  weekdays and reports every other day as already set. Reporting from `taken` would have claimed a day was
  created when another caller created it.
- **Days that already have the time are reported, never refused.** A partly-booked time is the common case,
  and the user's intent is the end state. This is why the operation is also idempotent: a second call adds
  nothing and raises nothing.
- **A paused slot counts as present.** The time is taken either way, and resuming is a separate decision — so
  a week add never un-pauses or replaces an existing slot, and the existing row keeps its id.
- **No gutter of half-hour buttons.** The original request was a button per 30-minute window down the left of
  the grid. At the grid's `min-h-[30rem]` column height that is 48 rows of about 10px — below any usable hit
  size — so the feature ships as a time field plus a submit button above the columns instead. The requirement
  was one action for "09:30, every day", and this satisfies it without a second layout. A clickable row gutter
  remains possible later as a shortcut on top.
- **Only a bad value is a field error; a valid no-op is not.** `Field` sets `aria-invalid` from its `error`,
  so putting "every day already has that time" there would tell assistive technology that a perfectly good
  time is invalid. Worse, `Field`'s `aria-live` node does not re-announce an unchanged string, so pressing
  the button twice would say nothing the second time — which is exactly why `say()` launders messages
  through `announcedText`. So the split is: an empty time is the field's error ("Pick a time"), while a
  valid-but-no-op time and any server refusal go to the grid's own (non-live) error line *and* through
  `say()`. One announcement, re-announced on a repeat press, and `aria-invalid` only ever on a bad value.
  Announcements name the days rather than a count (`announceWeekAdded`).
- **`step` is an affordance, not validation.** `step={STEP_MINUTES * 60}` makes the time picker's arrows
  move in half hours, matching what a click on a column snaps to. The form is `noValidate` so a browser
  cannot refuse a typed off-grid time with a native bubble that bypasses the design system's error slot
  entirely — an exact typed time is allowed here exactly as the Move dialog allows one.
- **One `seq` for all seven optimistic additions.** `clearResolved` filters additions by sequence number, so
  sharing one across the week makes them clear together and makes a refusal roll the whole week back, rather
  than leaving part of a failed add on screen.
- **`onAddWeek` is optional.** A caller that passes no handler gets the one-at-a-time grid exactly as before
  and no week form renders, so `WeekSlotGrid` stays usable by anything without a bulk endpoint.

## 057 — An invitation link you can always copy (2026-10-13)

- **The delivery result always carries the URL — a deliberate amendment to research D6/D7.** D7 had
  `deliver()` return `{ kind: "in_app" }` with no URL when the invitee already had a Docket account, on
  the reasoning that they do not need a link: they see the invitation under Invitations. The consequence
  was that Regenerate produced nothing copyable for exactly the common case — a second invitation to
  someone who has signed up since — because `toDto` mapped the missing URL to `link: null` and the panel
  rendered nothing at all. `InvitationDeliveryResult` is now one shape (`kind`, `url`, `expiresAt`,
  `email`) and `kind` chooses only the wording. **D6 is untouched**: the token is still 32 random bytes
  whose `sha256` alone is stored, still single-use, still revoked on regenerate. The URL's lifetime is
  unchanged too — one server action's response, rendered once, never retrievable afterwards. What changed
  is only which of the two kinds gets handed that one-time value, and
  `tests/integration/invitation-accept.test.ts` asserts the hash-at-rest property for the in-app path
  that now returns a URL. Reverse by restoring the discriminated union; the panel would go back to
  rendering nothing for an invitee with an account.
- **`revokeInvitation` returns `ActionResult<null>`, not a link DTO.** It used to return a `DeliveryDto`
  with `link: null`, which is the only reason `link` was nullable in a type whose purpose is to carry a
  link. Revoking produces no link, so it now says so in its type and `DeliveryDto.link` is required.
- **Focus moves to the link panel when it appears.** The panel renders above the table, so a Regenerate
  from a row far down a long members page scrolled nothing and said nothing: the link could land
  off-screen. The region is `tabIndex={-1}` and focused on each new link, which scrolls it into view,
  makes it the next thing a screen reader reads and the next thing `Tab` continues from. `focus:` rather
  than `focus-visible:` for the ring, because a programmatic focus on a non-input element does not
  satisfy `:focus-visible` in most browsers, and a region that has silently taken focus needs to show it.
- **"Copy new link" awaits the action directly instead of dispatching it.** The button needs the URL in
  the same activation to hand it to `navigator.clipboard`, and `useActionState`'s dispatch only lands a
  result in state a render later — which is a second user gesture away, and by then the clipboard write
  is no longer inside the user activation that permitted it. So the row calls
  `regenerateInvitation(null, formData)` and awaits it, keeping its own `copying` flag for the pending
  label.
- **Regenerate stays beside it.** Three controls in one row cell is more than the design system likes,
  but Regenerate is the only path that works with client JavaScript unavailable, and it is the one that
  *shows* the link rather than putting it straight on the clipboard (for pasting into a password manager,
  or reading it out). "Copy new link" is the one-gesture shortcut on top, not a replacement. Reverse by
  dropping Regenerate — at the cost of the no-JavaScript path.
- **The clipboard write is attempted after the await, and that is what the fallback is for.** A
  `navigator.clipboard.writeText` needs transient user activation, and awaiting the server action first
  can spend it — Safari is the strict case. Deferring instead (`clipboard.write` with a `ClipboardItem`
  holding a promise) would keep the activation but is supported unevenly and costs a second code path
  for a case the fallback already handles well: the link appears in the panel, focused, ready to copy.
  Revisit if the fallback turns out to be the common path rather than the exception.
- **A clipboard failure is not a regenerate failure.** By the time `writeText` throws (an insecure
  origin, a denied permission, a browser without the API) the old link is already dead and a new one
  exists. Reporting an error would be wrong and would hide a working link, so the row falls back to the
  panel's existing `CopyField` — which now also takes focus — and says the link is ready to copy above.
- **The row's note is not a live region.** `say()` announces through the panel's single `LiveRegion`;
  an `aria-live` node in the cell as well would say everything twice. Same split as the week-slot grid
  in 048: visible text in the row, announcement through `say()`, which launders text through
  `announcedText` so copying twice in a row is announced twice.
- **The announcement names the consequence, not just the success.** "New invitation link for
  robin@example.test copied to the clipboard. The previous link has stopped working." Regenerating
  silently revokes whatever link was already sent, and someone who cannot see the row's note has no
  other way to learn that.

## 058 — LLM cost visibility (2026-10-13)

### Spec decisions (M1–M19 — this entry's; the M1–M18 under 056 are a different set)

- **M1 — One row per model call, not per generation.** A project-owned, call-level ledger, each row
  naming the generation it belongs to — post, series, job item — where one exists, and naming its
  purpose where one does not.
- **M2 — Every call that reached the provider is recorded, whatever its outcome.** The outcome (`ok`
  or the failure kind) is stored beside the counts, so the report can say how much went on calls that
  produced nothing.
- **M3 — Unknown counts stay unknown; null is never 0.** A call with no counts to report is counted
  as a call, excluded from token sums, and the exclusion is stated on the screen.
- **M4 — Each row records which credential it spent, and the provider and model as used at the
  time.** Model is stored as the literal string used, not a reference.
- **M5 — A call that was never made is not a row.** The ledger records calls to a provider, not
  intentions.
- **M6 — Bookkeeping never fails a generation.** A failure to write is logged and swallowed; the
  ledger can under-count but never over-counts, so the report is a floor on calls and tokens and the
  money figure (M12) is an upper bound.
- **M7 — No prompt, output, error text or credential ever enters the ledger.** A row holds ids,
  provider, model, source, purpose, outcome, two token counts, latency and a timestamp.
- **M8 — Rates are operator-supplied install configuration with no built-in defaults, and Docket
  never fetches them.** The install's own environment configuration, validated at startup and
  documented in `.env.example`.
- **M9 — A rate is keyed by provider and model, with separate input and output prices, expressed per
  million tokens, in one install-wide currency code.** Not per project; the trade-off is accepted and
  stated on the screen.
- **M10 — The estimate is computed when the screen is rendered, from the rates configured now.**
  Rates are not snapshotted per call; correcting a rate corrects every past estimate.
- **M11 — Zero is a legal rate and means zero**, distinct from "no rate configured" (M13).
- **M12 — The surface is called Usage, tokens are the headline, and the money figure is never called
  "spend", "cost", "charged" or "billed".** It is an estimated upper bound, carried by one fixed
  sentence wherever it appears.
- **M13 — An unpriced model shows no money at all — never zero, never a guess.** Its row shows calls
  and tokens with an explicit "no rate configured" marker; totals cover only priced models and say so.
- **M14 — With no rates configured at all, the money column is absent, not empty.**
- **M15 — Owner and admin only, gated on the existing `llm_credential: ["manage"]`; an editor sees no
  sub-nav item and the URL 404s** — absent, not disabled, following entry 2's precedent exactly.
- **M16 — It is a screen, and only a screen.** Nothing is added to the public API, no webhook event,
  no notification, no email, no activity-log entry, no export.
- **M17 — The screen answers for a period in the project's own time zone**, defaulting to the last 30
  days, with this month, last month and all time available, grouped by model with a breakdown by
  purpose.
- **M18 — A total you cannot trace is not trustworthy.** A generated post's generation detail gains
  its calls' token counts next to the latencies it already shows, and a batch job's page gains its
  own totals.
- **M19 — Rows live as long as their project and are never pruned by this entry.** They cascade with
  the project like every other project-owned table; no entry owns pruning or rollups.

### Plan decisions (P1–P19)

- **P1 — The ledger is written by a provider decorator, not derived from the `attempts` blob** —
  `attempts` has no per-call timestamp and carries a resumed step's earlier attempts forward.
- **P2 — `UsageRecorder.wrap(llm)` mirrors `withCreditHold(llm, owner)`**: wrap, observe, swallow,
  return unchanged. One reviewed idiom, not a second one.
- **P3 — The series plan call carries no series link**: `planSeries` runs before `startSeries` writes
  the row, and the person may never start it. **FR-003** allows it.
- **P4 — Rows are buffered and flushed once, when the link is known.** A dedup collision flushes with
  no post link.
- **P5 — `purpose` is an explicit argument, never parsed from `label`**, plus a source-scanning guard
  test.
- **P6 — Outcome is `ok boolean` + nullable `failure_kind llm_failure_kind` with `CHECK (ok =
  (failure_kind IS NULL))`.**
- **P7 — The ledger records the provider's outcome, not Docket's acceptance of it.** Stated in
  `docs/generator.md` so nobody reads `ok` as "this output was used".
- **P8 — Rate problems are non-fatal**: `ConfigValidation` gains `warnings`, logged by name and reason
  and never exiting.
- **P9 — The rate variables sit in a new `LLM_RATE_VARIABLES`, outside `LLM_VARIABLES`**, because
  `llmEnvIssues` would otherwise demand `LLM_PROVIDER`.
- **P10 — Format: `<provider>:<model>=<input>/<output>`, whitespace- or comma-separated.**
- **P11 — The currency is validated by shape (three ASCII letters), never against a remembered code
  list**, and `Intl.NumberFormat`'s `style: "currency"` is not used.
- **P12 — Money arithmetic is exact integer `BigInt` micro-units.** A non-zero amount rounding to
  `0.00` renders "under 0.01", so a configured zero stays distinct.
- **P13 — A dedicated `usagePeriodWindow` with explicit `disambiguation: "compatible"`**, not
  Activity's `windowFor`.
- **P14 — Two accessors, like `project_llm_settings`**: `scope.llmUsage` and `llmUsageRepoFor(projectId)`
  for `runLlmCheck`, which has a project id and no scope.
- **P15 — `(project_id, called_at DESC)` plus a partial `(project_id, generation_job_id)`. No rollup
  table and no unique index** — a duplicate-suppressing key would turn a swallowed retry into an
  over-count.
- **P16 — `generation_job_id` is stored beside `generation_job_item_id`**, so **FR-028** is one
  indexed aggregate instead of a join.
- **P17 — The secret scan extends the existing scanned run** — it does not add a second one.
- **P18 — FR-029 reads the existing `attempts` blob, not the ledger.** It already carries `usage` per
  attempt, it is already loaded with the post, and it covers posts generated before this entry
  shipped — so the post generation detail needs no query, no migration and no backfill.
- **P19 — Money appears only on the Usage surface.** The job page and the post generation detail show
  calls and tokens alone, keeping money behind the owner/admin gate so **SC-003** holds by
  construction on both pages.

## 059 — A project's tagline, description and website (2026-10-13)

Spec B1-B14, plan P1-P28 (`specs/069-brand-profile-fields/{spec,research}.md`).

- **Three nullable `text` columns on `projects`, not a side table, and no length CHECK.** There is
  exactly one brand per project and the fields are not versioned — a tagline is a current fact about the
  product, not an authored instrument like the voice whose version a post needs to remember. Length and
  shape are Zod rules at the boundary, exactly as `name` (80) and `slug` (48) already are on this table,
  so an over-length save is a field error, not a database error. Reverse either decision by moving the
  three columns into a project-owned, versioned table, at the cost of a join, a second history UI and a
  second thing for `setup-write-api` to publish.
- **Empty is `NULL`, never `''`, and a missing key means "no change" where a present-but-empty key means
  "clear".** One empty state, not two, for the prompt, the form and the audit log to agree on. The
  settings form always submits all three fields, so an emptied input clears; a caller that omits a brand
  key — an older client, or a future API operation — leaves the stored value alone instead of silently
  wiping a description.
- **The website shares `preferredLinks`' URL rule, verbatim, via a new `src/lib/validation/link.ts`.**
  The roadmap asked for `websiteUrl` "validated like `preferredLinks`"; sharing one implementation is the
  only way that claim stays true as both evolve. The value is stored as typed beyond trimming — no host
  lower-casing, no scheme coercion, no `www` stripping — because it is shown back to the person who typed
  it and handed to a model to put in a post. The tagline collapses any CR/LF to a single space before its
  200-character limit is counted, so the labelled prompt line and the settings input cannot disagree
  about what "one line" means; the description keeps its paragraph breaks, because they reach the prompt.
- **The project's column list is unified before this entry uses it.** `projectColumns` existed twice —
  `scope.ts` and a duplicate inline copy inside `api-keys.ts`'s `findActiveKeyByHash` — and a field added
  to only one is invisible on API-key-authenticated generation while invisible in tests that use member
  scopes. Both readers now import `src/server/dal/project-columns.ts`, fixed in passing because the
  alternative was testing around a bug rather than removing it.
- **One audit row per field that actually changed, action `project_brand_update`, `details: { field,
  previous, next }`.** Three edited fields in one save write three rows; an unchanged field writes none.
  One new enum value rather than three, because three per-field actions would mean an enum migration and
  a near-identical activity-list sentence every time a brand field is added. `previous` is read inside
  the same locked transaction as the write (`scope.transaction(…, { lockProject: true })`, then
  `tx.projects.get()`), the same shape `setPostingInstructions` already uses, so two concurrent saves
  record a truthful chain rather than both claiming the same stale `previous`.
- **`BRAND` precedes `VOICE` in the composed prompt, and is omitted whole when every field is empty.**
  What the product *is* is a fact the voice then describes, so the model reads it first; a prompt with no
  brand fields set stays byte-identical to what it was before this entry, which is exactly what
  `prompt.golden.test.ts` asserts. `brandOf(project)` is the one derivation, called from the two places a
  real `PromptInput` is built (`core.ts`'s `base`, `series.ts`'s `base`), so every entry point — single,
  series, regenerate, "Try it", the job runner, the public API's generate operation — inherits it and
  none can forget to pass it. The brand is read live at generation time, not snapshotted like posting
  instructions or pinned like a voice version: a tagline is a current fact, so a long-running job picking
  up a corrected one mid-run is the right answer, and there is no column to hold a snapshot in.
- **Brand context is stated as fact, not wrapped as source material.** Only an owner or admin can write
  it — the same trust level as posting instructions — so it is not neutralised and not put inside
  `<source_material>`; like posting instructions, it is told it never overrides the output rules or the
  platform rules (a bullet between the alt-text rule and the posting-instructions rule says so, present
  only when the section is). The brand's website is offered as the link to use when a post needs one;
  `preferredLinks` stays in `VOICE`, unchanged — a campaign link is this month's thing to promote, the
  brand's website is what the project *is*.

## 060 — Generated images in the media library (2026-10-13)

Spec: `specs/070-image-generation`. Roadmap entry 2 of 6
(`.specify/roadmaps/content-engine-roadmap.json`, slug `image-generation`): implements the
`ImageGenerator` extension point `src/server/llm/image-generation.ts` has declared since the
generation entries landed. Full text in `specs/070-image-generation/spec.md` (G1–G26) and
`specs/070-image-generation/plan.md`/`research.md` (P1–P24).

### Spec decisions (G1–G26)

- **G1 — The image provider is configured separately from the text provider**, `LLM_IMAGE_PROVIDER`
  and `LLM_IMAGE_MODEL`, so an install writing posts with Anthropic (no image API) can still generate
  images, and the two choices stay independent as the roadmap wants.
- **G2 — `LLM_IMAGE_MODEL` is required once `LLM_IMAGE_PROVIDER` is set, with no default and no model
  id literal anywhere** — `LLM_MODEL`'s existing rule, extended.
- **G3 — The image call spends the provider's existing key variable (`OPENAI_API_KEY`)**, read only
  in `config.ts`; no second key variable to rotate or to teach the key-read guard.
- **G4 — Image generation keeps its own `ImageGenerator` interface** rather than widening
  `LlmProvider`, because the two share nothing but the failure vocabulary.
- **G5 — The adapter alone owns the provider vocabulary**; pixel sizes, output formats and error
  codes never appear above it. A second adapter is a new file plus one `LLM_IMAGE_PROVIDER` value.
- **G6 — The OpenAI adapter targets the GPT image model family only**: explicit `output_format`,
  reads `b64_json`. A configured `dall-e-*` model surfaces as `bad_request`.
- **G7 — PNG, one image, provider-default moderation, no streaming.** PNG survives the library's own
  re-encode and metadata strip; `n = 1` matches the contract's single `mediaAssetId`.
- **G8 — The prompt is 1 to 1000 characters after trimming**, the lowest ceiling the installed SDK
  documents, refused locally before any call is made.
- **G9 — An image call spends the project's own credential only when that credential's provider *is*
  the configured image provider**, the install's otherwise; the credit-hold owner matches whichever
  credential actually ran, so one refusal pauses both paths for that account.
- **G10 — The billing-refusal rule lives in one function, shared with `withCreditHold`**, not copied,
  so the probe interval, swallow rule and `heldSince` semantics cannot drift between text and images.
- **G11 — The image path does not check for an existing hold before calling** — every in-request path
  on `main` behaves this way; only the batch-job claim consults `gateCreditHolds`.
- **G12 — Image calls are recorded in the usage ledger under a new purpose, `image.generate`**, with
  token counts written when the provider reports them and null otherwise, never coerced to zero.
- **G13 — The failure *kinds* are reused verbatim; only the user-facing sentences differ**, via a
  parallel fixed-sentence map, because the text sentences describe the wrong thing for an image call.
- **G14 — No images of real people, enforced by one fixed, appended instruction**, never by name
  detection or heuristic refusal — a filter that is sometimes wrong is worse than an instruction the
  provider is good at following.
- **G15 — The prompt is the person's words plus the guardrail, and nothing else** — no brand context,
  voice profile or post text folded in; an image prompt is not a post prompt.
- **G16 — The generated bytes go through the existing `prepareUpload`/`commitUpload` path**, not a
  new writer, so every existing library constraint (type, size, megapixels, metadata, thumbnail)
  applies unchanged.
- **G17 — Provenance is four named, nullable columns on `media_assets`, all-or-nothing** —
  `generated_at`, `generation_prompt`, `generation_provider`, `generation_model` — never a `jsonb`
  blob and never a side table.
- **G18 — `original_filename` gets a fixed, human-readable name**, not the prompt and not null, so
  every screen that labels an asset by filename still has one to show.
- **G19 — Alt text starts empty and is never derived from the prompt** — a prompt is an instruction
  to a model, not a description a screen reader should hear.
- **G20 — No automatic tag.** Tags are the person's own filing system; provenance already has its own
  columns and its own card marker.
- **G21 — A generated asset is otherwise completely ordinary** — listed, searched, filtered,
  selected, edited, attached, reserved, variant-derived, fit-checked and deleted by exactly the code
  that handles an uploaded one.
- **G22 — A new owner/admin statement, `media: ["generate"]`.** Neither existing candidate fits:
  editors already hold `media: ["edit"]` and `generation: ["run"]`, and reusing either would hand them
  the project's image budget.
- **G23 — Absent, not disabled, for anyone who may not use it** — 065's precedent for the Model page,
  applied here; the server refuses regardless of what the UI showed.
- **G24 — In-request, single attempt, no job and no automatic retry** — a retry on a paid,
  non-idempotent call risks buying the same graphic three times.
- **G25 — No cooldown, no quota and no per-project lease** beyond disabling the button mid-flight;
  every attempt is visible in the Usage figures (G12).
- **G26 — The storage-not-configured sentence comes from one shared constant**, exported once and
  used by both the upload and the generate paths.

### Plan decisions (P1–P24)

- **P1 — A third environment group, `LLM_IMAGE_VARIABLES`, outside `LLM_VARIABLES`**, with its own
  `llmImageEnvIssues` (068 P9's precedent), so an image-only install is not told to set `LLM_PROVIDER`.
- **P2 — A partially configured image group is a startup issue, not a warning** — a half-set provider
  is a typo, not a guess (G1).
- **P3 — Image resolution lives inside `resolve.ts`**, so `key-reads.test.ts`'s existing three-file
  guard stays green unchanged.
- **P4 — A project's own credential supplies the key only; the model is always `LLM_IMAGE_MODEL`** —
  a project's stored *text* model sent to an images endpoint is a guaranteed `bad_request`.
- **P5 — The image client runs with `maxRetries: 0`**, because a paid, non-idempotent call must not
  be retried by the SDK (G24).
- **P6 — The adapter reuses the exported `kindOfError`**, adding empty `OPENAI_IMAGE_REFUSAL_TYPES` /
  `_CODES` sets as parameters, because the installed SDK names no refusal marker for this endpoint.
- **P7 — `ImageProviderRequest` carries a `label` and the adapter calls `logLlmCall`**, so the
  usage-purpose guard can see `image.generate` like every other provider call.
- **P8 — The hold decision is extracted once as `applyCreditOutcome(owner, kind)`**; `withCreditHold`
  and `withImageCreditHold` are thin wrappers, and `UsageRecorder` gains `wrapImage` sharing one
  buffer and one flush.
- **P9 — The adapter's aspect table is the only place pixels exist**; an explicit `size` passes
  through after a positive-integer check only, leaving the provider as the arbiter (G2/G6).
- **P10 — `n: 1`, `output_format: "png"`, and nothing else** — no `moderation`, `quality`,
  `background`, `stream`, `response_format`, `user` or token cap.
- **P11 — The bytes go through `uploadMedia`**, extended with an optional `generation` meta, because
  it already gets discard-on-failure right.
- **P12 — `generation_provider` gets a length CHECK, never a value list** — a value list would force
  a migration on every new adapter, which SC-007 forbids.
- **P13 — `MEDIA_STORAGE_NOT_SET_UP` moves to `src/server/storage/index.ts`**; `images.ts` imports it,
  with a test that the two callers are identical (G26).
- **P14 — One migration file for both changes**, the enum value added but not used in the same
  transaction, as earlier migrations already do.
- **P15 — `createImageGenerator(scope)` binds the declared contract to a scope** and refuses a
  request naming another project, keeping the declared signature intact (constitution III).
- **P16 — `image-generation.ts` gains only the contract's vocabulary** (`IMAGE_ASPECTS`,
  `IMAGE_PROMPT_MAX`, `NO_REAL_PEOPLE`), never the implementation.
- **P17 — Authorization throws `ForbiddenError`; every other refusal is returned** — the contract's
  `message` is for refusals a person can act on.
- **P18 — No `AbortSignal` is passed from the action**, and a caller-supplied signal reaches the
  provider call only, never storage or the database, so "both or neither" holds by construction.
- **P19 — `media: ["generate"]` on `statements`, owner and admin only**, with an exhaustive access
  matrix test (G22).
- **P20 — The page's gate is a new `imageGenerationEnabled(scope)` read**, not a widened
  `MediaStatus`, because the Jobs page and the Overview service read `mediaStatus` with no interest
  in image configuration.
- **P21 — The trigger renders in both storage-on branches of the Media page**, including the
  empty-library branch, which is exactly the state a first generated image should be able to leave.
- **P22 — Provenance renders as a `Badge` plus a native `<details>` disclosure** — keyboard-operable
  with no JavaScript, and a 1000-character prompt need not fit a tile.
- **P23 — The aspect control is a three-option `ChoiceField`**, rendering a `SegmentedControl`, per
  the `docket-ui` rule against a native `<select>` for one-of-many.
- **P24 — The secret scan and the env-coverage probe are extended, never exempted** (068 P17's
  precedent); `docs/security.md` gains two rows, naming the tests that exist.

### What this entry does not do

- **A person choosing among several generated images.** `n = 1`; a chooser is a different, bigger
  feature (G7).
- **Image-to-image, inpainting or editing an existing asset.** The contract takes a prompt only.
- **Any provider beyond `openai`.** G6 leaves a second adapter as a new file plus one configuration
  value, not something this entry builds.
- **Composing a prompt from brand context, voice or post text.** G15 keeps the prompt to the person's
  words plus the guardrail; `evergreen-series` composing its own prompt through this same contract is
  a later roadmap entry.
- **A job, a batch mode or any automatic retry on a failed call.** G24; this is explicitly an
  in-request, single-attempt action.
- **A cooldown, quota or per-project generation limit.** G25; visibility in the Usage figures is the
  chosen control.

## 061 — Standing content series (2026-10-14)

Spec: `specs/071-evergreen-series`. Roadmap entry 3 of 6
(`.specify/roadmaps/content-engine-roadmap.json`, slug `evergreen-series`): a recurring series that
keeps producing posts on a cadence until someone stops it, built on the existing generation, policy,
allocator and worker-tick machinery. Full text in `specs/071-evergreen-series/spec.md` (W1–W34) and
`specs/071-evergreen-series/plan.md`/`research.md` (S1–S40).

### Spec decisions (W1–W34)

- **W1 — "Standing series", a new word.** The in-request, 2–10-angle generation path keeps the bare
  word *Series*; the new recurring object is a **standing series** everywhere, and the new Batch jobs
  section is titled **Standing series**.
- **W2 — A standing series is configuration, not a work list.** It holds what to generate and how
  often; each firing opens a **run**, which carries positions, counts, outcomes and failures — so
  `dated-series` can add a second way to decide when a run opens without touching anything else.
- **W3 — The stored shape deliberately mirrors a batch job**: project, name, voice profile, the
  `template`/`templateFields` pair, target account ids, resolved approval/scheduling policy, an
  enabled flag, `lastRunAt`/`nextRunAt`.
- **W4 — No per-run data fields in this entry.** `templateFields` is always empty, so the template may
  carry no placeholders; `dated-series` can feed per-occurrence fields in later with no second
  migration.
- **W5 — A series also stores a brief**, bounded like the existing one, because the planning call
  needs to know what the series is about, not just how to write it.
- **W6 — A name is required and unique within a project**, 1–100 characters, trimmed,
  case-insensitively unique.
- **W7 — A cadence is a count and a period: N posts per day, week or month.** Nothing finer than a day
  (a rate-limit problem) and nothing coarser than a month (better expressed as a dated series).
- **W8 — N is 1 to 10 per period**, matching the existing in-request series maximum.
- **W9 — Period boundaries are the project's local day, week (Monday) or month (the 1st)**, resolved
  through Temporal with explicit disambiguation; a series created mid-period is first due at the next
  boundary.
- **W10 — At most one run per period, and no backfill.** A worker outage across several boundaries is
  recorded as missed periods and the series jumps to the current one, rather than dumping a backlog.
- **W11 — A new period closes a still-open run**, with its counts recorded as incomplete, so a slow or
  unsatisfiable series cannot accumulate open runs forever.
- **W12 — Pausing stops new runs and stops the open run producing more; resuming sets `nextRunAt` to
  the next boundary**, never a missed one.
- **W13 — Deleting a series keeps its posts.** Deletion removes the series and its run history only,
  is immediate and final, and needs the same permission as creating one.
- **W14 — A run of two or more posts plans its angles first, through the existing planning call; a
  run of exactly one post skips planning**, because the planner refuses a count below two.
- **W15 — The plan is stored on the run before any post is written**, so a restart finishes the plan
  it already committed to rather than re-planning.
- **W16 — The plan is told which angles the series has already used**, via the existing avoid-titles
  prompt mechanism, so a weekly series does not repeat itself; golden prompt tests are updated.
- **W17 — Each post of a run goes through the existing generation path unchanged** — same prompt
  composition, brand context, voice ordering, schema, correction retry, failure vocabulary, usage
  ledger and credit-hold wrapper.
- **W18 — The voice profile's current version is taken at run time**, recorded on the post, as every
  generated post already does.
- **W19 — A position is produced at most once**, enforced by a uniqueness constraint; a writer that
  loses the race re-reads and reports the winner.
- **W20 — A temporary failure retries on a later tick; a lasting one is recorded as a failure for that
  position and the run moves on.** The run closes when every position has a post, a failure or a skip.
- **W21 — Policies are authorised once, at creation or edit, and stored on the series** — the only
  honest option, since the authorising member may not be a member by the time the series fires.
- **W22 — The one policy function decides every post, with no bypass.** A validation failure forces
  review even under auto-approve — intended behaviour, not a defect.
- **W23 — Queued posts take real slots through the existing allocator, inside the policy transaction**,
  so two series or two workers cannot land on one occurrence; a post with no free occurrence stays a
  draft with that reason recorded.
- **W24 — A series never schedules at an explicit time.** It leaves posts as drafts or queues them;
  picking times is what slots are for.
- **W25 — A series declares one media source: none, a pool, or generate.**
- **W26 — A pooled image is reserved like a batch job's image** — one unused image per post, reserved
  inside the write, videos never eligible.
- **W27 — A generated image uses a prompt stored on the series**, sent with the fixed real-people
  instruction and nothing else — no post text, no brand fields, no voice profile.
- **W28 — A post whose media requirement cannot be satisfied is skipped whole, with the reason
  recorded**, naming the account whose requirement failed, rather than dropping one target.
- **W29 — A skip is not a failure.** It is a neutral, recorded outcome and does not count an attempt or
  mark a run "completed with failures".
- **W30 — A new bounded section of the existing tick, not a new process** — claimed, leased,
  skip-locked, kill-safe and deadline-aware exactly like the batch section.
- **W31 — Its per-tick budget is its own and additive**, documented so an install knows enabling
  standing series raises its total concurrent model calls.
- **W32 — Claims rotate, oldest-due first**, so one busy series or project cannot starve another.
- **W33 — A credit hold pauses a series cleanly, with no state to clear.** A held owner's series is not
  claimed at all; a mid-run billing refusal requeues the position with no attempt counted.
- **W34 — A series that produces nothing three runs in a row pauses itself, with the reason**, undone
  by the same Resume control a person's pause is.

### Plan decisions (S1–S40)

- **S1 — Three tables**: `standing_series`, `standing_series_runs`, `standing_series_positions` — a
  position is a row because every idempotency guarantee is a per-slot statement.
- **S2 — The run carries a configuration snapshot (`config jsonb`) written at open**; the producer
  reads the run, never the series, which is the whole of FR-056.
- **S3 — Run counts are derived from positions; only `outcome` is stored, once, at close** — the
  `refreshJobStatus` rule, which keeps counters from double-counting under retries.
- **S4 — A period is `(period, local date)` with `unique(series_id, period, period_start)`.**
- **S5 — The cadence engine is a pure module**, `src/lib/series/cadence.ts`, following
  `src/lib/email/schedule.ts`.
- **S6 — The claim unit is the series, leased on the series row.** One holder makes "one open run"
  true by construction.
- **S7 — Claim predicate**: `enabled AND lease free AND (next_run_at <= now OR EXISTS (an open run
  with work due))` — `next_run_at` advances when a run opens.
- **S8 — Positions are created when the run opens; the plan is written with `UPDATE … WHERE plan IS
  NULL`**, so "a restart must not re-plan" is a database fact.
- **S9 — Plan retry bookkeeping is two run columns**, `plan_attempt_count` and
  `plan_next_attempt_at`; the kind and message live in `generation_failures`.
- **S10 — `posts` gains one nullable column, `standing_series_position_id`**, FK `ON DELETE SET NULL`,
  with a partial unique index.
- **S11 — `GeneratedPostLink` gains `{ standingSeriesPositionId }`; `GenerationRecord.mode` gains
  `standing_series_post`.**
- **S12 — `generation_failures` gains `standing_series_run_id` + `standing_series_position`** (nullable,
  so a plan failure belongs to the run); `generation_mode` gains two values.
- **S13 — Two new `llm_usage_purpose` values and no new column on `llm_call_usage`.**
- **S14 — Media is resolved per position, before the model call, and written onto the position**, so a
  restart reuses the image instead of generating a second one.
- **S15 — The pool reservation is a partial unique index on positions; `src/server/dal/media.ts`'s
  reservation predicate is widened to count both tables.**
- **S16 — The pool claim is `SELECT … FOR UPDATE SKIP LOCKED LIMIT 1`** over unused, unreserved,
  tag-matching live images, oldest first.
- **S17 — The `generate` source calls `createImageGenerator(scope)` with the series' stored prompt and
  nothing else.**
- **S18 — A position's `last_error_kind` reuses the existing `generation_job_item_error` enum.**
- **S19 — A new `standing_series_skip_reason` enum of six values plus `skip_account_id`.**
- **S20 — The run carries `outcome` (four values) and `blocked_reason` (two).** Voice profiles are
  archived, never deleted, so the spec's "deleted voice profile" edge case is the archived case.
- **S21 — The run records `dropped_account_ids uuid[]`.**
- **S22 — A seventh section, `src/server/scheduler/standing-series.ts`, inside the existing `runTick()`**
  — the existing `section()` wrapper gives FR-047's isolation for free.
- **S23 — Two environment variables for the section's own claim limits**; the physical per-call
  constants are shared.
- **S24 — Series are processed concurrently, positions within a run sequentially.**
- **S25 — One new statement, `standing_series: ["manage"]`, for owner and admin, with no `KEY_GRANTS`
  entry** — no public API surface is structural.
- **S26 — Viewing the list and run history is gated by `post: ["view"]`**, as the Jobs page already is.
- **S27 — FR-008's log is the audit log**: five new `membership_action` values; `activity_events` is
  publish-and-connect outcomes only.
- **S28 — No posting-instructions snapshot**: a manual Generate reads them live, so FR-019 requires
  the prompt to compose exactly as a manual Generate's does.
- **S29 — `template_fields` emptiness is enforced in Zod, not by a CHECK.**
- **S30 — Avoid-titles: the 3 most recent closed runs, capped at 20 titles, both named constants.**
- **S31 — `buildSeriesPlanPrompt` gains `avoidTitles` and emits nothing when empty**, so today's
  committed golden snapshots stay byte-identical.
- **S32 — The producer re-reads `enabled` before each position** — the only safe point FR-054's "next
  safe point" can mean.
- **S33 — A position left `running` is reset by the next claim**, counting an attempt unless the claim
  is a credit probe; at the cap it fails as `interrupted`.
- **S34 — A position that already has a post but no applied policy is a finish position**: variants
  and policy, no model call — the batch runner's already-reviewed recovery, reused.
- **S35 — Self-pause reads the three most recent closed runs' stored `outcome`, at close, in one
  indexed query.**
- **S36 — `withinBudget`/`Overran`/the redacted log line move to `src/server/scheduler/budget.ts`**;
  `jobs/runner.ts` imports them — a pure move, proved by its existing tests staying green.
- **S37 — `resolveBlockedProjectIds` is generalised to take candidate project ids.**
- **S38 — A Standing series section on `/jobs`, plus `/jobs/series/new`, `/jobs/series/[seriesId]` and
  `…/edit`.**
- **S39 — Housekeeping prunes closed runs older than 90 days, 200 per tick; positions and failures
  cascade; an open run is never pruned.**
- **S40 — No webhook, no notification, no email, no API, no real-time push.**

### What this entry does not do

- **No date-pegged occurrences.** Anniversaries, a spreadsheet occurrence, lead time, leap days and
  missed-window handling belong to `dated-series`, which adds a second way to decide when a run opens
  on this engine.
- **No change to one-off Generate, the in-request series, or finite batch jobs**, beyond refactoring
  shared code with no behaviour change.
- **No public API, MCP or webhook surface** for standing series.
- **No notifications or email** about a series' runs, skips or failures beyond what a post already
  produces and what the Batch jobs screens show.
- **No explicit-time scheduling**, no per-post overrides, no editing a run's plan, and no re-running a
  closed run.
- **No backfill** of periods missed while the worker was down.
- **No cross-period deduplication of post text**; angle titles of recent runs are avoided, but Docket
  does not compare produced copy.
- **No video**: a pooled asset is an image, and no video is generated or attached.
- **No per-series provider, model, credential, rate limit or spend cap.**

## 062 — Date-pegged series (2026-10-14)

Spec: `specs/072-dated-series`. Roadmap entry 4 of 6
(`.specify/roadmaps/content-engine-roadmap.json`, slug `dated-series`): content that fires on an
anniversary — a birthday, a grand opening — from a spreadsheet, as a second occurrence rule on the
standing series built in entry 061. Full text in `specs/072-dated-series/spec.md` (A1–A38) and
`specs/072-dated-series/plan.md`/`research.md` (B1–B34).

### Spec decisions (A1–A38)

- **A1 — A dated series is a standing series with a different occurrence rule, not a new object.**
  Name, brief, template, voice profile, target accounts, policies, media source, enabled flag, runs,
  positions, failures, self-pause, the credit hold and the per-tick bounds all behave exactly as they
  do today. The product word is **Dated list**; such a series is a **dated series** in prose.
- **A2 — The occurrence rule is chosen at creation and refused on edit.** Converting one rule to the
  other would have to decide what happens to an open run and a half-fired list; the edit screen says
  to create another series instead.
- **A3 — A dated series has no cadence.** Count and period are not asked for, not stored, refused if
  submitted.
- **A4 — A dated series uses the same worker section, claim, lease and per-tick limits as cadence.**
  No new process, no new environment variable, no second code path for generation, policy, allocation,
  media or failure handling.
- **A5 — A row is a date, the template's field values, and an optional media reference.** No per-row
  accounts, voice profile, policy, lead time or prompt — a row that overrode those would be a second
  series in disguise.
- **A6 — A date is a month and day, optionally preceded by a year.** Without a year it fires every
  year, forever; with one, once, then history.
- **A7 — The list's columns are the series' template fields** — what `templateFields` was kept for
  (W3/W4); instructions use `{{ column name }}`, rendered through the existing template renderer.
- **A8 — Two reserved column names, `date` and `media`; every other column is a template field.**
  `date` required, `media` optional, both matched case-insensitively.
- **A9 — One date format: `MM-DD`, or `YYYY-MM-DD` for a row that names its year.** Zero-padded,
  hyphens only; several accepted formats would mean guessing whether `03-04` is March 4th or April 3rd.
- **A10 — A row's identity is its date plus the key column's value** (the first non-reserved column,
  trimmed, case-insensitive). Re-import matches on it, a list may not hold the same date and key
  twice, and two subjects on one date are plainly two rows.
- **A11 — At most 10 rows resolve to one calendar date**, counted across every-year and year-specific
  rows together — the same cap a run's positions already have.
- **A12 — 500 rows per series, 1 MB per file, 50,000 characters per row** — the jobs CSV limits
  exactly, nothing raised or lowered.
- **A13 — A row's media reference names an image already in the library, by filename**, exactly one
  live, non-video asset, case-insensitive. Nothing uploaded, nothing fetched from a URL.
- **A14 — A row's image is used, not consumed.** Not reserved, not marked used — the same portrait
  posts on the same birthday every year; two rows may share one file.
- **A15 — A row's media reference wins over the series' media source for that row**, which is the
  fallback for rows naming none. The media-required skip is unchanged.
- **A16 — Row field values are never sent to an image provider.** `generate` still sends only the
  series' stored prompt plus the fixed real-people instruction, so a dated series about a person is
  text and typography over a pooled or named image — `docs/generator.md` says `generate` is the wrong
  source for a birthday list.
- **A17 — One parser, extended with a mode — not a second parser.** Whole-file problems still refuse
  the import whole; the jobs source keeps today's all-or-nothing behaviour byte for byte, proved by
  its existing tests staying green unchanged.
- **A18 — A row-level problem skips that row, names its line and says what is wrong**, and the import
  succeeds with whatever was usable.
- **A19 — An import replaces the whole list.** Matched rows (A10) are updated in place and keep their
  fire history; unmatched stored rows are removed with their history; new rows are added. Nothing an
  import does touches a post already produced.
- **A20 — The last import's problems are kept on the series, up to 100, with the file's name and
  when it ran**, replaced by the next successful import.
- **A21 — An unknown template placeholder is refused on save; an import that would remove a column
  the template uses is refused whole.** The alternative — a silently empty value for the next year — is
  the failure nobody notices.
- **A22 — Rows are editable one at a time: add, edit, delete**, the same validation and messages as an
  import; deleting a row deletes its fire history and leaves its posts.
- **A23 — An occurrence is a row and a year**; its target date is the row's month/day in that year, as
  a local date in the project's zone.
- **A24 — 29 February in a non-leap year fires on 28 February.** Skipping would make a brand's
  anniversary vanish three years out of four; moving to 1 March puts it in the wrong month.
- **A25 — A series-level lead time of 0–30 days, default 0.** The due instant is local midnight at
  (target − lead days), through `periodStartInstant`'s existing disambiguation.
- **A26 — The window closes at the end of the target date's local day.** Late is fine until the day is
  over; a worker down across the date and a series paused across it behave identically, and neither
  backfills.
- **A27 — Missed occurrences are recorded lazily and boundedly**: windows closed in the last 30 days,
  at most 50 per pass, so a series off for a year does not write 365 history rows.
- **A28 — One run per due date, one position per row due on it, oldest date first** — the existing
  one-open-run rule, unchanged; rows whose window closes while waiting are missed, visibly.
- **A29 — A dated run never calls the angle planner.** Each position already has the row's own data,
  which is what makes it distinct.
- **A30 — A queued post is allocated from the start of its target date, not from now**, or lead time
  would defeat itself. No free occurrence inside the horizon leaves it an approved draft, as W23
  already specifies.
- **A31 — A row fires at most once per year, under a uniqueness constraint on the occurrence** —
  cadence's guarantee, restated for dates, enforced in the database.
- **A32 — Due resolution reads the project's time zone every time.** A zone change moves every
  unfired occurrence; an already-missed one stays missed.
- **A33 — A dated series with no usable rows simply has no next due date.** Not an error, and the
  self-pause rule never fires on an empty list.
- **A34 — Pause and resume are unchanged (W12).** Resuming does not backfill; windows that closed
  while paused are recorded missed on resume.
- **A35 — The dated list lives on the existing series detail screen**: Upcoming, Last import, the
  rows table (paginated, add/edit/delete), and Import, in that order. The run history is unchanged
  beyond naming the date a run fired for.
- **A36 — Importing, adding, editing and deleting rows needs `standing_series: ["manage"]`** — owner
  and admin, enforced on the server for every route; viewing needs `post: ["view"]`, as the rest of
  the screen already does.
- **A37 — The list is shown as a plain table of the file's own columns**, following `docket-ui` and
  `docs/design-system.md`.
- **A38 — No API, webhook, notification, real-time push or external date source.**

### Plan decisions (B1–B34)

- **B1 — One parser, one pass, two views.** `parseCsvFile(bytes)` returns tagged problems
  (`scope: "file" | "row"`) in today's push order; `parseJobCsv` becomes a four-line wrapper, so
  `csv.test.ts` passes unchanged — proving FR-020 rather than asserting it.
- **B2 — The dated importer consumes the tagged result directly.** File-scope problems refuse the
  import whole; row-scope problems carry through to the import record.
- **B3 — Over-length rendered instructions are a row problem**, reusing `assertRenderedFits`'s
  message shape, checked on import, row add, row edit and a template edit.
- **B4 — Eligibility is decided on local dates, and the local-date form is normative**: `target − lead
  ≤ today ≤ target`, identical to `dueInstant ≤ now < windowEnd` by construction. The date form
  survives a time-zone change with nothing stored to migrate.
- **B5 — `standing_series.next_run_at` becomes nullable and is always NULL for a dated series.** A
  cached due instant is the one thing a zone change could falsify; the next due date is computed from
  the rows at read time, in the zone read at that moment.
- **B6 — Each row stores `next_target_date date`**, zero-independent, forward-only, advanced in the
  same transaction that fires or retires the occurrence.
- **B7 — The due instant and window end reuse `periodStartInstant`.** No new local-midnight resolver.
- **B8 — The claim gains one OR branch, joined to `projects` for the zone.**
- **B9 — A dated run never plans, gated on the run config's `rule`, not on `requested_count`.** A
  CHECK makes a dated plan impossible to store; `seriesField` stays `null` for a dated position.
- **B10 — The row's values are rendered into `inputs.instructions` at the single existing call
  site.** Same data marks, same `runGenerationStep`, same schema, same retry, same usage purpose, same
  `generation_mode` — no new enum value anywhere.
- **B11 — The per-position dated payload is one `dated jsonb` column**, NULL for a cadence position:
  `{ rowId, year, targetDate, keyValue, values, mediaAssetId, mediaFilename }`. The row's asset id
  lives inside jsonb where the reservation index cannot see it, which is how A14 becomes structural.
- **B12 — `resolvePositionMedia` gains a prefix, not a branch.** A named asset is loaded through the
  scoped media repo, validated the same way, returned without `claimMedia` and without `markUsed`.
- **B13 — The queue floor is stored on the post: `posts.queue_not_before timestamptz` (nullable).**
  One helper, `queueFloor`, read by all three `allocateNextFree` floor call sites. Explicit scheduling
  is a deliberate human act and is not floored.
- **B14 — Two new tables, not three.** `standing_series_dated_rows` and `standing_series_occurrences`;
  the import record is four columns on `standing_series`, not a fifth table.
- **B15 — `standing_series_period` gains the value `'date'`.** Reuses `unique(series_id, period,
  period_start)` as "one run per due date" and the existing one-open-run index unchanged.
- **B16 — `standing_series_position_status` gains the value `'missed'`** — neither a failure nor a
  skip, keeping the skip-reason enum free of a non-skip.
- **B17 — An occurrence is inserted when the run opens, under `unique(row_id, year)`.** That
  constraint, not a prior read, is what makes two overlapping ticks collide safely.
- **B18 — The row's identity is a unique index over `(series_id, month, day, coalesce(year, 0),
  lower(btrim(key_value)))`.**
- **B19 — The stored month/day must be a date that can exist in some year**, by CHECK — `02-30`,
  `13-01` and `2027-02-29` are impossible to store even by a direct write.
- **B20 — The per-date cap and the 500-row cap are service rules**, re-counted under the
  list-version guard so a concurrent add cannot slip past them.
- **B21 — Every list write is serialised by an optimistic `list_version` on the series.** The loser
  of two concurrent imports is refused as a conflict, having written nothing — no advisory lock,
  nothing session-level.
- **B22 — `media_asset_id` on a row is a single-column FK with `ON DELETE SET NULL`**, because
  `media_assets` has no `unique(project_id, id)`. Cross-project reference is prevented by resolving
  filenames through the scoped media repo, covered by an isolation test.
- **B23 — The import resolves every filename in one query**, classifying none / more than one / a
  video / one image in memory.
- **B24 — One evaluation pass, `evaluateDatedSeries`, called from three places**: the producer, Resume,
  and the read service in a read-only mode for the upcoming list.
- **B25 — Retiring is always done; recording a miss is bounded.** If retiring were also bounded to 30
  days, a row whose window closed 40 days ago would never fire again.
- **B26 — Advancing is deterministic and forward-only**, with `02-29` constrained to `02-28` in a
  non-leap year, the same rule the monthly cadence boundary already relies on.
- **B27 — Occurrences are pruned by age in the existing housekeeping pass**, same 90-day horizon and
  limit as the run prune; a pending occurrence is never matched.
- **B28 — The rows table is five columns, and the full row lives in its editor**: Date · Subject ·
  Image · Next due · Actions. A37 asks for the file's own columns, but the five-column rule
  `docs/design-system.md` states is absolute; recorded here so review judges the trade.
- **B29 — Three sections and one control on the existing detail page, in A35's order**: Upcoming,
  Last import, Rows (`?rows=N`), and Import. No new route except the row dialogs' server actions.
- **B30 — Two new exports in the one formatter file, plus one component.** `formatLocalDate` and
  `formatMonthDay` in `src/lib/time/format.ts`; `LocalDate` mirrors `LocalTime` with no tooltip.
- **B31 — The occurrence rule is a `SegmentedControl`, shown only on create**; on edit a read-only
  line with A2's sentence, and the server refuses a changed rule.
- **B32 — The import reuses the existing CSV file input and `CsvProblemList`**, moved to
  `src/components/ui/` so both screens import one component.
- **B33 — The run config stays `v: 1`.** `rule` defaults to `"cadence"`, `cadence` becomes nullable
  and `leadDays` is added, so every config `071` already stored parses unchanged.
- **B34 — Two new tick counts, `missed` and `retired`**, joining `StandingSeriesCounts` and the
  one-line tick summary.

### What this entry does not do

- **No external date source.** No holiday calendar, no almanac, no "on this day" feed, no API import.
- **No likeness generation.** Row data never reaches an image provider; a dated series about a real
  person is text and typography over an image a person chose.
- **No change to cadence semantics.** Boundaries, no-backfill, planning, avoid-titles, self-pause and
  the per-tick bounds are untouched.
- **No conversion between occurrence rules.**
- **No per-row accounts, voice profile, policy, lead time, instructions or image prompt.**
- **No recurrence beyond "this month and day, every year or once".** No "second Tuesday", no "every
  three years", no ranges, no spans, no multi-day events, no lunar or non-Gregorian calendars.
- **No backfill** of occurrences whose windows closed, and no retry of a missed occurrence.
- **No public API, MCP, webhook, notification, email or real-time push** for dated lists.
- **No spreadsheet editing experience**: rows are added, edited and deleted one at a time; re-import
  is how a bulk change is made.
- **No media upload during import**, and no fetching an image from a URL named in a row.
- **No video**: a row's asset is an image, and none is generated.
- **No explicit-time scheduling**: a dated post is a draft or takes a real slot on or after its date.

## 072 — Pinterest provider (2026-10-14)

Judgement calls from `specs/072-pinterest-provider/spec.md` and its plan (`research.md`, K1–K38). External facts come
from `docs/research/pinterest.md` only (checked 2026-10-14, nothing run live). All Pinterest behaviour is verified
with mocks only; the live checks are owed once the deployer's Pinterest app has Trial access
(`docs/pinterest-setup.md`).

### Spec decisions

- **The three-slot text mapping.** Pinterest has no single post-text field: the post's shared text becomes the pin's
  `description` (800 code points, K5); `title` (100) and `link` (2048) are per-target posting fields, not shared post
  text, because they only make sense per pin (K6). Each over-length value is kept in the values schema and refused by
  name rather than silently dropped, so a person's typing is never lost (K7).
- **The board is a per-post choice, not an account setting.** An account's boards are read live
  (`GET /v5/boards`, paged up to 10 × 250) and a board is required on every target; a board no longer on the account
  is kept selected but disabled and labelled "no longer on Pinterest" rather than silently falling back to a
  placeholder. *Rejected:* one Docket account per Pinterest board (would turn one grant into dozens of accounts);
  a board as an account setting (one board for every post, and a deleted board would break the whole account instead
  of one post).
- **No hard aspect range.** Pinterest's 2:3 recommendation is documented as a feed-cropping concern, not a creation
  refusal, so Docket declares no `minAspectRatio`/`maxAspectRatio` (the media planner would otherwise refuse an image
  Pinterest would merely crop) and instead warns, as a non-blocking issue, outside a `[0.5, 1.0]` band (K12).
- **The ambiguous-on-create rule (K29).** A 5xx on the single `create_pin` step is `ambiguous`, not retryable: with
  one step there is no "before the creating request is sent" to be safely before, and a 502/504 can follow a request
  Pinterest's backend already processed. Only a pre-send network failure (connection refused, DNS) is retryable.
  *Judgement call against a loose reading of FR-025, recorded; X's provider decides the same way.*
- **Scopes not requested.** Only `user_accounts:read`, `boards:read` and `pins:write` are asked for — no
  `boards:write` (posting into an existing board needs no board creation) and no `pins:read` (nothing calls
  `GET /v5/pins`; an ambiguous create has no provider check to resolve it against, K18). A narrower grant than the
  account could be given.
- **`video_not_accepted` keeps the generic wording, correcting the contract's K11 list.** The contract originally
  called for Pinterest to reword this code too, but facebook/instagram/threads all deliberately exclude it from
  their own rewording so the cross-provider media-fit badge test sees one sentence for every provider without
  video support; Pinterest now follows the same convention (found during Phase 7's full-repo pass). The aspect-ratio
  and HTTPS checks were also narrowed to real image items (`mimeType` starting `image/`) so that same badge preview,
  which calls `validatePinterest` with a video-shaped item, does not also trip Pinterest's image-only checks.
- **The Trial-cap gap.** Pinterest's Trial access caps the whole app at 300 pin creations a day, shared across every
  connected account. That cap cannot be expressed per account without mis-counting (a cap shared across several
  accounts would make each account's own limit fictional), so it is **not** modelled as an enforced
  `defaultPublishLimit` row; it is stated in prose on the account card, in the requirements summary, above the
  posting fields and in `docs/pinterest-setup.md`, and a 429 from it defers the post rather than failing it.

### Generic changes

- **G29 — A `choice` posting field view may declare `labelKey`.** The panel then also stores the chosen option's
  label under that key, so `targetNote` (which receives values only, no live details) can show "Board: <name>" on
  the posts list, post detail and calendar, none of which have a live board list to resolve an id against.
  *Reverse:* delete the member and the panel's second `onChange` call; stored labels become unread values the
  provider's schema strips.
- **G25's `notice` gains `docLabel`, correcting the hard-coded TikTok link text.** The panel's notice link rendered
  the literal string "Read how TikTok's audit works" for every provider that declared `notice.doc`; it now renders
  the provider's own `docLabel`, and TikTok supplies its existing label so nothing it shows changes. *Reverse:* drop
  the member; the panel falls back to one neutral label for every provider.
- **G25's panel counter now uses the field's declared counting rule, correcting a UTF-16-only count.** The `text`
  field counter always measured `value.length` regardless of `field.countingRule`; a new pure `countPostingText`
  reads the rule (falling back to `value.length` when a custom rule's function did not survive the server→client
  JSON boundary) so Pinterest's title and link count code points, the units their own refusals name, while TikTok's
  UTF-16 display is unchanged. *Reverse:* revert the counter to `value.length`; a provider whose refusals count
  differently would show a count that disagrees with its own validation.

### Hook reversal notes

Each addition is optional and inert for a provider that does not use it: dropping `labelKey` (G29) leaves the panel
making one `onChange` call, as before; dropping `docLabel` falls back to one neutral label; reverting the counter to
`value.length` changes only what a provider whose `countingRule` is not UTF-16 shows in the panel, not what it
refuses. No schema, scheduler, gate or engine change rides with any of the three, so reverting all of it is a code
change with nothing to migrate.

### Implementation outcome

Pinterest connect, token refresh, the live board picker, posting fields (title, link, board with `labelKey`),
publish-in-one-request, every outcome in the FR-024–FR-026 table (including the ambiguous paths), the Trial-access
notes and the operator docs are built and tested with mocked HTTP only. Nothing was run against Pinterest's live
service; the live checks are listed in `docs/pinterest-setup.md` (FR-037) and are owed once the deployer's app has
Trial access. Not built, and owned by no spec: the items in `docs/feature-map.md` — video pins, carousel pins, board
management, secret/protected boards, analytics, product/rich pins, catalogs, ads, Business Access, AI-disclosure
labels, `api-sandbox`, automatic tier detection, and the shared Trial cap as an enforced limit.

## 073 — Public API for project setup (2026-10-14)

Spec and research: `specs/073-setup-write-api/{spec,research}.md`, decisions D1–D10.

- **One new permission, `manage_setup`, not four.** The four services in scope
  (`projects.create`, `accounts.setPostingInstructions`, `slots.*`, `voice.*`) each ask for one
  grant the existing `KEY_GRANTS` table has no entry for, so the permission set was settled by the
  code rather than chosen freely. Standing a brand up is one job done by one integration, and a
  separate `manage_project`/`manage_voice`/`manage_accounts`/`manage_slots` quartet would be four
  checkboxes for that one job, and nothing forecloses splitting later if it turns out wrong. It is
  deliberately not spread from `write_posts` or any `SEES`-derived set: a key that can retime a
  schedule and rewrite a voice should not silently also be able to post, and a key that can post
  should not silently gain the power to retime a schedule — FR-007/FR-008 keep those two kinds of
  trust apart. No existing key holds the new value, so no existing key gains anything, and
  `manage_setup` alone reaches none of the pre-existing operations because the pipeline checks an
  operation's own permission first, not a key's whole grant set.
- **A project's owner is the key's creator, not the key itself, and "no acting user" is a null
  user id, not a departed member.** `createProject` passes `scope.membership.userId` as the owner
  and refuses only when that id is empty — which happens when the creating user's *account* was
  deleted, not merely when they left the project the key lives in. A key whose creator left the
  project still creates projects they go on to own; that is not a contradiction, because owning a
  project you created is independent of your membership in a different one. Guarding on anything
  stricter (current membership in the key's own project) would break a legitimate provisioning key
  after an ordinary staff change, for no safety gain.
- **`POST /projects` commits its own transaction (`idempotencyMode: "self_commit"`), and the
  documented backstop for a crash between that commit and the idempotency record is the slug's
  global uniqueness, not a new mechanism.** Project creation is deliberately cross-project work on
  its own connection, so it cannot run inside the calling key's project-scoped transaction the
  default idempotency mode opens — doing so would risk a committed project whose idempotency
  record then rolled back, and a replay creating a second one. The residual window between the
  project's own commit and the idempotency record's write cannot produce two projects regardless,
  because a replay reuses the same slug and the existing unique constraint on `projects.slug`
  answers 409 before a second row is possible.
- **The slug conflict earns a reason, `slug_taken`, and nothing else about it changes.** Without a
  reason, a taken slug was a bare 409; `ConflictError` already carries one, so giving it
  `{ field: "slug", reason: "slug_taken" }` costs no new error code (FR-039 requires reuse) and no
  new class. The message is the same text regardless of whether the calling key can see the
  project already holding the slug — no code path reads that project — so a cross-project slug
  collision and a same-project one are byte-identical on the wire, by construction rather than by
  care.
- **`projects.slug` is unique across the whole install, not per tenant** — a pre-existing
  constraint this entry depends on rather than introduces, but worth restating here because it is
  the reason the slug conflict above needs no tenant-scoped lookup: the database already refuses
  a second claim on any slug, from any project, and the API surface's job is just to report that
  refusal cleanly.
- **The whole-week slot add is its own operation, `POST /slots/week`, not a flag on `POST /slots`.**
  `addSlot` and `addSlotsForWeek` are different service functions returning different shapes (one
  slot versus created-plus-already-set), and the rule holding across this whole entry is one
  service function per operation (FR-002). A single endpoint branching on a body flag would need a
  discriminator in the request and a union in the response for no gain, and the route matcher
  already resolves `/slots/week` against `/slots/{slotId}` and `/slots/upcoming` without
  ambiguity, so there was no routing reason to collapse them either.

Implementation outcome: `POST /projects`, `POST /voice-profiles`, `PATCH /voice-profiles/{id}`,
`PATCH /accounts/{id}` (posting instructions), `POST /slots`, `POST /slots/week`,
`PATCH /slots/{id}` and `DELETE /slots/{id}` are built, permissioned, documented in the OpenAPI
surface and covered by the integration suite, closing the gap `docs/brand-onboarding.md` named.
The one step that stays in the browser, by design, is creating the API key itself — a key cannot
create the project that will hold it.

## 074 — An MCP server over the v1 API (2026-10-14)

Spec and research: `specs/074-mcp-server/{spec,research}.md`, FR-030.

- **A route in the Next app, not a separate process.** The deployment is three containers
  (web, worker, postgres) and the constitution makes new infrastructure a justified exception.
  Everything the MCP layer needs — `forApiKey`, the rate-limit counter, the permission check,
  the idempotency table, `mapServiceError` — already lives in the web process; a separate
  process would either duplicate them or talk to the web process over the very HTTP API it is
  translating. Hosting it as a route also means one origin, one TLS certificate and one set of
  secrets, and keeps the "same key, same answers" equivalence trivially true by sharing code
  rather than reimplementing it against a second entry point. **Accepted cost**: a long-lived
  MCP connection shares the web container's resources with the UI, rather than isolating MCP
  traffic behind its own process boundary. *Reverse*: extract `src/server/mcp/*` into a
  standalone process that calls the web app's own HTTP API internally; nothing in those modules
  imports the database directly (`tests/lint/api-imports.test.ts` enforces it), so the move
  costs a new deployment artifact, not a rewrite.
- **The key decides the project; there is no project-selection step.** A key already belongs to
  one project, so the project for an MCP session is whichever project the key the client was
  configured with belongs to — no tool takes a project id, no tool switches project, and
  driving two projects means two configured server entries with two keys. This carries 009's
  rule forward unchanged, and makes the project-isolation test a statement about every tool at
  once. **Accepted cost**: a person managing several brands from one chat client configures
  several server entries rather than switching projects mid-conversation. *Reverse*: add a
  project-selection tool and thread a project id through every other tool's schema — rejected
  because it would let one compromised key enumerate project ids by trial, the opposite of the
  isolation guarantee FR-016–FR-018 ask for.

Implementation outcome: `/api/mcp` serves `initialize`, `tools/list` and `tools/call` over
Streamable HTTP, built on `@modelcontextprotocol/sdk`. Nineteen of the v1 API's 34 operations
are exposed as tools, derived — name, input schema, description — from each operation's own
`mcp` disposition field rather than hand-maintained; a drift test fails the build if a new
operation omits that field or the derived surface stops matching it (`tests/integration/api/mcp-surface.test.ts`).
Documented in `docs/mcp.md`, cross-referenced from `docs/n8n.md` (FR-031, FR-032), and recorded
in `docs/security.md` as adding no new credential or trust boundary (FR-033).

**One open judgement for a reviewer to accept or reverse**: `docket_generate_post` deviates
from this spec's own Decisions text, which said "generation is exposed without confirmation."
`generatePost`'s body accepts `schedulingPolicy: "add_to_queue"`, which queues the generated
post to the brand's live accounts in the same call — an irreversible publish FR-021's effects
list (queueing a post) already requires confirmation for, even though FR-021's list of *tool
names* does not mention `generatePost`. Research D9 resolved this in favor of the effect over
the operation id: the tool's disposition carries a conditional confirmation,
`confirm: { when: (args) => schedulingPolicy !== "leave_as_draft", effect: … }`, so a
generate-that-could-queue demands confirmation (matching FR-020's effects-based rule).
*Amended during review*: the predicate first read "`schedulingPolicy` present and not
`leave_as_draft`", on the reasoning that a plain generate-to-draft needs no confirmation
(matching the spec's text). That was wrong, because the effect is decided by the *resolved*
policy, not the requested one: `resolvePolicies` falls back to the project's
`defaultSchedulingPolicy`, so in a project configured `auto_approve` + `add_to_queue` a call
passing no `schedulingPolicy` at all published to the brand's live accounts with no
confirmation ever demanded. The predicate now treats an absent policy as "unknown, therefore
confirm", and only an explicit `leave_as_draft` skips the gate. *Reverse*: delete the
`confirm` key from `generatePost`'s disposition in
`src/server/api/operations/generate.ts` — a one-line change — if review prefers the spec's
literal reading; the accepted cost of reversing it is that the generate tool becomes the only
unconfirmed path to a live publish over MCP.

## Public home page and privacy policy (2026-10-14)

Pinterest refused the Trial request for the docket.jamiebclark.com installation: the website must be online and
describe the app, and the privacy policy must load on a domain clearly associated with the app. Docket had no public
page at all — anonymous `/` redirected to `/login`, and the policy existed only in the repository (served from GitHub
Pages, which fails the domain test).

- **`/` is public for anonymous visitors.** It renders a short description of the installation (what it does, the
  platforms it posts to, that it is not a social network and is invitation-only) with a Log in button. A signed-in
  visitor is still sent into their project and a fresh install to `/setup`. *Reverse:* drop `/` from `PUBLIC_EXACT`
  and restore the `/login` redirect in `decideAnonymousRedirect`; the cost is that platform reviewers see a bare
  sign-in form again.
- **`/privacy` serves the policy from code** (`src/app/privacy/policy.tsx`), titled exactly "Privacy Policy", with a
  test that keeps its sections in step with `docs/privacy.md`.
- **Operator identity is configured, never inferred.** `DOCKET_OPERATOR_NAME` and `DOCKET_OPERATOR_CONTACT` are
  optional; unset, the pages say "operated by whoever deployed it". A malformed value is a start-up warning, not a
  refusal to start — these are cosmetic.
- **`PINTEREST_DOMAIN_VERIFY`** emits `<meta name="p:domain_verify">` so the operator can claim the website on the
  business account that owns the app.

## Migrations: never compare a column to an enum label added in the same batch (2026-10-15)

A deployment at migration 0029 could not start: `prestart` reported "database migration failed" and
nothing else, over and over, while a fresh install of the same image worked perfectly.

The cause is a Postgres rule meeting a Drizzle behaviour. `drizzle-orm/pg-core/dialect.js` wraps
**every pending migration in a single transaction** — not one transaction per file — and Postgres
refuses to use an enum label added by `ALTER TYPE ... ADD VALUE` until the adding transaction has
committed (`55P04 unsafe use of new value`). Migration 0030 adds `'date'` to
`standing_series_period`; 0031 then used that label in two CHECK constraints. Splitting them across
files looks like it should work and does not, because they share a transaction.

A fresh database is exempt: Postgres permits using a new label when the type was *created* in the
same transaction, which 0029 does when everything replays from empty. So CI — which only ever
migrates from scratch — stayed green while every existing install broke on upgrade. The bug is
invisible to the one path CI tests.

**The rule:** a migration must never compare a column to an enum label introduced by `ADD VALUE`
unless the comparison casts the column to text first — `"col"::text <> 'label'`. Measured against
Postgres 17: the bare comparison fails with 55P04, both `::text` and listing only pre-existing
labels succeed. `::text` is preferred; an `IN ('day','week','month')` list silently needs editing
every time a label is added.

Fixed by casting in `src/server/db/schema/standing-series.ts`, correcting 0031 in place (it had
never applied anywhere, so no install carried its old form), and generating 0035 so installs that
*had* applied the original — fresh ones, including CI — are moved to the cast form too.
`tests/integration/db/enum-value-in-batch.test.ts` guards both the migrations and the schema source.

Worth knowing for the future: the gap is that nothing tests an **upgrade** from a committed older
schema. A test that commits through migration N and then applies the rest in one transaction would
have caught this before release; it is not built yet.

## Engagement inbox: Bluesky identity is settled, Meta identity is not, DMs are sequenced not cut (2026-10-15)

`docs/research/engagement.md` records, from the installed `@atproto/api` generated types, that a
Bluesky commenter carries a stable identifier (`did`), a handle and usually a display name — so the
identity question that makes a "recognisable person" risky is already answered for Bluesky, with no
human task needed. US2/US3 build on that directly.

For Meta (Facebook Page comments, Instagram comments, Threads replies), every FR-001 question —
read endpoint, required permission and whether it's inside Standard Access, commenter identity
shape, identifier stability, reply capability, pagination, read rate limits — is **unverified**.
`docs/research/meta.md` documents publishing only; nothing in it names a comment-read endpoint or a
commenter identity shape. **Consequence:** no Meta engagement surface is built in this entry. US4 is
blocked on a human task (a live Standard Access app, a real Page, a real Instagram Business account,
a real Threads account, a second person to comment, and a browser), scheduled last in `tasks.md` so
an unrunnable task placed early does not starve the implement loop. No code anywhere in this entry
may display a Meta commenter identity field that isn't traceable to a confirmed verdict (FR-005).

Direct messages are **not cut from the spec** — US5 stays specified — but no platform's DM facts
exist for any platform in scope, so DM reading, drafting and sending are sequenced out of this entry
entirely rather than built on a guess.

## Engagement inbox: the send ledger is an insert-only claim, not a mutable status (2026-10-15)

A send recorded "durably at the moment of the send" (so a crash between sending and recording cannot
double-send) and an ambiguous send that a person can later unstick both need to be true at once. An
insert-only row that also carries the outcome cannot do both: making it mutable would contradict
"never updated, never deleted" and lose the history of a released attempt. The ledger
(`engagement_reply_claims`) is instead a **claim written before the provider call, in its own
committed transaction**, keyed `(project_id, social_account_id, item_external_id, generation)`.
Generation 1 is the first attempt; a concurrent second attempt collides on the key and is refused by
the record, not by timing. The *outcome* lives on the draft row, never on the ledger. A higher
generation may only be inserted with a stated reason — `definite_failure` (the platform refused
definitively, nothing was sent) or `member_decision` (a person on Failures records that an ambiguous
attempt never arrived) — enforced by a CHECK. Keying on the platform's identifier rather than the
item row is what lets retention delete an inbound item without losing the fact that it was already
answered.

## Engagement inbox: one notification per read batch, not per item (2026-10-15)

New inbound items raise attention through the existing activity-event mechanism, but a per-item event
would have to carry something identifying the item — and the message would be tempting to fill with
the commenter's own words, which the activity log cannot carry (it feeds notification emails that
leave the installation). A batch is also the unit a person actually acts on ("I have looked at the
inbox"), and a popular post would otherwise bury every publishing failure under hundreds of events
and peg the unread count at its cap. So exactly one `engagement_received` event is written per account
per read run, `details: { items: n }`, counting only newly inserted rows in the same transaction as
the insert — a re-read contributes nothing and names no third party.

## Engagement inbox: the reply prompt sits beside the post generator, not inside it (2026-10-15)

Drafting a reply reuses everything *below* the prompt (`resolveLlmForProject`, the credit hold,
`createUsageRecorder` under a new `engagement.reply` purpose, the voice profile and brand, and the
provider's own text-counting rule) and nothing of the prompt itself. `services/generation/core.ts` is
post-shaped at both ends — variant groups, media, a brief, and a `variants`-keyed output — and
threading a reply through it as a synthetic single-group post would distort the prompt, the output
schema and the retry-correction loop for every existing caller. Generation already has five call
sites over one shared core; a sixth artifact with its own prompt (`services/engagement/prompt.ts`) is
the established pattern, and the constitution's "exactly one implementation" list names slot
allocation, approval policy and publishing, not prompt text.

## Engagement inbox: the write-budget reserve keeps publishing served first (2026-10-15)

FR-042 requires publishing to never wait on a reply. The engagement-send scheduler section therefore
runs only after the publishing section resolves in the same tick, and a reply may be sent only while
the account's writes already started in the current window stay under
`floor(budget.count × (1 − ENGAGEMENT_WRITE_RESERVE))`, with `ENGAGEMENT_WRITE_RESERVE` defaulting to
0.25 and `budget` the stricter of the provider's declared engagement write budget and the account's
own publish limit. A per-run cap (`ENGAGEMENT_SENDS_PER_TICK`, default 5) stops a burst from consuming
the tick's time budget. On Bluesky the reserve floor is roughly 416 writes an hour kept for
publishing — orders of magnitude above normal use, invisible until a burst makes it decisive. A reply
held back by any of the three rules is left `waiting` with a reason, never sent, never failed.

## Engagement inbox: retention is a horizon on both deletion and ingest (2026-10-15)

Inbound items older than `ENGAGEMENT_RETENTION_DAYS` (default 90, operator-configurable) are deleted
with their drafts in the existing bounded housekeeping pass, provided no draft awaits a decision and
no send is unresolved; an item the platform reports deleted is eligible on the next pass regardless of
age; the claim ledger is never pruned. Ingest additionally ignores any item older than the retention
horizon, so a cursor restart cannot resurrect and re-notify something retention has already removed —
making the horizon a rule on ingest as well as a deletion rule is what keeps retention from fighting
the cursor.

## Engagement inbox: three points re-examined after the design settled (2026-10-15)

1. **Sending happens in the tick, not in the HTTP request that approves it.** FR-028 forbids a send
   nobody approved, but does not require the send to happen inside the approving request, and FR-043
   explicitly anticipates "waiting for a later run". Sending in the tick is what gives it a lease, a
   claim ledger and the publishing-first reserve; the approving member is still recorded on the draft
   and the activity event.
2. **One new `activity_outcome` label forces the attention index to be rebuilt without naming it.**
   Executed against Postgres 17.11: a partial index predicate can neither cast an enum to text
   (`42P17`, the cast is not `IMMUTABLE`) nor name a label added in the same transaction (`55P04`). The
   predicate is inverted to name only pre-existing labels; the planner still chooses the index for the
   unread-count query (research.md §2).
3. **The inbox is its own screen; only the decision lives in Review.** Straight from the spec's stated
   assumptions, and it keeps the Review queue doing the one job it already does well.

## 078 — Instagram Stories (2026-10-16)

Judgement calls from `specs/078-instagram-stories/spec.md` and its plan (`research.md`, K1–K20).
External facts come from `docs/research/meta.md` and `docs/research/meta-video.md` (checked
2026-10-16). All Story behaviour is verified with mocks only.

### Spec decisions

- **D1 — the post's text is dropped, not refused.** A Story target ignores the post's shared text; the
  person is told so by a non-blocking notice, and a post with a Story target is *not* required to be
  text-free. *Rejected*: refusing a Story whose post carries text, which would make it impossible to
  schedule the same content as a captioned Facebook post and a wordless Instagram Story together — the
  normal case for one post fanned out to several accounts.
- **D2 — the asset's description is dropped, with the same notice treatment.** Alt text is never sent
  on a Story; Docket attaches a description to every asset for other uses, so something is always being
  dropped, and a non-blocking notice names it. *Rejected*: refusing a Story because its (correct, useful
  elsewhere) asset has a description, which would be perverse.
- **D3 — a non-9:16 image is passed through to Instagram's own cropping, neither refused nor
  letterboxed.** The platform documents 9:16 only as a recommendation and states no hard aspect range
  for an image Story, so refusing would be wrong on the facts; letterboxing would mean Docket inventing
  a crop or a fill colour on the person's behalf, which its image handling has never done. This follows
  the precedent Pinterest's "No hard aspect range" set for the same shape of problem (entry 072, K12):
  declare no bound, warn instead of refuse. Applies to the image only — a Story video keeps the
  documented 0.1:1–10:1 hard range (FR-020, FR-022).
- **K1 — `PostShape` gains `single_image`, and `resolvePostType` consults a declared choice for it,
  exactly as `single_video` already does.** This is the plug-in boundary working as designed, not being
  bypassed: it is the one place every caller (composer, API, gate, engine, formatter) already asks what
  a target publishes as, so widening it is the only change that reaches `chosen_post_type` and
  `postTypeRefusal` without a provider-specific branch in shared code (constitution IV). A provider that
  declares no `single_image` choice is unaffected — `choiceFor` returns null and the default stays
  `image`.
- **K5/K6 — per-post-type image limits are a declaration (`media.byPostType`), not a flag.** A new
  `ImageLimitOverrides` type (`minAspectRatio`/`maxAspectRatio`, `null` to remove a bound;
  `recommendedAspectRatio`; `notes`) sits beside the video block's existing `byPostType`, merged by
  `imageLimitsFor(caps, type)`. Instagram's own `media.byPostType.story` (`minAspectRatio: null`,
  `maxAspectRatio: null`, `recommendedAspectRatio: 9/16`) is the single declaration that drives the
  planner no longer refusing a 9:16 image, nothing reshaping it, the shape notice, and the requirements
  summary reporting "no limit checked" plus the note. *Rejected*: a boolean "is a story" flag threaded
  through the planner and validator, which would duplicate the range logic the video block already has
  and give no record of what, specifically, a story relaxes.
- **K8 — the aspect bounds leave `constraintsHash`, and `prepareVariants` resolves each target's post
  type before planning, so a Story and a feed post share one variant and a 9:16 Story image is actually
  built.** `minAspectRatio`/`maxAspectRatio` are read by `planImage` only to refuse; they never change
  the derived file's type, size or dimensions, so hashing them would give byte-identical output two
  identities for no reason. `prepareVariants` resolves each target's post type the same way
  `resolvePublishMedia` does and plans with `mediaConstraintsOf(caps, postType)`, so a Story image
  outside the feed's aspect range is planned under the Story's (unbounded) range and a variant is
  actually built — the shared hash means this still collapses to one build per asset, not two.
  *Consequence, accepted*: every existing cached image variant hashes differently once and is rebuilt
  lazily — `resolvePublishMedia` rebuilds a missing one at publish time, so no scheduled post can fail
  because of the change. A test (`src/server/media/hash.test.ts`) asserts two constraint sets differing
  only in aspect share one hash, and integration tests (`tests/integration/media/variants.test.ts`)
  assert a Story and a feed post resolve to the same variant row for an in-range asset, and that a 9:16
  Story image — refused outright for the feed — is built and schedulable as a Story. *Rejected*: leaving
  `prepareVariants` post-type-blind (the shared hash alone does not help an asset the feed's bounds
  refuse before any build); bumping `VARIANT_PIPELINE_VERSION` instead (same rebuild, with no record of
  why).
- **K11 — a story target drops the feed's aspect error and both alt-text issues.**
  `validateInstagram` keys its aspect check on `imageLimitsFor(caps, type)`, so with no bounds declared
  the check cannot fire; it also filters `missing_alt_text` and `alt_text_too_long` for a story, since a
  Story can carry no description at all, so asking for one is noise and refusing one for an otherwise-
  correct description would be perverse. Derived from the fact that the description is never sent
  (D2), not stated directly by the spec, so recorded here as a judgement call.
- **K16 — a `STORIES` container reads `status_code,status` and names the Story in its ERROR message.**
  Images today read `status_code` alone and fail with a generic "status ERROR" message. The spec's edge
  case requires a Story to fail with what Instagram said and to point at the asset, so a `STORIES`
  container reads the same `VIDEO_STATUS_FIELDS` a video container does and fails with "Instagram could
  not process the Story's media{: detail}. Check the asset's format, size and shape; nothing was
  published." Feed images are untouched.
- **The constitution amendment.** The Engineering Constraints line blanket-excluded "stories" until a
  spec said otherwise; this spec is that exception. `.specify/memory/constitution.md` now reads
  "stories (except Instagram Stories, 078 — Facebook Page Stories stay out of scope)" rather than
  dropping "stories" outright, so Facebook Page Stories — unresearched, unverified — stay excluded by
  the same sentence that lets Instagram's in.

### Implementation outcome

Image and video Stories compose, validate with their own notices, schedule and publish against a
mocked Graph, end to end through the real scheduler (`tests/integration/instagram/stories.test.ts`),
including the daily container allowance, the platform quota, `PUBLISHED`-as-ambiguous, container
expiry and recreation, and a create step killed mid-flight. The API surfaces everything the composer
does (capabilities, validation issues, requirements summary) with no UI involved. Not built, and owned
by no spec: Facebook Page Stories, stickers and links on a Story, reading a Story back, and multi-asset
Stories (`docs/feature-map.md`).

## Password reset: Better Auth owns the token, Docket owns the message (2026-10-16)

Spec 044 built the SMTP mailer and listed password reset as out of scope but newly possible. Reset is
now wired, and no new mail dependency came with it: `SMTP_HOST`/`SMTP_FROM` already reach any provider,
including a hosted one over SMTP, so a second transport (a Resend SDK, say) would have added a secret
group and a parallel outcome classifier to replace something tested.

1. **Better Auth owns the whole token lifecycle.** `/request-password-reset` already does the
   constant-time miss for an unknown address, writes the single-use row to `verification`, expires it
   and consumes it. Docket supplies only `sendResetPassword`, so there is no second token
   implementation to keep correct beside the invitation one.
2. **`revokeSessionsOnPasswordReset` is on.** A reset hands the account to whoever holds the mailbox;
   leaving other sessions alive would defeat the common reason for resetting.
3. **The reset does not sign the person in.** It redirects to `/login?reset=1`, which carries the
   confirmation. Holding a mailbox proves the address, not that the person remembers what they just
   typed.
4. **The per-email limiter is not gated on `ctx.request`,** unlike the sign-in limiter beside it. The
   reset request also arrives in-process from the `/forgot-password` server action, where Better Auth's
   HTTP rate limiter never runs, so the `before` hook is the only choke point both routes share. A
   per-address limit is not enough on its own, though: it cannot see a caller walking a *list* of
   addresses, each one under its own cap, and every real address on that list gets mailed. So the hook
   also holds a process-wide ceiling of 60 reset requests a minute, consumed by every request including
   one the per-email limit already refused. The endpoint being enumeration-safe does not make unbounded
   outbound mail safe.
5. **Change-password goes over HTTP through `authClient`,** like the sign-in form (001 D5) and for a
   sharper reason: with `revokeOtherSessions` Better Auth deletes every session including the current
   one and sets a replacement cookie, and only the `/api/auth` route runs the `nextCookies()` plugin
   that writes it back. An in-process server action would change the password and then sign the person
   out of the browser they changed it in.
6. **With no SMTP group configured there is no reset form at all** — the sign-in page omits the link
   and `/forgot-password` explains instead. The request would otherwise succeed, send nothing, and
   leave someone waiting on an email that is never coming.
7. **A new `password_reset` purpose on `email_delivery_attempts`** (migration 0040), so a reset send is
   auditable exactly like an invitation: no address, no body, no token — only the outcome and its SMTP
   code. `recordInvitationAttempt` became `recordTransactionalAttempt(db, purpose, …)` rather than
   growing a near-copy.
8. **Both reset pages are in `auth-gate`'s `PUBLIC_EXACT`.** The optimistic gate in front of the app
   redirects a cookie-less request to `/login`, which for these two routes is a closed loop: the person
   resetting a password cannot sign in by definition. This is the same trap the unsubscribe routes hit
   (044), so it now has a test of its own beside theirs.

## 080 — Post and account insights, Bluesky as the pilot platform (2026-10-17)

`insights` (G30) is one more optional member on `SocialProvider`, the same shape as `engagement` (077):
a provider that omits it is absent from the poller and the panel with no error, and no code outside
`src/providers/` may name a provider key or a platform metric key. Two new tables capture one reading
each of a post's and an account's numbers; two poll-state tables decide when the next reading is due.

- **A metric the platform does not report is absent, carried all the way to the screen.** Not zero, not
  a dash, not a null. The provider declares which keys it reports; a key missing from a snapshot
  renders no row. Bluesky declares no views and no reach, so the panel never implies a post was seen
  zero times — the rule the whole roadmap turns on, since an Instagram "view" and a Bluesky absence are
  not the same fact and nothing is ever summed or averaged across platforms.
- **Nothing overwrites a number.** Every successful read inserts a row; the DAL has no update and no
  single-row delete for a snapshot. The panel always states "as of &lt;time&gt;", never a current value.
- **Reads go through the account's existing session, not an unauthenticated host.** Whether Bluesky's
  public AppView answers anonymously is unverified, so the design does not depend on the answer either
  way: `agentFor(pdsUrl, accessJwt)` reads through the account's own PDS, the same session 077 already
  proves out, needing no new permission.
- **The declaration names metric keys with the platform's own label; the generic layer never renames
  one.** `{ key, label }` — `likeCount` / "Likes" — with no shared code mapping, aliasing or grouping
  keys across platforms. This is what makes "never sum across platforms" enforceable in the data layer,
  not only in a chart that does not exist yet.
- **The result vocabulary is `EngagementReadResult`'s, minus `cursor_lost`.** An insights read has no
  cursor: a poll asks for a fixed set of ids and the decaying schedule, not a cursor, decides what comes
  next.
- **`readPostMetrics` takes a batch of targets for one account, not one target.** `getPosts` accepts 25
  at-URIs in one call, and a later platform's reader may cap lower and need batching by account too.
  Batch size is `min(INSIGHTS_READ_PAGE_SIZE, provider.insights.maxPostsPerRead)`.
- **The poll schedule decays, from `published_at`, in two pure functions with no clock inside them.**
  Hourly for the first 24 hours, daily to day 7, weekly to day 28, then frozen — a three-week-old post
  does not change, and polling it hourly forever spends an allowance a scheduled publish may need, for
  nothing. The first capture is an hour after publish, not at publish, so the earliest snapshot
  describes a post that has had an hour of life rather than a row of zeroes-or-absences a reader would
  mistake for a result. A target already past the frozen boundary when the subsystem arrives gets
  exactly one capture, then freezes, so a large pre-existing backlog of posts is not left with no
  numbers forever, and drains over ticks (bounded by `INSIGHTS_TARGETS_PER_RUN`) rather than arriving as
  a spike.
- **"The platform no longer returns this post" is a per-entry outcome inside a successful read, not an
  error.** `getPosts` answers 200 with the dead post simply absent from the page, so an error kind would
  be a fiction, and a retry loop on a dead at-URI would run hourly for 28 days while the panel claimed a
  failure that never happened. The target's poll state freezes with that reason, `consecutive_failures`
  stays at zero, and its earlier snapshots are kept.
- **The freeze reason is a text CHECK, not a Postgres enum.** 077 already paid for an enum label added
  beside a partial index (a partial-index predicate cannot cast an enum to text, and cannot name a
  label added in the same transaction); a later platform will want more freeze reasons, and a CHECK
  widens with no `ALTER TYPE` and no index rebuild.
- **The allowance window is counted from the snapshot rows themselves, with no new counter.** For an
  account, the window count is publishes started in the window (the existing
  `post_targets_started_idx`) plus snapshots already captured in it, and a poll is refused once that
  total reaches `floor(stricterBudget.count × (1 − INSIGHTS_READ_RESERVE))` — `stricterBudget` and
  `reserveFloor` reused unchanged from `engagement-budget.ts`. The honest limitation: a *failed* read
  leaves no snapshot and so is not counted; `consecutive_failures` and the existing backoff bound that
  instead. The reserve default is 0.5, double engagement's 0.25 for writes, because a reply somebody
  approved is worth more of an account's allowance than a number nobody is waiting for. The same reserve
  is charged even where a platform's documented read limit is separate from its write limit (Bluesky's
  points are documented for writes only) — conservative rather than exact, and conservative is the
  right direction, recorded so a later entry with verified read limits can relax it.
- **A successful poll writes no activity event and no notification.** The panel is the surface; nothing
  here is something a person needs telling about. The one exception is already generic: a
  `credentials_invalid` read goes through `markInvalidEmitting`, the same needs-reauth signal every
  other credential rejection emits.
- **No new permission statement, no API, no MCP, no export.** The panel is governed by the existing
  `post: ["view"]` — a brand's own published numbers, visible to anyone who can already see the post,
  unlike 077's inbox which is a third party's personal data. A capability worth driving over MCP with no
  endpoint belongs in an API entry first (074's rule), and a later entry owns both; `OPERATIONS` stays
  untouched.
- **Two snapshot tables and two poll-state tables, not one of each.** A post metric is keyed on a target
  and an account metric on an account; they have different cadences, different lifetimes (a post
  freezes, an account never does) and different natural keys. One table with nullable keys would need a
  CHECK forbidding the invalid combinations and would make every query say which kind it means anyway.
- **The section is concurrent, not sequenced behind publishing.** The allowance reserve satisfies the
  "publishing always wins" requirement before any call is made; sequencing a read-only section behind
  the slowest section in the tick would buy nothing and cost it its own time share. Its time share
  defaults to 0.3 against engagement's 0.8, the least urgent section in the tick.
- **Account snapshots are captured and stored but shown on no screen in this entry.** Required by the
  capture requirements and the account-read acceptance scenario; the panel requirements are per-target
  throughout. A later entry owns account trends and needs the history to already exist, so the capture
  ships now rather than waiting. Published as a named gap in `docs/insights.md` and
  `docs/feature-map.md` rather than left for a reader to discover.
- **The constitution amendment.** The Engineering Constraints line's blanket "analytics" exclusion is
  amended to record that per-post and per-account metric capture is now in scope, while charts, trends
  and comparisons remain out of it — a `docs(constitution):` commit with a version bump.

### Implementation outcome

The whole spine — provider declaration, four tables, poll state, the concurrent `insightsPoll` tick
section and the post detail page's performance panel — runs end to end on the `mock` provider with no
platform credentials, and real Bluesky numbers flow through the same spine with mocked HTTP only. The
one open question — whether Bluesky's public AppView answers `getPosts`/`getProfile` unauthenticated —
stays `NEEDS RESEARCH` until the parked human task runs; until then the Bluesky reader is reported as
"verified with mocks only" (constitution II).

## 081 — Insights reconnect and Meta/Threads readers (2026-10-17)

### Research decisions

- **Research runs before any reader, and gates only the readers.** The grant-and-eligibility machinery
  (the `granted_scopes` column, the write boundary, the per-account eligibility predicate, the panel and
  accounts-page states) needs no platform-metric research at all and is built and tested first; only
  Instagram's, Facebook's and Threads' `insights.ts` modules wait on `docs/research/meta.md`'s tables
  (research.md §7, "nothing in the first half of the entry depends on any of these").
- **Facebook's roadmap metric names are deprecated — FR-005's disagreement.** The roadmap and spec
  FR-030 named `post_impressions`, `page_impressions` and `page_fans` (plus their paid/organic
  breakdowns). Meta's Page Insights deprecation, effective 2025-11-15, makes every one of them return an
  "invalid metric error." Their documented replacements (`post_media_view`, `page_media_view`,
  `page_follows`, and a further "Page Viewer Metric" planned for June 2026) are themselves mid-migration,
  and which one answers on Docket's running Graph API version (v26.0, as of 2026-10-17) could not be
  confirmed from search summaries alone. Decision: ship Facebook with the metrics that are on **no**
  deprecation list — `post_reactions_by_type_total`, `post_clicks`, `page_post_engagements`,
  `page_follows` — and leave the whole views/impressions/reach family undeclared as R2, rather than
  guess and fail the whole surface on one wrong name. Reversal: once R2 is answered (Phase 11 human
  task), add the confirmed views metric to `src/providers/facebook/insights.ts` and this file.
- **Six open `NEEDS RESEARCH` rows, each with a stated fallback, none blocking a requirement, default or
  test (research.md §7):**
  - **R1** — Instagram's user-level `views` metric's required `period`/`metric_type` combination.
    Fallback: not declared; `reach`, `follower_count`, `profile_views` are.
  - **R2** — which Pages views/reach metric answers on v26.0 today (`post_media_view`,
    `post_total_media_view_unique`, or neither). Fallback: not declared; reactions-by-type and clicks
    ship instead.
  - **R3** — Threads' media-insights metric enum from the official page, and whether `shares` exists on
    that edge. Fallback: declare the third-party-corroborated five (`views`, `likes`, `replies`,
    `reposts`, `quotes`) only if the implement phase can confirm them officially; otherwise ship
    `src/providers/threads/insights.ts` as `unavailable`. `shares` is dropped regardless — no source
    names it.
  - **R4** — Threads' `user_insights` metric enum (distinct from the profile fields). Fallback:
    `account: []`.
  - **R5** — a documented minimum call-budget floor for Facebook Pages and Instagram (Threads already
    has one: 4800 × an impression floor of 10 = 48,000/24 h). Fallback: the same 48,000/24 h figure,
    carried as an **interim, UNVERIFIED** stand-in and marked as such in `docs/limits.md`, same as 080's
    Bluesky row.
  - **R6** — whether Pinterest's token reply carries a `scope` field. Fallback: `granted_scopes` stays
    `NULL` for Pinterest; a later entry picks it up.
- **The declared read-budget floor binds almost nothing on its own, and that is written down rather than
  left for a reviewer to discover.** 48,000 reads/24 h is three orders of magnitude above what this
  subsystem ever attempts (`INSIGHTS_TARGETS_PER_RUN` is 50, Instagram's `maxPostsPerRead` is 1), so
  `reserveFloor` on that number is never reached. The real protection against Meta's own impressions-based
  limit is the live `X-Business-Use-Case-Usage` header (layer 3), not the declared floor (layer 2); the
  per-account reserve (layer 1) only bites when an operator has set a per-account publish override. A
  smaller invented floor would be a fiction with the same shape, so the honest number ships with the
  honest caveat instead.
- **Research correction: Meta's rate-limited error codes 80001/80002 were already fixed, and two research
  notes said otherwise.** The spec's constraint list and FR-046 (and `docs/research/meta.md`'s own "Code
  impact notes") claimed these codes were missing from `GRAPH_ERROR_TABLE.rateLimited`; commit `3a2626c`
  already added them, with a passing test. The stale notes are corrected here and in
  `docs/research/meta.md` rather than carried forward to be "fixed" a second time by a later entry that
  does not know to check history first.

### Specification decisions

- **`granted_scopes` is a nullable `text[]`, not `jsonb`, and `NULL` means "not known", not "none".**
  `NULL` = never recorded (an install that has not reconnected, or a provider whose reply does not list
  permissions); `{}` = the platform answered and granted nothing relevant — the two produce different,
  honest reasons on screen. An array is chosen over `jsonb` so eligibility is a plain, indexable SQL
  containment check. Reversal: widen to `jsonb` if a later provider needs structured scope metadata; no
  schema depends on the array shape beyond the one containment check.
- **A grant is recorded only from what the platform said, never from what Docket asked for.** Writing
  `META_SCOPES` into the column at connect would make it a restatement of Docket's own request, answering
  nothing. Reversal: none needed — this is the whole point of the column.
- **G31 — `grantedScopes` travels on `ConnectCandidate` and the success arm of `RefreshResult`**, the two
  existing doors into `social_accounts`; no provider gets a second, private write path. A refresh that
  reports nothing leaves the stored value unchanged. Reversal: remove the field from both shapes; every
  caller already treats it as optional.
- **G32 — `optionalScopes` lives on the `OAuthConnectGroup`, and the per-provider need lives on the
  `insights` declaration**, a deliberate, minimal divergence from the roadmap's wording ("a declaration on
  the provider"). The dialog URL is built by the *group* (`authorizationUrl`), and the Meta group backs
  Facebook and Instagram with different needs from one consent, so the two halves cannot live in one
  place without duplicating per provider. Reversal: move `optionalScopes` onto each provider and have the
  group merge them, if a group ever needs per-provider dialogs.
- **The operator opts in with one environment flag per connect group, defaulting to off.** The precedent
  is `TIKTOK_APP_AUDITED`; on Meta the permission must *also* be added to the Meta app itself, a deployment
  act no member can do from a web form, so a per-connect checkbox would offer a choice that does not work
  on its own. Default off means no existing install's consent screen changes until someone deliberately
  changes it. Reversal: default the flag on for a fresh install once the permission is considered routine.
- **With `META_LOGIN_CONFIG_ID` set, Docket says so instead of pretending.** When the flag is on and a
  config id is set, the dialog is unchanged (Docket cannot add a scope to a fixed configuration), and the
  accounts page's reason says the permission must be added to the Meta Login configuration, with a link to
  `docs/meta-setup.md`; no reconnect button is offered for a loop that cannot succeed. Reversal: offer the
  button again if Meta ever lets a `config_id` request carry additional scopes.
- **G33 — per-account eligibility, enforced in the claim, not in the reader.** An account is eligible for a
  provider's insights reads when that provider declares `insights` without a blanket `unavailable`, and
  either `requiredScopes` is empty or `granted_scopes` is non-null and contains every entry of
  `requiredScopes`. The claim queries apply this as a SQL predicate, so an unpermissioned account is never
  claimed, leased, decrypted or called. Reversal: move the check into the reader if the predicate ever
  needs data the claim query cannot see; the matrix test (research §6) would need rewriting either way.
- **The panel and the accounts page gain two states; `needs_reauth` is left alone.**
  `buildTargetInsightsView` gains `needs_reconnect` (the install asks for the permission, this account has
  not granted it) and `permission_not_requested` (the install has not turned the permission on at all),
  both ordered before `no_external_id`; the accounts page shows a matching line only in the first case. An
  account's status badge, its ability to publish and everything the scheduler does with it are untouched.
  Reversal: collapse the two states into one if the distinction turns out not to matter to a member.
- **Reconnecting updates the account in place and loses nothing.** `social_accounts_external_uq` keys on
  `(project_id, provider_key, external_account_id)` and `upsertConnected` already updates rather than
  inserts; this entry makes that a *stated, tested* property. After a reconnect the row keeps its `id`, its
  publish-limit overrides, its posting instructions, its slot assignments, its engagement state and its
  insights poll state and snapshots, and no second row appears. Reversal: none — this was already the
  behaviour; the entry only adds the test that proves it.
- **G34 — a provider declares which post types expire, and how long they live.**
  `insights.declaration.ephemeralPostTypes?: readonly { postType, lifetimeMs }[]`; Instagram declares
  `story` with a 24-hour lifetime. The pure schedule function reads the declaration — an ephemeral target
  is polled on the dense first-band cadence from publication and never scheduled past
  `publishedAt + lifetimeMs`, freezing at that boundary with the new reason `expired`. The scheduler learns
  nothing about Instagram. Reversal: drop the field; every target then behaves as non-ephemeral again.
- **A story already expired when this entry lands is frozen, not captured once.** 080 grants a
  settled-but-never-polled target one catch-up capture so the panel is not empty on day one; for an expired
  story there is nothing left to read, so the catch-up would spend an allowance recording an error.
  Reversal: give expired targets the same one-time catch-up if Instagram's expiry proves softer in
  practice than documented.
- **`frozen_reason` gains `expired` through a migration**, rendered as "this story has expired; these
  numbers are final" beside whatever snapshots were captured while it lived. Reversal: the CHECK widens
  with one `DROP`/`ADD`, same as 080's own addition of `gone`.
- **Meta's budget is enforced from Meta's own answer, with a conservative declared floor underneath it.**
  Three layers: (1) the existing per-account reserve, unchanged; (2) a declared `readBudget` that is an
  explicit, conservative floor (Threads has a documented impression floor of 10, giving `4800 × 10`/24h;
  Pages and Instagram have no documented floor, so the same figure stands in, marked **interim,
  UNVERIFIED** in `docs/limits.md`); (3) the live `X-Business-Use-Case-Usage` signal, read on every Graph
  response, returning `rate_limited` with `retryAt` from `estimated_time_to_regain_access` when any of
  `call_count`, `total_cputime` or `total_time` reaches a configured ceiling. Layer 3 is what actually
  respects an impressions-based limit; layers 1 and 2 are the floor that holds when no header arrives.
  Reversal: drop layer 2's floor once a real figure is confirmed for Pages and Instagram (R5).
- **Graph codes 80001 and 80002 become rate-limited, because this entry is what makes them reachable.**
  Already fixed by commit `3a2626c`, as the research correction above records; kept here as the
  specification-time decision that would have made the fix if it had not already landed. Reversal: none —
  this is the correct, permanent classification.

### Post-design re-check

Seven points were re-examined after the design settled, each a judgement call with its own reversal.

1. **Facebook ships a smaller vocabulary than the roadmap asked for.** Its two headline metrics are
   deprecated names that now error, and the replacement cannot be confirmed from here (research §2).
   Declaring one anyway would have lost `post_clicks` too, because an invalid metric fails the whole call.
   Reversal: answer R2 in Graph API Explorer and add one line to `src/providers/facebook/insights.ts`.
2. **`optionalScopes` is on the group and `requiredScopes` on the provider** — confirmed by the code:
   `authorizationUrl` is built by the group, and the Meta group backs two providers with different needs
   from a single consent. Reversal: see G32 above.
3. **Whole-list rejection, not per-element filtering, on a grant Docket cannot fully parse.** Filtering
   would keep the good entries from a reply Docket evidently misunderstood, and could leave an account
   *eligible* on the strength of a list that also contained a secret. Rejecting leaves `NULL`, which reads
   as "needs a reconnect" — honest and recoverable; the connect itself still succeeds, because a grant
   Docket cannot record is not a reason to refuse a working connection. Reversal: filter per element if a
   future provider's reply shape can be trusted to isolate the bad entries safely.
4. **A new `postPollDecision` beside an unchanged `nextPostPollAt`.** FR-043 requires 080's schedule tests
   to pass untouched, and the cheapest guarantee is not to edit the function they test. The caller needs a
   *reason*, not only a date, so the wrapper returns a discriminated result. Reversal: fold the reason into
   `nextPostPollAt`'s own return type once 080's tests can be safely rewritten alongside it.
5. **`targetsUnqueryable` is counted from a read result, not from SQL.** Telling a Page post id from a
   Reel's video id is Facebook's own knowledge; a `LIKE` in the generic claim would teach the DAL one
   platform's id format, which constitution V forbids. The cost is one claim per such target, once, before
   it freezes terminally. Reversal: move the check into SQL if a future entry needs it cheaper and is
   willing to leak Facebook's id format into the shared claim.
6. **The declared Meta read budget binds nothing on its own, and this is written down** rather than left
   for a reviewer to discover. 48,000 reads/24h is three orders of magnitude above anything the section
   ever attempts (`INSIGHTS_TARGETS_PER_RUN` is 50, Instagram's `maxPostsPerRead` is 1), so `reserveFloor`
   on that number is never reached; the real protection is the live header (layer 3) and the per-account
   reserve (layer 1). A smaller invented floor would be a fiction with the same shape, so the honest number
   ships with the honest caveat in `docs/limits.md` and here instead. Reversal: replace the floor once R5
   is answered.
7. **Two pre-existing defects are fixed in passing, both made reachable by this entry.** The per-read
   `unavailable` arm never advanced `next_poll_at`, so it would have re-claimed every tick forever; and a
   target frozen after an earlier failure would render as a permanent failure, because the panel checks
   `consecutiveFailures` before the freeze reasons. Both were unreachable in 080 and both become live here,
   so both belong to this entry rather than a later one. Reversal: none — these are corrections, not
   choices.

Three things the design deliberately does **not** fix, so review does not re-open them: `fatal_error`
retries for 28 days rather than stopping (research §5.3 — visible and actionable, and a fifth result kind
is entry 4's business); the Facebook `ANALYZE`-task precondition is invisible to `granted_scopes`, so
eligibility answers "may Docket call?" and never "will Docket get numbers?" (research §2 — an empty answer
correctly renders as 080's `nothing_reported`); and repairing Facebook's stored external id for Reel
targets, which no entry owns.

## Flake-proof test architecture: pre-change baseline (2026-10-17)

Spec 079's success criteria (SC-002, SC-004, SC-007) are each a before/after comparison. Recorded here
before any code in this feature changes, so the comparison has a fixed starting point:

1. **Slowest CI shard wall-clock time: 304 s** (run `39036348302`; shard times 5:04/4:45/3:50/4:38). The
   SC-007 comparison point — Phase 10's final verification must come in at or under ~334 s (10%
   allowance) on the gating CI run.
2. **`parkAll*` call-site count: 150 files, 311 call sites** —
   `grep -rln "parkAll" --include='*.ts' --include='*.tsx' src tests | wc -l` → 150;
   `grep -rn "parkAll" --include='*.ts' --include='*.tsx' src tests | wc -l` → 311. The SC-004
   comparison point — Phase 4 drives both counts to zero.
3. **`vitest.config.ts`'s `setupFiles` order**: `tests/setup/worker-db.ts` runs first, ahead of
   `tests/setup/scope-recorder.ts` and `tests/setup/webhook-loopback.ts`. `tests/setup/reset-database.ts`
   (Phase 4) must be inserted immediately after `worker-db.ts` and before `scope-recorder.ts` — the
   ordering invariant R2 depends on this being true before the new file is added.

**Addendum (2026-10-18).** Items 1 and 3 stand as recorded. Item 2's target does not: `parkAll*` grew
rather than went to zero. `claimRefreshAccounts` turned out to have the same squeeze the engagement and
insights claims had — cross-project, ordered by a timestamp every test sets to roughly the same hour,
capped at five — so `parkAllRefreshAccounts` was added beside the others, which also absorbed four
hand-rolled copies of that same `UPDATE` in the pinterest, threads, tiktok and x refresh tests. The
`drainTicks` direction in this spec and the parking direction now on `main` point opposite ways; the
baseline is kept here because the measurements are still the right ones to compare against, not because
Phase 4 is still the plan. See the note on PR #141.

## 082 — TikTok and Pinterest numbers, and a priced opt-in for X (2026-10-18)

- **`PINNER_DATA_ACCESS_DENIED` is matched by a message token, a deliberate, narrow exception to the
  publishing path's "status only, never a numeric code" rule.** Every other reader in this codebase,
  publishing included, classifies a platform's refusal by HTTP status alone, because a numeric or string
  `code` is not documented to be stable and matching on one has previously meant guessing at an
  undocumented contract. Pinterest's `PINNER_DATA_ACCESS_DENIED` is different: it is the one documented
  way to tell "this account needs a business account with pinner-data access" (a stated, actionable
  reason, never flagging the account) apart from any other HTTP 403 (a generic `fatal_error`), and
  Pinterest ships no other signal for the distinction — not a separate status code, not a response
  header. The match lives in exactly one place, `src/providers/pinterest/insights.ts`, is read once per
  call, and is never reused for publishing's own 403 handling, which stays status-only. Reversal: if
  Pinterest ever starts returning a dedicated status or header for this refusal, drop the message match
  for that signal and keep the rest of the status table unchanged.
- **Pinterest's pin-analytics window always requests the full allowed 90 days, because the reader is not
  given the pin's real publish date.** `pinterestAnalyticsWindow({ publishedAt, now })` is pure and
  unit-tested against an arbitrary `publishedAt`, but `PostMetricsReadContext` (G35) deliberately carries
  "nothing new" beyond `posts[].externalId` — adding a publish timestamp to every provider's context for
  one platform's one reader was judged not worth the shared-surface cost. `readPostMetrics` therefore
  calls the window function with a fixed, far-past `publishedAt`, which — because the function clamps to
  `end − 90 days` — always yields the widest allowed window ending today. This costs nothing: Pinterest
  simply reports no activity for days before a pin existed, so a wider-than-necessary window never
  invents a number. Reversal: if a later entry plumbs a real publish date into the shared context for
  some other reason, pass it through here too for a tighter window on young pins.
- **G35 — a declared identifier source, because TikTok's publish result returns the wrong id for
  reading numbers back.** `postIdSource: "externalId" | "publicPostId"` on an `insights` declaration
  says which stored column a provider's post reader needs; the post claim requires that column
  non-null in its own SQL, so a target without one is never claimed, leased or decrypted for — it is
  instead inserted already frozen `unqueryable` with zero calls spent. Default is `"externalId"`,
  so Bluesky, Instagram, Facebook and Threads are unaffected. Reversal: drop the field and the column
  check if TikTok ever starts returning a usable video id from the publish call itself.
- **G36 — `publicPostId` on `StepResult`'s `{ kind: "done" }`, persisted by the generic publish
  path.** The only write path for `post_targets.public_post_id` going forward, parallel to how
  `externalId` and `url` already travel on the same result; no scheduler or engine code names
  TikTok. A one-off migration backfill (`drizzle/0044_*.sql`) recovers the id for targets published
  before this column existed, from `publish_attempts.response_summary.publicPostIds` wherever
  attempt retention still holds it. Reversal: drop the field if a future provider's post reader can
  always use `externalId` instead.
- **G37 — per-surface eligibility, replacing G33's one set of scopes for both surfaces.** Pinterest
  needs `pins:read` for pins and nothing new for the account; TikTok needs `video.list` for posts
  and `user.info.stats` for the account; X declares no account metrics at all. `postScopes`/
  `missingPostScopes` and `accountScopes`/`missingAccountScopes` replace the single
  `requiredScopes`/`missingScopes` pair, each checked by its own claim's SQL predicate. An account
  missing either surface's scopes is still counted exactly once by `accountsSkippedNoPermission`,
  not once per surface. Reversal: collapse back to one shared scope set if a future review judges
  the per-surface split not worth the extra declaration fields.
- **FR-050's four new columns (`unavailable_reason`/`unavailable_docs_path` on both poll-state
  tables) over inferring "unavailable" from `last_error` plus `consecutive_failures = 0`.** That
  inference is exactly the shape the `unqueryable` freeze already uses for a different reason, so
  reusing it for a run-time `unavailable` would make the two indistinguishable on screen — a member
  would see the same "not read yet, and will not be" wording for "this post's id cannot be queried"
  and "Pinterest needs a business account", which are different, actionable messages. A run-time
  `unavailable` a reader returns is instead persisted at commit time and cleared on the next success
  or freeze, so it survives a page reload rather than being recomputed from scratch. Pinterest's
  `PINNER_DATA_ACCESS_DENIED` is the first reader this matters for in practice: the account is never
  flagged, but the post surface's stated reason now holds between ticks. Reversal: drop the two
  columns and fall back to the inference if a later review finds the distinction not worth the
  schema cost.
- **X's read ceiling defaults to 8000 reads per account per 30 days (`X_INSIGHTS_READ_CEILING`),
  realising to 4,000 after the publishing reserve — about $4.00/month at the confirmed $0.001 Owned
  Read rate.** The opt-in itself (`X_INSIGHTS_ENABLED`, default `false`) is the bigger decision —
  no existing install starts spending money it did not ask for — but the ceiling needed a concrete
  starting number rather than an unbounded one, and 8000 is the figure `docs/x-setup.md`'s worked
  estimate is built from. Reversal: raise or lower the default once an operator's real usage pattern
  suggests a different starting point; the env var already makes it a one-line change with no code
  edit.
## Making CI flakes legible: four hunts, two real bugs (2026-10-18)

The flake hunt (spec 079 US1, `.github/workflows/flake-hunt.yml`) became usable and was run four
times, 20 repetitions x 4 shards each, with shuffled file order. What it changed is not the number of
flakes but the *method*: before, a flake was discovered one red CI run at a time and fixed by
hypothesis; now it is measured, and the measurement names a rate.

**Two of the four fixes were real product bugs, not test artefacts.**

1. **`engagement_drafts_decision_names_person` vs `ON DELETE SET NULL` (23514).** The check required
   `reviewed_by_user_id IS NOT NULL` once a draft was decided, while the foreign key set that column
   null when the user went away. The two rules contradicted each other, so **a user who had ever
   approved or rejected an engagement draft could not be deleted at all** — every user-deletion path
   hit 23514. Present since migration 0036. Fixed by requiring `reviewed_at` and letting the reviewer
   be unknown, which is how the other 38 actor columns in this schema already behave. Audited: across
   38 `SET NULL` foreign-key columns and 44 `NOT NULL` checks this was the only contradicting pair.

2. **Overlapping queries on one transaction client.** `services/posts/index.ts` ran
   `Promise.all(targets.map(...))` over a single drizzle transaction, i.e. N concurrent queries on one
   pooled client; `services/queue/index.ts` did it twice. node-postgres queues the second and warns,
   and pg@9 will make it an error.

**Why the first one took four hunts.** Its cause was discarded twice over, independently: vitest's
JSON reporter serialises `failureMessages` (message plus stack) and **drops `error.cause`**, which is
where drizzle puts the Postgres error; and the lane stderr never sees failures at all, because
`--reporter=json --outputFile=` writes them to the file. For three hunts the only recorded fact was
`Failed query: delete from "user"`. `withDbCause` (tests/helpers/db.ts) folds the pg fields into the
`message`, which is the part that survives serialisation, and the next hunt named the constraint.

The general lesson, and the one worth keeping: **a diagnostic that is not in the `message` does not
exist.** Three separate layers here defaulted to discarding the cause — the reporter, the stderr
routing, and a 2000-byte stderr window that 80 repetitions had filled with nothing but a deprecation
warning.

**The hunt's rates are not the gate's rates.** The hunt passes `--sequence.shuffle.files`; the gate
does not. `secret-scan` failed 8 to 11 of 20 hunt repetitions and *never once* failed a real gate run,
because it needs a file that leaves a decided draft behind to be shuffled ahead of it on the same
worker database. Order-dependence is worth fixing — it found a genuine bug here — but it should not be
ranked by hunt rate when deciding what is blocking merges.

**Two test-only fixes, both root-caused rather than retried.** The email tick's long-standing
`{claimed: 500, sent: 499, skipped: 1}` was an `immediate`-cadence person, already sent to, being
re-claimed because `nextDue` returns `now` for that cadence — tying exactly with the one seeded person
whose own `next_due_at` was `now`, which is why every sighting named index 0. And
`project-brand.test.ts` ordered two concurrent writers by `created_at`, which ties, is stamped at
transaction start rather than at commit, and had no `ORDER BY` to break the tie.

**Still open.** Three of `scheduler/refresh.test.ts`'s five tests flake at about 1 in 20 with three
different symptoms, which points at one cause: the refresh section intermittently processing nothing.
Budget starvation, provider-registry timing and connection-pool saturation have each been tested and
ruled out (pool saturation down to `DATABASE_POOL_MAX=2`, six shuffled local runs). All five
assertions now carry the section counts, so the next occurrence should name it.

**Left alone deliberately.** `nextDue` returning `now` for `immediate` cadence means every such
subscriber is claimed, assembled and released on *every* tick for as long as they stay subscribed,
burning the email section's per-tick claim budget on no-ops. That is the scheduling contract
(E12, FR-016 to FR-020) and wants a decision, not a drive-by change.

## 083 — G38, the shape every metric needs before it can be plotted (2026-10-18)

- **`shape` on `MetricKeyDeclaration` is required, not optional, and is a discriminated union, not a
  `windowSeconds?: number`.** Required so a provider added later cannot declare a key without a
  shape — enforced by `tsc`, not a lint rule or registry test anyone could forget. A discriminated
  union because `unknown`'s reason string (rendered where the series would be, FR-004) and
  `windowed`'s confirmed-or-not window length need different payloads; an optional
  `windowSeconds` with "absent means cumulative" would make absence mean both "cumulative" and
  "nobody classified this yet", which is exactly the distinction FR-001 exists to make. Reversal:
  none anticipated — the compiler gate is the point.
- **Three keys are classified `unknown`, and classifying them changed no request.** Facebook's
  `page_follows` (period "not stated") and `page_post_engagements` (period one of day/week/28-days,
  and Docket's reader pins none of them), and Pinterest's `monthly_views` (no source states a
  window at all). The fix for each — pinning a `period` on Facebook's account read, or Pinterest
  documenting its window — is a reader change that belongs to a later entry; FR-005 forbids making
  it here. The practical cost, stated in `docs/insights.md`: Facebook Pages get no account trend at
  all, and Pinterest gets a follower trend but no monthly-views trend.
- **`mock` keeps all five of its keys `cumulative`, unchanged.** FR-005 forbids changing any
  provider's declared keys, and reclassifying one of `mock`'s three post or two account keys would
  silently redefine a fixture other suites already assert against. The `windowed` and `unknown`
  code paths are instead exercised through Instagram, Facebook and Pinterest's real declarations in
  integration fixtures, and through synthetic declarations in unit tests — every pure function in
  this entry takes a declaration as an argument, so a unit test can hand it any shape with no
  provider involved.
