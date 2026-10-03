---

description: "Task list for Docket Foundation — accounts, projects, members, invitations and project isolation"
---

# Tasks: Docket Foundation — Accounts, Projects, Members, Invitations and Project Isolation

**Input**: Design documents from `/specs/001-foundation-auth-projects/`

**Prerequisites**: plan.md, spec.md, research.md (D1–D18, F1–F17, U1–U3), data-model.md, contracts/ (env, routes, server-actions, dal, internal-interfaces), quickstart.md

**Tests**: REQUIRED. FR-038 and the quickstart list the mandatory suites; test tasks are written before the code they cover.

**Organization**: Tasks are grouped by user story. Story order follows the spec: US1–US3 and US6 are P1, US4–US5 are P2.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1…US6, matching spec.md
- Paths are relative to the repository root.

## Conventions for the implementing process (headless)

- The implementation process has **no browser, no network, no `curl`**. Every check below is a Vitest test, a `tsc`/ESLint/build run, or a Node script. UI behaviour is covered by extracting pure logic into modules that Vitest can run (the test environment is `node`; do **not** add jsdom, Playwright or any other dependency — constitution VI).
- Integration tests use a real Postgres from `TEST_DATABASE_URL ?? DATABASE_URL` (db name must end `_test`). If no Postgres is reachable in the sandbox, say so in the task note; do not tick DB-backed tests as passing.
- Read the installed docs before writing Next.js code (`node_modules/next/dist/docs/`, per AGENTS.md) and the installed `better-auth` / `drizzle-orm` types before using their APIs (constitution I).
- Commit per task or tight group, explicit paths only, Conventional Commits.
- Run `pnpm lint`, `pnpm typecheck` and the touched tests before ticking a task.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Dependencies, scripts and config files every later task assumes.

- [ ] T001 🛑 BLOCKED: pnpm cannot reach registry.npmjs.org from this sandbox (TLS error); run `pnpm add` by hand. Add exact-pinned runtime deps `better-auth@1.7.7`, `@better-auth/drizzle-adapter@1.7.7`, `drizzle-orm@0.45.3`, `pg@8`, `zod@4.6.5` and dev deps `drizzle-kit@0.31.11`, `@types/pg` to `package.json`; run `pnpm install` so `pnpm-lock.yaml` updates (plan: Technical Context, research "Dependencies added")
- [x] T002 Add scripts `db:generate` (`drizzle-kit generate`), `db:migrate` (`drizzle-kit migrate`, using the direct URL via `drizzle.config.ts`; research D14/D15) and `db:check` (`node scripts/check-migrations-current.mjs`) to `package.json`
- [x] T003 [P] Create `drizzle.config.ts` (schema `./src/server/db/schema`, out `./drizzle`, dialect postgresql, url = `DATABASE_URL_DIRECT ?? DATABASE_URL`; must NOT require any other secret so CI with only `DATABASE_URL` works — plan note 3)
- [x] T004 [P] Create `.env.example` documenting every variable in `contracts/env.md` (purpose, required?, format, safe example or `openssl rand -base64 32` hint — FR-002)
- [x] T005 [P] Update `vitest.config.ts`: add `globalSetup: tests/setup/global-setup.ts`, `setupFiles: tests/setup/scope-recorder.ts`, and `test.env` with fixed fake `BETTER_AUTH_SECRET`, `CREDENTIALS_ENCRYPTION_KEY`, `BETTER_AUTH_URL=http://localhost:3000`; keep the `@` alias; run integration files serially (`fileParallelism: false` or per-file DB isolation per T016)
- [x] T006 [P] Update `next.config.ts`: add `outputFileTracingIncludes` so `drizzle/**` is traced into the standalone output (research F16, plan note 5)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Config, database, test harness, crypto, auth wiring, scoped DAL core, shared UI primitives. No user story starts until this phase is done.

**⚠️ CRITICAL**: Everything in US1–US6 depends on this phase.

### Config and database

