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

- **FR-007, app password never stored.** `connectAccount` exchanges handle + app password for a session and stores only the session tokens, DID and handle (encrypted). The password is not kept anywhere, so "Needs reconnecting" means entering one again.
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
- **R1–R10 are interim values, UNVERIFIED against the live API** (text limits 10,000/2,200; Facebook photos JPEG/PNG, 8,000,000 bytes, at most 10; Graph error table incl. 190 invalid token and 4/17/32/613 rate limits; `config_id` replaces `scope` when `META_LOGIN_CONFIG_ID` is set; `content_publishing_limit` read as `quota_usage`/`config.quota_total`; app secret proof not sent; dialog and exchange URLs; `/me/accounts` limit 100, at most 4 further pages; POST bodies form-encoded, GET tokens in the query and stripped from anything logged). Each lives in one constant, and none is reported as working.
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
- **R1–R10 are interim values, UNVERIFIED against the live API** (`docs/research/meta.md` has no entry for them; each is one constant with mocked tests). R1 `v1.0` on publishing, profile, status and quota paths, none on the token paths. R2 `GET /me?fields=id,username`. R3 code exchange, `th_exchange_token` and `th_refresh_token` shapes; 60 days assumed when `expires_in` is unreadable. R4 the shared Meta error table. R5 carousel parameters, only the parent is status-checked. R6 container life assumed 24 h. R7 `threads_publishing_limit` read defensively; unknown never blocks. R8 `https://docket.local:3000/connect/callback`, with a 443 fallback and the base address for uninstall/delete fields; no such endpoint is built. R9 the emoji rule below. R10 no permalink; only the post id is kept.
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
