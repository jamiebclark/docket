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
- Webhook delivery: 8 attempts, backoff 1 min doubling to 6 h, 10 s timeout, disabled after 20 failed deliveries, 30-day log, 10 deliveries per tick at concurrency 4: `WEBHOOK_DEFAULTS` in `src/server/scheduler/config.ts`. Secret rotation overlap 24 h: `ROTATION_OVERLAP_MS` in `src/server/services/webhooks/endpoints.ts`. Signature tolerance 300 s: `SIGNATURE_TOLERANCE_SECONDS` in `src/server/services/webhooks/sign.ts`.
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