- [x] T007 [P] Write failing unit test `src/server/env.test.ts`: `parseEnv` returns every issue (not just the first) by variable name + reason; never echoes values; `BOOTSTRAP_ADMIN_EMAIL`/`PASSWORD` must be set together; defaults for `DATABASE_URL_DIRECT`, `DATABASE_POOL_MAX`, `INVITATION_TTL_DAYS=7`, `MIGRATE_ON_START=true`, `BOOTSTRAP_ADMIN_NAME=Admin`; key accepts 32-byte base64 or hex only
- [x] T008 Implement `src/server/env.ts` (`parseEnv` pure, lazy memoised `getEnv`, never evaluated at import so `next build` works without secrets) per `contracts/env.md`; makes T007 pass
- [x] T009 [P] Write validation unit tests `src/lib/validation/validation.test.ts`: email (trim/lowercase/≤254), password 12–128, person name 1–100, project name 1–80, slug rules + reserved words (`new`, `settings`, `api`, `setup`, `login`, `signup`, `invitations`, …), IANA time zone (accepts `Europe/London`, `Asia/Kolkata`, `UTC`; rejects `+02:00`, `Foo/Bar`, free text — research F17/D17), role, policies, token (43-char base64url)
- [x] T010 Implement shared Zod schemas in `src/lib/validation/{email,password,name,slug,timezone,role,policies,token}.ts` plus `index.ts`; makes T009 pass
- [x] T011 [P] Create `src/lib/action-result.ts` (`ActionResult<T>`, `ErrorCode` union exactly as in `contracts/server-actions.md`, helpers `ok()`/`fail()`), and `src/lib/safe-redirect.ts` (same-origin relative-path-only `next` check) with unit test `src/lib/safe-redirect.test.ts` rejecting `//evil.com`, `https://…`, `\\`, and non-paths
- [ ] T012 🛑 BLOCKED: needs drizzle-orm/pg/better-auth (T001 blocked, no registry access) — Hand-write Drizzle schema in `src/server/db/schema/auth.ts` (`user`, `session`, `account`, `verification`, `organization`, `member`, `invitation` exactly per data-model.md incl. +D constraints: role checks, `(organization_id,user_id)` unique, partial unique pending-invite index; `uuid` ids with `gen_random_uuid()`; `timestamptz`), `projects.ts` (+ enums `approval_policy`, `scheduling_policy`), `invitations.ts` (`invitation_tokens` + partial unique active-token index), `audit.ts` (`membership_action` enum, `membership_audit_log`, index `(project_id, created_at desc)`), `install.ts` (`install_state` singleton check `id = 1`), and `index.ts` re-exporting all (data-model.md, research D3/D9/D10)
- [ ] T013 🛑 BLOCKED: needs drizzle-orm/pg/better-auth (T001 blocked, no registry access) — Implement `src/server/db/client.ts` (`pg.Pool` sized by `DATABASE_POOL_MAX`, `drizzle(pool, { logger })` where the logger forwards `(sql, params)` to an exported `queryObservers` set — empty in production — and never prints params; captures `crossProjectReason` from an `AsyncLocalStorage`) and `src/server/db/migrate.ts` (`runMigrations(url)` using `drizzle-orm/node-postgres/migrator` with `./drizzle`; no advisory locks — research F13/F14)
- [ ] T014 🛑 BLOCKED: needs drizzle-orm/pg/better-auth (T001 blocked, no registry access) — Generate the initial migration with `pnpm db:generate` into `drizzle/` (commit SQL + `meta/`); add the CHECK constraints and partial indexes by hand-editing the generated SQL only if drizzle-kit cannot express them, then confirm `pnpm db:generate` produces no further diff
- [ ] T015 [P] 🛑 BLOCKED: needs drizzle-orm/pg/better-auth (T001 blocked, no registry access) — Implement `scripts/check-migrations-current.mjs` (D15): run `drizzle-kit check`, then `drizzle-kit generate` into a temp dir and fail if it would emit any new migration; wire as `pnpm db:check`; run it and confirm exit 0
- [ ] T016 🛑 BLOCKED: needs drizzle-orm/pg/better-auth (T001 blocked, no registry access) — Implement test harness: `tests/setup/global-setup.ts` (refuse unless db name ends `_test`; create DB if missing; drop/recreate schema; run `runMigrations`), `tests/helpers/db.ts` (test client, `createThrowawayDb()` for empty-install tests), `tests/helpers/factories.ts` (unique-per-test users, projects, members via the services/DAL), `tests/helpers/auth.ts` (fake session builder)
- [ ] T017 🛑 BLOCKED: needs drizzle-orm/pg/better-auth (T001 blocked, no registry access) — Check research **U1** early: add `tests/integration/auth-schema.test.ts` that boots the Better Auth instance (after T024) against the migrated schema and performs one `auth.api` call; if the runtime schema check rejects `timestamptz`, switch only the Better Auth tables to `timestamp` in `src/server/db/schema/auth.ts`, regenerate the migration, and record the outcome in `docs/decisions.md` (depends on T024)

### Scope check and registry (constitution III)

- [ ] T018 [P] 🛑 BLOCKED: needs drizzle-orm/pg/better-auth (T001 blocked, no registry access) — Create `src/server/db/project-owned.ts` with the six registry entries and `notProjectOwned` list (`user`, `session`, `account`, `verification`, `install_state`) per `contracts/dal.md`, plus `src/server/db/project-owned.test.ts` asserting every Drizzle table in `src/server/db/schema/` is in exactly one list
- [x] T019 [P] Write failing unit tests `tests/helpers/scope-check.test.ts` for `checkScope`: pinned select/update/delete pass; `in (…)`, range, `or` fail; join pinned by scope-column equality passes; insert needs scope column in its list; quoted identifiers; raw `sql` statements; `crossProjectReason` records skipped and counted; failure message matches `Unscoped query on project-owned table "member" (needs …)`
- [ ] T020 🛑 BLOCKED: needs drizzle-orm/pg/better-auth (T001 blocked, no registry access) — (PARTIAL: `tests/helpers/scope-check.ts` done and T019 passes; `tests/setup/scope-recorder.ts` still owed, needs T013 client) Implement `tests/helpers/scope-check.ts` (`checkScope(records, projectOwnedTables)`) and `tests/setup/scope-recorder.ts` (registers observer, clears `beforeEach`, runs `checkScope` in `afterEach`, prints summary of checked and cross-project queries); makes T019 pass

