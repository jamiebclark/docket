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
