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