### Secrets and tokens (FR-007, FR-008, FR-026)

- [x] T021 [P] Write failing tests `src/server/crypto/secrets.test.ts`: round trip incl. empty string and multibyte; ciphertext differs per call; tamper of each part; wrong key; unknown `v2`; unknown kid; AAD mismatch; error `message`/`cause`/`stack` contain no plaintext, key or ciphertext; module never logs
- [x] T022 [P] Write failing tests `src/server/crypto/tokens.test.ts`: `generateInvitationToken` yields 43-char base64url and a 64-char hex SHA-256 that equals `hashInvitationToken(token)`; `isWellFormedToken` accepts/rejects correctly; `invitationUrl` is `${BETTER_AUTH_URL}/signup?token=…`
- [x] T023 Implement `src/server/crypto/secrets.ts` (`enc:v1:<kid>:<iv>:<tag>:<ct>`, `SecretDecryptionError`, key from `getEnv().CREDENTIALS_ENCRYPTION_KEY`) and `src/server/crypto/tokens.ts` per `contracts/internal-interfaces.md`; makes T021/T022 pass

### Auth wiring and DAL core

- [ ] T024 🛑 BLOCKED: needs drizzle-orm/pg/better-auth (T001 blocked, no registry access) — Implement `src/server/auth/access.ts` (`createAccessControl` statements from data-model "Permission statements"; roles `owner`, `admin`, `editor`) with unit test `src/server/auth/access.test.ts` asserting the full FR-021 matrix via `role.authorize`
- [ ] T025 🛑 BLOCKED: needs drizzle-orm/pg/better-auth (T001 blocked, no registry access) — Implement `src/server/auth/auth.ts` (betterAuth config from `contracts/internal-interfaces.md`: drizzle adapter `transaction: true`, `generateId: "uuid"`, email/password 12–128, `rateLimit.enabled: true`, `hooks.before` middleware returning **400** `{ message: "Sign-up requires an invitation" }` for `/sign-up/email` and **404** for `/organization/*`, organization plugin with `ac`/roles, `nextCookies()` last) and `src/server/auth/session.ts` (`getSession()`/`requireSession()` cached per request); verify option names against the installed package types first (research D2, F4–F6, F11, F12)
- [ ] T026 🛑 BLOCKED: needs drizzle-orm/pg/better-auth (T001 blocked, no registry access) — Create `src/app/api/auth/[...all]/route.ts` (`toNextJsHandler(auth)`) and `src/app/api/health/route.ts` (`select 1` through the DAL → `200 {"ok":true}` / `503 {"ok":false}`), with `src/server/dal/health.ts`
- [ ] T027 🛑 BLOCKED: needs drizzle-orm/pg/better-auth (T001 blocked, no registry access) — Implement `src/server/dal/errors.ts` (`NotFoundError`, `ForbiddenError`, `ConflictError`, `LastOwnerError`, `InvitationInvalidError`, `EmailMismatchError`, `SetupUnavailableError`) and `src/server/dal/scope.ts`: `crossProject(reason, fn)` (AsyncLocalStorage), `forProject(session, slug)` (single `projects ⋈ member` query, `NotFoundError` for no session/unknown slug/non-member), `requireRole`, `requirePermission`, `scope.can`, and `scope.transaction(fn, { lockProject })` (`SELECT … FROM projects WHERE id = $1 FOR UPDATE`, membership re-check inside the tx) per `contracts/dal.md`; repositories are attached by later tasks
- [ ] T028 [P] 🛑 BLOCKED: needs drizzle-orm/pg/better-auth (T001 blocked, no registry access) — Implement `src/server/dal/index.ts` exporting only the sanctioned surface, and the ESLint `no-restricted-imports` block in `eslint.config.mjs` (paths `pg`, `drizzle-orm/node-postgres`; patterns `@/server/db`, `@/server/db/*`, `**/server/db`, `**/server/db/**`; exempt `src/server/{dal,db,auth,startup}/**` and `tests/**`; message "Import the scoped DAL (`@/server/dal`) instead of the database client."); run `pnpm lint` to confirm the tree is clean
- [ ] T029 [P] 🛑 BLOCKED: needs drizzle-orm/pg/better-auth (T001 blocked, no registry access) — Implement `src/server/services/audit.ts` and `src/server/dal/audit.ts` (insert + list only; no update/delete; details never carry tokens/URLs/passwords) and wire `scope.audit`

### Shared UI primitives (docket-ui skill)

- [x] T030 [P] Read the `docket-ui` skill, then create `src/components/ui/{Button,Field,Select,Dialog,Badge,Table,CopyField,EmptyState}.tsx` (labelled controls, inline `aria-live` errors via `aria-describedby`, visible focus, confirm `Dialog` using native `<dialog>` with focus trap/restore, `CopyField` with copy button and status announcement); server components by default, `"use client"` only where interactive
- [x] T031 [P] Update `src/app/layout.tsx` (skip link, `metadata.title.template` `"%s · Docket"`) and add `src/app/not-found.tsx`; keep system font stack (decision 16)

