# Implementation Plan: Docket Foundation — Accounts, Projects, Members, Invitations and Project Isolation

**Branch**: `001-foundation-auth-projects` | **Date**: 2026-10-03 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-foundation-auth-projects/spec.md`

## Summary

Build the base everything else in Docket stands on:

- a Zod-validated configuration module
- Postgres via Drizzle (`drizzle-orm/node-postgres`) with committed SQL
  migrations, applied at server start
- a two-service Docker Compose stack (postgres 17 + web)
- an AES-256-GCM secrets facility
- Better Auth email/password sessions
- projects mapped 1:1 onto Better Auth organizations (shared primary key)
- three roles defined with `createAccessControl`
- invite-only sign-up through hashed single-use tokens
- member management with race-free last-owner protection and an
  append-only audit log
- the app shell with a keyboard-first project switcher

**Technical approach.** Better Auth does what it does well: password hashing,
sign-in, sessions, rate-limited login, and the organization plugin's tables
and access-control helper. Every membership, invitation and project change
goes through Docket's service layer. Each change is **one Drizzle
transaction** in the scoped DAL. That transaction writes the Better Auth rows
and Docket's rows (`projects`, `invitation_tokens`, `membership_audit_log`)
together, under a per-project row lock.

Better Auth's `/organization/*` HTTP endpoints are blocked (404). Its sign-up
endpoint always returns 400. Invitation sign-up and first-run setup insert
the credential rows directly, using Better Auth's own hasher, and then sign
in through `auth.api`. Research D1–D4 explains why: Better Auth's endpoints
can't share Docket's transaction.

Project isolation has three parts:

- `forProject(session, slug)` re-resolves membership on every call;
- an ESLint import ban;
- a Vitest SQL recorder that fails any test issuing a query on a registered
  project-owned table without a project predicate.

## Technical Context

**Language/Version**: TypeScript 5 (strict, `noUncheckedIndexedAccess`) on Node 24 LTS (`>=24.10 <25`)

**Primary Dependencies**:

- Next.js 16.3.8 (App Router, standalone output, `proxy.ts`, `instrumentation.ts`), React 19.2, Tailwind 4
- better-auth 1.7.7 + @better-auth/drizzle-adapter 1.7.7 (organization plugin, `createAccessControl`, `nextCookies`)
- drizzle-orm 0.45.3 + pg 8, drizzle-kit 0.31.11 (dev)
- zod 4.6.5

All versions are pinned exactly. They were verified against installed sources in [research.md](./research.md).

**Storage**: PostgreSQL 17 (Compose/CI) and Neon (pooled URL for the app, direct URL for migrations). No session-level features.

**Testing**: Vitest 5 against real Postgres (`DATABASE_URL`/`TEST_DATABASE_URL`, db name `*_test`).

- Fresh migrated schema per run; per-test unique fixtures.
- Throwaway databases for empty-install tests.
- SQL-recorder scope check in `afterEach`.
- ESLint Node API test for the import ban.

**Target Platform**: Linux container (`node:24-slim`) via Docker Compose; any container host + Neon. Browsers: current evergreen.

**Project Type**: Web application, a single Next.js app with a server layer (`src/server/`).

**Performance Goals**: Switching project shows the new project home in < 2 s locally (SC-007). Membership resolution is one indexed query per request. Startup config failure is reported in < 5 s (SC-002).

**Constraints**:

- No advisory locks, LISTEN or `SET`; transaction-scoped `FOR UPDATE` only.
- Secrets never logged or sent to the browser.
- Every screen keyboard-operable (docket-ui).
- No new runtime dependency outside the fixed stack.

**Scale/Scope**: Self-hosted, a handful of users and tens of projects. 9 screens + shell, ~13 server actions, 6 project-owned tables, 1 system table.

No `NEEDS CLARIFICATION` remains. Three items are explicitly **unverified** and carried forward with a test or fallback (research U1–U3).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design (below).*

| Principle | Status | How this plan complies |
|---|---|---|
| I. Verified facts over memory | ✅ | Every Better Auth / Drizzle / Next / Node fact used is cited from `docs/research/` or read from the installed package (research F1–F17, with file paths). Remaining unknowns are listed as U1–U3 with a test or fallback, not guessed. One research suggestion is replaced, not contradicted: research suggested a token-checking sign-up hook, but D2/D4 make sign-up always 400 and do invitation sign-up atomically elsewhere. This is a design choice, logged in D2 |
| II. Nothing is "working" unless it ran | ✅ | Quickstart lists the commands and expected outputs. The Neon half of SC-011 is reported "not verified" unless a Neon URL is available. No provider calls exist in this feature |
| III. Isolation enforced in one place | ✅ | `src/server/dal/forProject` resolves membership and role per call. Lint bans the db client outside `dal/`, `db/`, `auth/`, `startup/`. The SQL recorder fails unscoped queries on registered tables. Roles are checked on the server via `requirePermission`. Better Auth's `member`/`invitation`/`organization` are scoped via `organization_id = projects.id` (D3, D8). `install_state` is a system/auth-bootstrap table with no `project_id`, which the "users/auth tables" exception covers (D13) |
| IV. One service layer | ✅ | All rules live in `src/server/services/`. Server actions are thin. Better Auth's organization endpoints are blocked so there is no second implementation of membership rules (D1, D2) |
| V. Providers are plug-ins | N/A | No providers in this feature |
| VI. Boring, few dependencies | ✅ | Only fixed-stack packages (research "Dependencies added"). `pg` and `@better-auth/drizzle-adapter` are the stack's own driver/adapter, justified in research and to be logged in `docs/decisions.md`. No UI kit, SQL parser or new infrastructure |
| VII. Secrets never leak | ✅ | AES-256-GCM facility (D16). Tokens stored only as SHA-256 (D6). Passwords via Better Auth hasher. Env validated with Zod and documented in `.env.example`. Drizzle logger forwards to test observers only and never prints params. A no-plaintext test (SC-009) |
| Eng. constraints | ✅ | Node 24, pnpm. Compose `web` + `postgres` (the `worker` arrives with entry 2, per the roadmap). Migrations use the direct URL. UTC `timestamptz`. Server components by default, client components only for the switcher, login, dialogs and copy-link |
| Workflow | ✅ | Conventional commits with explicit paths. Gates: lint, typecheck, `db:check` (D15), test, build, docker. README + `docs/decisions.md` updates are tasks |

**Gate result: PASS** (no violations; Complexity Tracking is empty).

### Post-design re-check (after Phase 1)

Re-evaluated against data-model.md and contracts/:

- Every project-owned table has a scope column in the registry.
- The DAL contract is the only path to the client.
- Every membership change locks, checks and audits in one transaction.
- No session-level Postgres feature appears (`FOR UPDATE` only inside transactions).
- No new dependencies were introduced by the design.

**PASS.**

## Project Structure

### Documentation (this feature)

```text
specs/001-foundation-auth-projects/
├── plan.md              # This file
├── research.md          # Phase 0: verified facts F1–F17, unknowns U1–U3, decisions D1–D18
├── data-model.md        # Phase 1: tables, constraints, state transitions, permissions
├── quickstart.md        # Phase 1: validation scenarios
├── contracts/
│   ├── env.md                  # configuration contract
│   ├── routes.md               # pages, cookies, HTTP endpoints, response semantics
│   ├── server-actions.md       # actions → services, inputs, errors, effects
│   ├── dal.md                  # forProject, crossProject, registry, scope-check rules, lint rule
│   └── internal-interfaces.md  # secrets, tokens, InvitationDelivery, startup, auth config
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
.env.example                       # every variable (contracts/env.md)
docker-compose.yml                 # postgres:17 (healthcheck, named volume) + web (image docket:local)
Dockerfile                         # + COPY drizzle/ into runner stage
drizzle.config.ts                  # schema ./src/server/db/schema, out ./drizzle, url = DIRECT ?? DATABASE_URL
drizzle/                           # generated SQL migrations + meta (committed)
scripts/check-migrations-current.mjs   # part of db:check (D15)
eslint.config.mjs                  # + no-restricted-imports block (contracts/dal.md)
vitest.config.ts                   # + globalSetup, setupFiles, test.env
package.json                       # + db:generate, db:migrate, db:check; pinned deps

src/
├── instrumentation.ts             # register() → runStartup() (Node runtime only)
├── proxy.ts                       # optimistic auth redirect + docket_last_project cookie
├── app/
│   ├── layout.tsx                 # root: skip link, metadata template
│   ├── page.tsx                   # "/" redirect logic (FR-018)
│   ├── not-found.tsx
│   ├── login/page.tsx             # + login-form.tsx (client)
│   ├── setup/{page.tsx,actions.ts}
│   ├── signup/{page.tsx,actions.ts}
│   ├── invitations/{page.tsx,actions.ts}
│   ├── p/new/{page.tsx,actions.ts}
│   ├── p/[projectSlug]/
│   │   ├── layout.tsx             # shell: switcher, nav, badge, user menu; forProject per request
│   │   ├── page.tsx               # project home
│   │   ├── loading.tsx, error.tsx, not-found.tsx
│   │   ├── [section]/page.tsx     # placeholders for unbuilt screens (D18)
│   │   └── settings/
│   │       ├── {page.tsx,actions.ts}          # project settings
│   │       └── members/{page.tsx,actions.ts}  # members, invitations, activity
│   └── api/
│       ├── auth/[...all]/route.ts # toNextJsHandler(auth)
│       └── health/route.ts
├── components/
│   ├── ui/                        # Button, Field (label/help/error), Select, Dialog (confirm), Badge, Table, CopyField, EmptyState
│   └── shell/                     # ProjectSwitcher (client), LeftNav, InvitationBadge, UserMenu
├── lib/
│   ├── validation/                # email, password, slug, timezone, role, policies (shared Zod)
│   ├── action-result.ts           # ActionResult type + helpers
│   ├── safe-redirect.ts           # same-origin `next` param check
│   └── auth-client.ts             # createAuthClient (better-auth/react) for login/sign-out
└── server/
    ├── env.ts                     # parseEnv / getEnv (Zod)
    ├── db/
    │   ├── client.ts              # pg.Pool + drizzle(logger → queryObservers)
    │   ├── schema/{auth,projects,invitations,audit,install,index}.ts
    │   ├── project-owned.ts       # registry (+ notProjectOwned list)
    │   └── migrate.ts             # runMigrations(url)
    ├── auth/
    │   ├── auth.ts                # betterAuth config (contracts/internal-interfaces.md)
    │   ├── access.ts              # createAccessControl statements + owner/admin/editor
    │   └── session.ts             # getSession()/requireSession() (React cache per request)
    ├── crypto/{secrets,tokens}.ts
    ├── dal/
    │   ├── scope.ts               # forProject, requireRole, requirePermission, crossProject
    │   ├── errors.ts              # NotFoundError, ForbiddenError, ConflictError, …
    │   ├── projects.ts, members.ts, invitations.ts, tokens.ts, audit.ts
    │   ├── users.ts               # listMyProjects, myInvitations (crossProject)
    │   ├── install.ts             # setup availability + bootstrapFirstUser (D13)
    │   └── health.ts
    ├── services/
    │   ├── projects.ts, members.ts, setup.ts, audit.ts
    │   └── invitations/{index,delivery}.ts
    └── startup/index.ts           # runStartup(): env → migrate → bootstrap

tests/
├── setup/{global-setup.ts,scope-recorder.ts}
├── helpers/{db.ts,factories.ts,scope-check.ts,auth.ts}
├── integration/                   # permissions, members, invitations, auth-endpoints, bootstrap, audit, scope-check, no-plaintext
└── lint/db-import.test.ts
# unit tests colocated: src/**/*.test.ts (env, secrets, tokens, validation, project-owned)
```

**Structure Decision**: one Next.js app. The `src/app` UI layer calls
`src/server/services`, which calls `src/server/dal`, which calls
`src/server/db`. The same layering serves the worker and public API that
later entries add. Integration tests live in `tests/`. Pure unit tests sit
next to their modules (matching the existing `vitest.config.ts` include
globs).

## Implementation notes for the tasks phase

These are ordering and risk notes, not tasks.

1. **Order**:
   1. env → db client/schema/migrations + test harness (global setup, scope recorder) — later steps' tests depend on the harness.
   2. secrets/tokens → auth config + access control → DAL scope.
   3. services (setup → projects → invitations → members) → UI.
   4. Compose/Dockerfile → README/decisions.
2. **Check U1 early.** Run one auth call against the migrated schema with
   `timestamptz` Better Auth columns. If the schema check rejects them, use
   `timestamp` for Better Auth tables only, and record it.
3. **CI**: `db:check` turns on when `drizzle.config.ts` exists. CI provides
   only `DATABASE_URL` (`docket_test`), so `drizzle.config.ts` and the test
   env must not require the other secrets. The test env supplies fakes via
   `vitest.config.ts`.
4. **`next build`** must not evaluate `getEnv()`. Every auth-dependent page is
   dynamic because it reads cookies/headers.
5. **Docker**: the runner stage needs `drizzle/`. Verify with
   `docker compose up --build` that migrations run before `server.js` listens.
6. **Decisions log**: append research D1–D18 (condensed), the dependency
   rationale, and spec assumptions (7-day TTL, transfer → admin, owner-only
   role changes, non-member = not found, setup-screen exposure note) to
   `docs/decisions.md`.

## Complexity Tracking

No constitution violations to justify.