**Checkpoint**: `pnpm lint && pnpm typecheck && pnpm db:check && pnpm test` pass; foundation ready.

---

## Phase 3: User Story 1 — Start Docket and create the first account (Priority: P1) 🎯 MVP

**Goal**: One-command start; first account via bootstrap env or one-time `/setup`; login/logout; startup fails loudly on bad config.

**Independent Test**: `tests/integration/bootstrap.test.ts` + `tests/integration/auth-endpoints.test.ts` pass; `docker compose config` validates.

### Tests for User Story 1 ⚠️ (write first, see them fail)

- [ ] T032 [P] [US1] 🛑 BLOCKED: needs better-auth/drizzle-orm/pg/zod (T001 blocked, no registry access) — `tests/integration/bootstrap.test.ts` on a throwaway DB: setup available only while zero users and no `install_state`; concurrent `createFirstUser` ×2 → exactly one success, loser gets `setup_unavailable`; env bootstrap creates the account then is skipped when accounts exist (no reset of the password); invalid bootstrap email/password fails with the variable named; created user can sign in via `auth.api.signInEmail`
- [ ] T033 [P] [US1] 🛑 BLOCKED: needs better-auth/drizzle-orm/pg/zod (T001 blocked, no registry access) — `tests/integration/auth-endpoints.test.ts`: `POST /api/auth/sign-up/email` → 400 and no `user` row; `/api/auth/organization/*` → 404; 4th `sign-in/email` within 10 s → 429; wrong credentials give the generic `INVALID_EMAIL_OR_PASSWORD` for both unknown email and wrong password (call the route handlers directly with `Request` objects; no network)
- [ ] T034 [P] [US1] 🛑 BLOCKED: needs better-auth/drizzle-orm/pg/zod (T001 blocked, no registry access) — `src/server/startup/startup.test.ts`: `runStartup` with a bad env prints every offending variable name, contains none of the values, and calls `process.exit(1)` (inject exit); with `MIGRATE_ON_START=false` skips migration; migration failure logs a fixed message and exits 1

### Implementation for User Story 1

- [ ] T035 [US1] 🛑 BLOCKED: needs better-auth/drizzle-orm/pg/zod (T001 blocked, no registry access) — Implement `src/server/dal/install.ts` (`isSetupAvailable`, `bootstrapFirstUser` — one transaction: insert `install_state` singleton (conflict ⇒ unavailable), `user` (lowercased email), credential `account` with Better Auth's `hashPassword`; all in `crossProject("install")` — research D4/D13)
- [ ] T036 [US1] 🛑 BLOCKED: needs better-auth/drizzle-orm/pg/zod (T001 blocked, no registry access) — Implement `src/server/services/setup.ts` (`isAvailable`, `createFirstUser`) and `src/server/startup/index.ts` (`runStartup`: env → migrate with `DATABASE_URL_DIRECT ?? DATABASE_URL` → bootstrap from env; logs "created"/"skipped (accounts exist)", never the password) and `src/instrumentation.ts` (Node runtime only); makes T032/T034 pass
- [ ] T037 [P] [US1] 🛑 BLOCKED: needs better-auth/drizzle-orm/pg/zod (T001 blocked, no registry access) — `src/app/login/page.tsx` + `src/app/login/login-form.tsx` (client; posts via `src/lib/auth-client.ts` to `/api/auth/sign-in/email`; generic failure message; safe `next` redirect; signed-in visitors redirected to `/`) and `src/lib/auth-client.ts`
- [ ] T038 [P] [US1] 🛑 BLOCKED: needs better-auth/drizzle-orm/pg/zod (T001 blocked, no registry access) — `src/app/setup/page.tsx` + `src/app/setup/actions.ts` (`completeSetup` → `setup.createFirstUser`, sign in via `auth.api`, redirect `/p/new`; unavailable ⇒ redirect `/login`)
- [x] T039 [US1] `src/proxy.ts`: optimistic session-cookie check redirecting to `/login?next=<path>` for every path except `/login`, `/setup`, `/signup`, `/api/auth/*`, `/api/health`, static assets (FR-013); read the installed `proxy.md` docs first (Done: pure logic in `src/lib/auth-gate.ts` + unit test; session cookie checked by name, since `better-auth/cookies` is not installable)
- [ ] T040 [US1] 🛑 BLOCKED: needs better-auth/drizzle-orm/pg/zod (T001 blocked, no registry access) — Sign-out: `signOut` action in `src/components/shell/actions.ts` (`auth.api.signOut({ headers })` → `/login`)
- [x] T041 [US1] `docker-compose.yml` (postgres:17 with healthcheck + named volume; `web` built from the existing Dockerfile image `docket:local`, `depends_on: service_healthy`, `env_file: .env`, `DATABASE_URL` overridden to the compose postgres, `BETTER_AUTH_URL` default `http://localhost:3000`, `${BETTER_AUTH_SECRET:?…}`/`${CREDENTIALS_ENCRYPTION_KEY:?…}`; **no worker service**) and `Dockerfile` edit to `COPY --from=build … /app/drizzle ./drizzle` in the runner stage; validate with `docker compose config` if Docker is installed, otherwise note that it could not be run (Done: `docker compose config` validated; missing secrets fail loudly)
- [ ] T042 [US1] 🛑 BLOCKED: needs better-auth/drizzle-orm/pg/zod (T001 blocked, no registry access) — full lint/typecheck/test/build cannot pass until deps are installed; zod-less typecheck errors in src/server/env.ts and vitest config references missing tests/setup files (T016/T020)

**Checkpoint**: US1 independently testable via tests; stack definition committed.

---

## Phase 4: User Story 2 — Create projects and hop between them (Priority: P1)

**Goal**: Create projects, project shell with nav + placeholders, keyboard switcher, root redirect with last-project memory.

**Independent Test**: `tests/integration/projects.test.ts` and `src/components/shell/switcher-logic.test.ts` pass.

### Tests for User Story 2 ⚠️

- [ ] T043 [P] [US2] 🛑 BLOCKED: needs drizzle-orm/pg/better-auth (T001 blocked, no registry access) — `tests/integration/projects.test.ts`: `projects.create` inserts `organization` + `projects` (same id) + `member(owner)` in one transaction with defaults `review_required`/`leave_as_draft`; duplicate slug → `conflict` on `slug` and nothing written; invalid slug/time zone/name → `validation` with field errors; `listMine` returns only the caller's projects ordered by name; two users never see each other's projects
- [ ] T044 [P] [US2] 🛑 BLOCKED: needs drizzle-orm/pg/better-auth (T001 blocked, no registry access) — `tests/integration/scope-resolution.test.ts`: `forProject` throws the **same** `NotFoundError` for non-member, unknown slug and old (renamed) slug; resolves role for members; `requireRole`/`requirePermission` throw `ForbiddenError`
- [x] T045 [P] [US2] `src/components/shell/switcher-logic.test.ts` and `src/app/root-redirect.test.ts`: pure functions for switcher filtering (case-insensitive on name and slug, "Create project" always last), highlight movement (↑/↓ wrap, clamp on empty list), Enter target selection, and root-redirect decision (last-project cookie if still a member → else earliest-joined → else `/p/new`)

### Implementation for User Story 2

- [ ] T046 [US2] 🛑 BLOCKED: needs drizzle-orm/pg/better-auth (T001 blocked, no registry access) — DAL: `src/server/dal/projects.ts` (create via a user-level transaction in `crossProject("create project")`, `get`, `listMine`) and `src/server/dal/members.ts` (base: find membership, insert owner member, list by project) and `src/server/dal/users.ts` (`listMyProjects`); attach `scope.projects`/`scope.members` in `scope.ts`
- [ ] T047 [US2] 🛑 BLOCKED: needs drizzle-orm/pg/better-auth (T001 blocked, no registry access) — `src/server/services/projects.ts` (`create`, `listMine`, `get`) per `contracts/server-actions.md`; makes T043/T044 pass
- [x] T048 [P] [US2] Implement `src/components/shell/switcher-logic.ts` (pure helpers from T045) and `src/app/root-redirect.ts` (pure decision function); makes T045 pass
- [ ] T049 [US2] 🛑 BLOCKED: needs drizzle-orm/pg/better-auth (T001 blocked, no registry access) — (PARTIAL: proxy cookie half done in src/proxy.ts + `lastProjectSlugFor` in src/lib/auth-gate.ts with tests; `src/app/page.tsx` redirect still needs `projects.listMine` and `decideRootRedirect` from src/app/root-redirect.ts) `src/app/page.tsx` ("/" redirect using `docket_last_project` cookie and `projects.listMine`, FR-018) and extend `src/proxy.ts` to set `docket_last_project` (`Path=/`, `SameSite=Lax`, `HttpOnly`, 1 year) on `/p/<slug>` and `/p/<slug>/…` but not `/p/new`
- [ ] T050 [P] [US2] 🛑 BLOCKED: needs drizzle-orm/pg/better-auth (T001 blocked, no registry access) — `src/app/p/new/page.tsx` + `actions.ts` (`createProject` → `projects.create` → redirect `/p/<slug>`; time zone pre-filled from the browser via a small client island; field errors beside fields)
- [ ] T051 [US2] 🛑 BLOCKED: needs drizzle-orm/pg/better-auth (T001 blocked, no registry access) — (components ready in src/components/shell; needs forProject) `src/app/p/[projectSlug]/layout.tsx` (calls `forProject` per request, `notFound()` on `NotFoundError`; top bar with switcher, invitations link with badge, user menu; left `<nav>` with Calendar, Posts, Compose, Generate, Jobs, Review, Media, Accounts, Voice, Settings and `aria-current="page"`), `page.tsx` (project home), `loading.tsx`, `error.tsx`, `not-found.tsx`
- [x] T052 [P] [US2] `src/components/shell/{ProjectSwitcher,LeftNav,InvitationBadge,UserMenu}.tsx` — `ProjectSwitcher` is a client component using the helpers from T048: modal dialog, `role="combobox"` + `listbox`/`option`, `aria-expanded`/`aria-controls`/`aria-selected`, Ctrl/⌘+K (respects `defaultPrevented`, calls `preventDefault`), focus in filter on open, Escape closes and restores focus
- [x] T053 [US2] `src/app/p/[projectSlug]/[section]/page.tsx`: placeholder "‹Screen› is coming in a later release." for `calendar|posts|compose|generate|jobs|review|media|accounts|voice`, `notFound()` otherwise; per-route titles
- [ ] T054 [US2] 🛑 BLOCKED: needs drizzle-orm/pg/better-auth (T001 blocked, no registry access) — (PARTIAL: `InvitationBadge` with `count` prop done; layout wiring waits on T051) Make `InvitationBadge` in `src/components/shell/InvitationBadge.tsx` take a `count` prop (hidden when 0) and have `src/app/p/[projectSlug]/layout.tsx` pass a literal `0` with a `// wired in T063` comment; T063 replaces it with the real count

**Checkpoint**: US1 + US2 work; `pnpm test` green.

---

## Phase 5: User Story 3 — Invite people and let them join (Priority: P1)

**Goal**: Hashed single-use invitation tokens, in-app and manual-link delivery, accept/decline/revoke/regenerate, invitation-only sign-up.

**Independent Test**: `tests/integration/invitations.test.ts` passes, including the token-failure matrix and double-submit race.

### Tests for User Story 3 ⚠️

- [ ] T055 [P] [US3] `tests/integration/invitations.test.ts`: create (pending, expiry = now + `INVITATION_TTL_DAYS`, role stored, audit `invite`); duplicate pending → `conflict` pointing to regenerate; already a member → `conflict`; email compared case/whitespace-insensitively; admin cannot invite owner (`forbidden`); delivery is `in_app` for existing accounts and `manual_link` with URL (shown once, not retrievable afterwards) for unknown emails; fake `InvitationDelivery` injection; delivery throwing leaves invitation pending
- [ ] T056 [P] [US3] `tests/integration/invitation-tokens.test.ts`: tokens fail when expired, revoked, regenerated-away, already used (accepted/signed-up/declined); malformed token never hits the DB (assert via recorder); `signUp` creates user + credential account + member + `accepted` + audit `invite_accept` with `newAccount=true` atomically; any failure mid-way creates nothing; **two concurrent submissions → exactly one success**; token invalidated between `resolveToken` and `signUp` → no account; email that gained an account meanwhile → `invitation_invalid`
- [ ] T057 [P] [US3] `tests/integration/invitation-accept.test.ts`: `acceptById`/`declineById` require matching signed-in email (`email_mismatch`), pending + unexpired (else `invitation_invalid`), create `member` with the invited role, close tokens, audit `invite_accept`/`invite_decline`; `revoke` and `regenerate` (pending incl. expired only; resets expiry; old token dead; admin can't revoke/regenerate owner-role invites); `resolveToken` returns the five states and never reveals why a token is invalid; `listMine`/`countMine` only for the session email, pending and unexpired
- [ ] T058 [P] [US3] Extend `tests/integration/auth-endpoints.test.ts`: sign-up endpoint rejected both with and without a valid token (token must not unlock the HTTP endpoint — SC-004)

### Implementation for User Story 3

- [ ] T059 [US3] DAL: `src/server/dal/invitations.ts`, `src/server/dal/tokens.ts` (claim by one conditional `UPDATE … RETURNING`, close-all-active-tokens helper; token lookups wrapped in `crossProject("resolve invitation token")`), and extend `members.ts` as needed; attach `scope.invitations`/`scope.invitationTokens`
- [ ] T060 [US3] `src/server/services/invitations/delivery.ts` (`InvitationDelivery`, `defaultInvitationDelivery`) and `src/server/services/invitations/index.ts` (`create`, `regenerate`, `revoke`, `acceptById`, `declineById`, `acceptByToken`, `declineByToken`, `signUp`, `resolveToken`, `listForProject`, `listMine`, `countMine`) per `contracts/server-actions.md`; each mutation is one `lockProject` transaction with its audit row; `deliver()` runs after commit; makes T055–T057 pass
- [ ] T061 [P] [US3] `src/app/signup/page.tsx` (+ `signup-form.tsx` client) rendering the five `resolveToken` states from `contracts/routes.md`, email read-only, `Referrer-Policy: no-referrer`, plain "no longer valid" message; `src/app/signup/actions.ts` (`signUpWithInvitation`, `acceptInvitationByToken`, `declineInvitationByToken`; after sign-up create the session via `auth.api` and redirect `/p/<slug>`)
- [ ] T062 [P] [US3] `src/app/invitations/page.tsx` + `actions.ts` (`acceptInvitation`, `declineInvitation`; empty state "You have no pending invitations.")
- [ ] T063 [US3] Wire `InvitationBadge` in `src/app/p/[projectSlug]/layout.tsx` to `invitations.countMine`; remove the temporary `0` from T054
- [ ] T064 [US3] Invitation section of `src/app/p/[projectSlug]/settings/members/page.tsx` + `actions.ts`: invite form (email, role limited by permission), invitations table (status per D11, role, inviter, expiry), Revoke/Regenerate, one-time link panel using `CopyField` with "shown only once" and expiry text; actions `inviteMember`, `regenerateInvitation`, `revokeInvitation` (shared file with US4 — create the page skeleton here, US4 adds the members table)

**Checkpoint**: Invitation-only sign-up verified by tests (SC-004).

---

## Phase 6: User Story 4 — Manage members and keep projects safe (Priority: P2)

**Goal**: Members list, role change, remove, leave, transfer ownership, audit view; last owner always protected; removal immediate.

**Independent Test**: `tests/integration/members.test.ts`, `permissions.test.ts`, `audit.test.ts` pass.

### Tests for User Story 4 ⚠️

- [ ] T065 [P] [US4] `tests/integration/members.test.ts`: last owner cannot be removed, demoted or leave (`last_owner`, message suggests transfer); two owners demoting each other **concurrently** leaves ≥ 1 owner; removed member's next `forProject` and next action → not found, nothing changed (SC-005); leave redirects data; transfer makes target owner and actor admin in one tx, target must be another member, target already owner ⇒ only actor demoted; self-remove refused (use leave); no-op role change writes no audit row
- [ ] T066 [P] [US4] `tests/integration/permissions.test.ts`: for every action in FR-021 run as owner/admin/editor via the services and assert allowed/`forbidden` and **no row changed** on refusal; admin cannot remove an owner, change roles, transfer, or invite owner; editor cannot see invitations or audit
- [ ] T067 [P] [US4] `tests/integration/audit.test.ts`: every invite, regenerate, revoke, accept, decline, remove, leave, role change and transfer writes exactly one matching audit row with actor/subject/details; list is newest-first; the audit DAL exposes no update/delete

### Implementation for User Story 4

- [ ] T068 [US4] Extend `src/server/dal/members.ts` with role update, delete, owner count under lock, transfer; implement `src/server/services/members.ts` (`list` with per-row allowed actions, `changeRole`, `remove`, `leave`, `transferOwnership`) — all `lockProject` transactions that re-check membership inside the tx; makes T065–T067 pass
- [ ] T069 [US4] Members section of `src/app/p/[projectSlug]/settings/members/page.tsx` (+ `actions.ts` additions `changeMemberRole`, `removeMember`, `leaveProject`, `transferOwnership`): members table (name, email, role, joined) for all roles, actions shown by permission, confirm `Dialog` naming the person for remove/leave/transfer, last-owner message surfaced inline; activity list (last 50, newest first) for owner/admin only
- [ ] T070 [P] [US4] Server-action not-found handling: a shared helper in `src/lib/action-result.ts` mapping `NotFoundError` → `{ ok:false, error:"not_found" }`, `ForbiddenError` → `forbidden`, etc., used by every `actions.ts`; unit test `src/lib/action-result.test.ts`
- [ ] T071 [US4] Add settings sub-navigation (Project settings | Members & invitations) in `src/app/p/[projectSlug]/settings/layout.tsx`

**Checkpoint**: Member management complete; SC-005, SC-006, SC-010 covered by tests.

---

## Phase 7: User Story 5 — Configure project settings (Priority: P2)

**Goal**: Owners/admins edit name, slug, time zone and default policies; editors read-only; slug rename moves the project.

**Independent Test**: `tests/integration/project-settings.test.ts` passes.

- [ ] T072 [P] [US5] `tests/integration/project-settings.test.ts`: owner/admin update name, timezone, both policies; editor update → `forbidden` and unchanged; slug change mirrors to `organization.slug` in the same tx, old slug → `NotFoundError`, new slug resolves; slug conflict/reserved/malformed → field errors; invalid time zone rejected; `updated_at` advances
- [ ] T073 [US5] Implement `projects.updateSettings` in `src/server/services/projects.ts` + DAL update in `src/server/dal/projects.ts` (project row + organization mirror in one tx); makes T072 pass
- [ ] T074 [US5] `src/app/p/[projectSlug]/settings/page.tsx` + `actions.ts` (`updateProjectSettings`): form editable for owner/admin, disabled fields + note for editor, auto-approve option labelled "Auto-approve: generated posts skip review", redirect to `/p/<newSlug>/settings` on slug change; proxy cookie follows the new slug

**Checkpoint**: All five product stories done.

---

## Phase 8: User Story 6 — Guaranteed project isolation (Priority: P1, developer-facing)

**Goal**: Prove the isolation guarantees (the machinery was built in Phase 2/US2).

**Independent Test**: `tests/integration/scope-check.test.ts` and `tests/lint/db-import.test.ts` pass.

- [ ] T075 [P] [US6] `tests/integration/scope-check.test.ts`: a deliberately unscoped `select` on `member` through the raw client **outside** `crossProject` is reported by `checkScope` (assert the violation text, then clear the recorder so the `afterEach` hook does not fail the test itself); a pinned query passes; a `crossProject` query is skipped and counted; registering a fake table with one registry line makes it covered (Story 6 #5)
- [ ] T076 [P] [US6] `tests/lint/db-import.test.ts`: use the ESLint Node API (`new ESLint({ overrideConfigFile })`, `lintText`) with `filePath: "src/app/example.ts"` importing `pg`, `drizzle-orm/node-postgres`, `@/server/db/client` and a relative `../server/db` → each yields the restricted-import error; the same import under `src/server/dal/example.ts` is allowed
- [ ] T077 [P] [US6] `tests/integration/no-plaintext.test.ts` (SC-009): after running the invitation, sign-up, setup and member flows with captured `console`/logger output, scan all tables' text/jsonb columns, audit `details` and captured logs for the plaintext tokens, passwords and the test encryption key → zero hits
- [ ] T078 [US6] Run the full suite and confirm the scope summary shows no unscoped-query failures; fix any query that the recorder flags (the fix is always scoping or a documented `crossProject` reason, never loosening the checker)

---

## Phase 9: Polish & Cross-Cutting Concerns

- [ ] T079 [P] README: local setup, Docker Compose, first-run bootstrap vs `/setup`, the setup-screen exposure note (configure bootstrap credentials for internet-reachable deploys), session/rate-limit defaults, how to register a project-owned table, Neon notes (pooled `DATABASE_URL`, direct `DATABASE_URL_DIRECT`) — FR-040, in `README.md`
- [ ] T080 [P] Append to `docs/decisions.md`: condensed D1–D18, dependency rationale for `pg` and `@better-auth/drizzle-adapter`, spec assumptions (7-day TTL, transfer → admin, owner-only role changes, non-member = not found, setup exposure), and the U1/U2 outcomes
- [ ] T081 [P] Accessibility/title audit as an automated check: `src/app/titles.test.ts` asserting every `page.tsx` under `src/app` exports `metadata` or `generateMetadata` (FR-041); fix any miss
- [ ] T082 Run the complete gate set locally and record results in the final note: `pnpm lint && pnpm typecheck && pnpm db:check && pnpm test && pnpm build`; confirm CI's `check` job env (only `DATABASE_URL`) is sufficient by running with only that variable plus vitest's fake env
- [ ] T083 🛑 BLOCKED: needs a Docker daemon and a browser — one survey run of quickstart.md §2–§6 against `docker compose up --build`: bootstrap vs `/setup`, config-failure exit within 5 s naming `CREDENTIALS_ENCRYPTION_KEY`, migration-failure exit before listening, Ctrl/⌘+K switcher focus return and ≤ 4 keystrokes, `/` returns to last project after browser restart, removed-member second tab gets not-found. Report every finding in one pass with the pass/fail count over all items (denominator = the checklist items in quickstart §2–§6)
- [ ] T084 🛑 BLOCKED: needs a Neon connection string (pooled + direct) — run quickstart.md §7 and the setup check against it; if none is available record SC-011's Neon half as "not verified" in the README and `docs/decisions.md` (constitution II)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (1)** → **Foundational (2)** → user stories → **Polish (9)**
- Inside Phase 2: T007→T008; T009→T010; T012→T014→T016; T018–T020 after T012/T013; T023 after T008; T024→T025→T026; T027 after T013; T017 after T025
- **US1 (3)** needs Phase 2; **US2 (4)** needs Phase 2 (+ `proxy.ts` from T039); **US3 (5)** needs US2 (projects, members, layout); **US4 (6)** needs US3 for invitation audit overlap but its services are independent of US3's UI; **US5 (7)** needs US2; **US6 (8)** needs Phase 2 and is best run after US3/US4 so the recorder has seen real traffic.

### Within each story

Tests first (and failing) → DAL → services → actions/pages.

### Parallel opportunities

- Phase 1: T003–T006 in parallel after T001/T002.
- Phase 2: T007, T009, T011, T018, T019, T021, T022, T030, T031 touch separate files and can run together.
- US1: T032–T034 together; T037 and T038 together.
- US3: T055–T058 together; T061 and T062 together.
- US4: T065–T067 together. US5 can run alongside US4 after US2.
- Polish: T079–T081 together.

### Parallel example: User Story 3 tests

```text
Task: "tests/integration/invitations.test.ts (T055)"
Task: "tests/integration/invitation-tokens.test.ts (T056)"
Task: "tests/integration/invitation-accept.test.ts (T057)"
```

## Implementation Strategy

### MVP first

1. Phase 1 → Phase 2 (T017 early to retire risk U1) → Phase 3 (US1). Stop and run the gates.
2. Add US2 (projects + shell) → US3 (invitations; the security-critical story) → US6 proofs.
3. Add US4, then US5; finish with Polish.

### Notes

- `🛑 BLOCKED` tasks (T083, T084) are owed to a human with a Docker daemon/browser/Neon; they are the only tasks of that kind and everything else is machine-verifiable.
- Never relax the scope checker or the lint rule to make a task pass.
- Keep tokens, passwords and keys out of logs, snapshots and error text (constitution VII).
