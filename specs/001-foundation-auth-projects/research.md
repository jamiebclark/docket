# Phase 0 Research: Foundation — accounts, projects, members, invitations, isolation

**Date**: 2026-10-03 | **Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md)

## How facts were verified (constitution principle I)

`docs/research/better-auth.md` and `docs/research/tooling.md` were the starting
point. Anything the plan relies on that they don't cover was checked against
the **installed package sources and types**. The exact versions pinned in
`docs/research/tooling.md` were installed into a scratch directory outside the
repo, then the `dist/` code and `.d.mts` types were read:

| Package | Version installed | Notes |
|---|---|---|
| better-auth | 1.7.7 | same version as research |
| @better-auth/drizzle-adapter | 1.7.7 | separate package (research: Drizzle + CLI) |
| drizzle-orm / drizzle-kit | 0.45.3 / 0.31.11 | same as research |
| zod | 4.6.5 | same as research |
| pg | 8.23.1 | node-postgres driver used by `drizzle-orm/node-postgres` |

Facts marked **[src]** below were read from those installed sources (file
paths are relative to the package's `dist/`). The implementation MUST pin
these exact versions. On any upgrade, re-check every **[src]** fact.

### Verified facts used by this plan

- **F1 [src] Server-side organization creation for an explicit user.**
  `plugins/organization/routes/crud-org.mjs`: `createOrganization` accepts
  `body.userId` ("server-only"). When there is no session *and* no
  request/headers, it loads that user and treats the call as a system action.
  This closes the gap research marked UNVERIFIED. It is not needed in the
  end, though: Docket creates the organization row itself (D3). That route
  is also **not transactional**: it inserts the organization, then the
  member, then runs the hooks as separate statements.
- **F2 [src] Sign-up runs in an adapter transaction, but Docket can't join
  it.** `api/routes/sign-up.mjs` wraps the work in `runWithTransaction`
  (`@better-auth/core/dist/context/transaction.mjs`). That is a real DB
  transaction only if the Drizzle adapter is created with `transaction: true`.
  Docket's own Drizzle transaction can't take part, and "after" hooks are
  queued until after commit (`queueAfterTransactionHook`). So "create account
  + join project + burn token" can't be made all-or-nothing through the
  sign-up endpoint.
- **F3 [src] Credential account shape and hasher.** Sign-up creates `user`
  (with the email lowercased, `emailVerified: false`), then `account` with
  `providerId: "credential"`, `accountId: <user.id>`, and
  `password: await ctx.context.password.hash(pw)`. The default hasher is
  `hashPassword` from `better-auth/crypto` (`context/create-context.mjs`),
  which is exported publicly along with `verifyPassword`.
- **F4 [src] `disabledPaths` only affects the HTTP router.** `api/index.mjs`
  `onRequest` returns 404 for listed paths. Server-side `auth.api.*` calls
  skip the router.
- **F5 [src] Rate limiting only applies to HTTP router requests.** It is on
  by default only when `NODE_ENV=production` (`enabled: options.rateLimit?.enabled ?? isProduction`).
  The default memory store allows 100 requests per 10 s. A built-in special
  rule allows `/sign-in*`, `/sign-up*`, `/change-password*` and
  `/change-email*` **3 requests per 10 s** (`api/rate-limiter/index.mjs`).
  If no client IP can be found, it falls back to one shared bucket per path
  and logs a warning recommending `advanced.ipAddress.ipAddressHeaders`.
- **F6 [src] Organization plugin endpoints** are all under `/organization/*`
  (35 routes, e.g. `/organization/remove-member`, `/organization/update`,
  `/organization/create`, `/organization/accept-invitation`). Hook contexts
  expose `ctx.path` (`@better-auth/core` `HookEndpointContext.path`).
- **F7 [src] Organization schema** (generated offline with the adapter's
  own `generateDrizzleSchema`, using `advanced.database.generateId: "uuid"`):
  - `organization(id, name, slug unique, logo, created_at, metadata)`
  - `member(id, organization_id → organization, user_id → user, role text default 'member', created_at)`
  - `invitation(id, organization_id, email, role, status text default 'pending', expires_at, created_at, inviter_id → user)`
  - core tables: `user`, `session` (incl. `active_organization_id`), `account`, `verification`
  - with `generateId: "uuid"`, ids are `uuid` columns defaulting to
    `gen_random_uuid()`
  - invitation statuses are `pending | accepted | rejected | canceled`
    (`plugins/organization/schema.mjs`)
- **F8 [src] Runtime schema check.** The Drizzle adapter registers a schema
  check (`findDrizzleSchemaProblems`). It compares the Drizzle schema object
  passed in with what Better Auth expects. It is on unless
  `advanced.database.validateSchema === false`, and runs before the first
  router request or transaction. A hand-written schema that drifts fails
  loudly.
- **F9 [src] The generator writes Drizzle relations-v2 syntax
  (`defineRelationsPart`), which drizzle-orm 0.45.3 doesn't export.** Its
  output can't be committed unchanged. Docket hand-writes the table
  definitions with the same columns and uses no relational query API (D9).
- **F10 [src] Access control.** `createAccessControl(statements)` from
  `better-auth/plugins/access` returns `newRole(statements)`, and each role
  has `authorize(request, connector?)` returning `{ success, error? }`.
- **F11 [src] Next.js integration.** `better-auth/next-js` exports
  `toNextJsHandler(auth)` (GET/POST/PATCH/PUT/DELETE) and `nextCookies()`.
  `nextCookies()` is a plugin with before/after hooks that write
  `Set-Cookie` through Next's cookie API when `auth.api.*` runs inside a
  server action. `better-auth/cookies` exports `getSessionCookie(request|headers)`
  for a cheap presence check.
- **F12 [src] Password length options.** `emailAndPassword.minPasswordLength`
  and `maxPasswordLength` exist (`@better-auth/core` `init-options.d.mts`).
- **F13 [src] Drizzle logger.** The interface is
  `Logger { logQuery(query: string, params: unknown[]): void }`
  (`drizzle-orm/logger.d.ts`).
- **F14 [src] Drizzle migrator.** `pg-core/dialect.js#migrate` creates
  `drizzle.__drizzle_migrations` and applies pending files in **one
  transaction**, with **no advisory lock** or other session state. It works
  through a transaction-mode pooler, but two migrators running at once are
  not serialised (see D14).
- **F15 [src] drizzle-kit 0.31.11 CLI** has `generate`, `migrate`, `check`
  (flags `--config`, `--out`, `--dialect`) and others. `check` checks that
  the migration history is consistent. It does **not** compare the schema
  with the migrations (D15 adds that).
- **F16 [installed Next 16.3.8 docs]** `middleware` is deprecated and renamed
  to **`proxy.ts`**, which runs on the Node.js runtime by default
  (`01-app/03-api-reference/03-file-conventions/proxy.md`).
  `instrumentation.ts` `register()` "is called once when a new Next.js server
  instance is initiated, and must complete before the server is ready to
  handle requests" (`instrumentation.md`). Standalone output needs
  `outputFileTracingIncludes` for files it can't trace (`output.md`).
- **F17 [Node 24.16 runtime]** `Intl.supportedValuesOf("timeZone")` returns
  418 canonical names. It **omits** `UTC` and some current names (it has
  `Asia/Calcutta` but not `Asia/Kolkata`). `new Intl.DateTimeFormat("en", { timeZone })`
  accepts aliases (`Asia/Kolkata`), throws on unknown names (`Foo/Bar`) and
  **accepts offsets** (`+02:00`).

### Still unverified (carried forward, not guessed)

- **U1** Whether Better Auth's runtime schema check (F8) accepts
  `timestamp with time zone` for the columns it generates as `timestamp`.
  It's verified at the first test run. If rejected, use the generator's
  `timestamp` for Better Auth tables only (Docket tables stay `timestamptz`)
  and record it.
- **U2** The order requirement for `nextCookies()` within `plugins`. It is
  placed last, which is harmless either way.
- **U3** Running against a real Neon database (SC-011). It can only be checked
  if a Neon connection string is available to the build. Otherwise it is
  reported as **not verified** (principle II).

---

## Decisions

Each decision below is a judgement call. Implementation MUST append D1–D18 to
`docs/decisions.md` (FR-040).

### D1 — Better Auth owns authentication. Docket's DAL owns membership changes.

- **Decision**: Use Better Auth for email/password sign-in, sign-out and
  sessions, its Drizzle adapter, the organization plugin's **tables** and
  `createAccessControl`. Every membership/invitation/project change
  (create project, invite, accept, decline, revoke, regenerate, remove,
  leave, change role, transfer, invitation sign-up, first-user setup) is
  done by **Docket services through the scoped DAL**. Each runs as one
  Drizzle transaction that writes the Better Auth rows (`organization`,
  `member`, `invitation`, `user`, `account`) plus Docket's rows
  (`projects`, `invitation_tokens`, `membership_audit_log`).
- **Rationale**: The spec needs all-or-nothing steps (FR-029 sign-up+join,
  FR-032 transfer), at-most-one success on raced links, an audit entry for
  every change (FR-033) and race-free last-owner protection (FR-024). Better
  Auth's endpoints run outside Docket's transaction (F1, F2), don't write
  Docket's audit log, and apply their own role semantics, which would
  duplicate FR-021 (constitution IV: one implementation). The tables and
  role definitions stay Better Auth-compatible, so a later email-delivery
  feature can still use them.
- **Alternatives rejected**: (a) Wrapping `auth.api.removeMember` and friends
  in services, then writing audit/tokens afterwards. This isn't atomic, and
  last-owner races are possible. (b) Better Auth `organizationHooks` for
  audit. They aren't in Docket's transaction, and invitation tokens would
  need a second write path.

### D2 — Block the organization plugin's HTTP endpoints. Sign-up endpoint always returns 400.

- **Decision**: A global `hooks.before` middleware (`createAuthMiddleware`):
  - if `ctx.path` starts with `/organization`, throw `APIError("NOT_FOUND")`;
  - if `ctx.path === "/sign-up/email"`, throw `APIError("BAD_REQUEST", { message: "Sign-up requires an invitation" })`.
  The hook runs for HTTP and server-side calls alike, and Docket never calls
  either.
- **Rationale**: Docket doesn't use these endpoints (D1). Leaving them
  reachable would let a crafted request skip FR-021, the audit log and
  `projects` syncing. A path-prefix hook also covers organization endpoints
  added in future versions; `disabledPaths` is an exact-match list (F4).
  The sign-up gate follows research: it throws 400, not 403 (a 403 can
  become a fake success), and meets FR-011/SC-004.
- **Alternatives rejected**: `disabledPaths` with all 35 paths listed (fragile
  on upgrade). A token-checking sign-up hook (research's suggestion). It
  isn't needed because invitation sign-up doesn't use the endpoint (D4), and
  it would still not be atomic (F2).

### D3 — `projects.id` = `organization.id` (shared primary key)

- **Decision**: `projects.id uuid primary key references organization(id) on delete cascade`.
  Creating a project inserts `organization` (name, slug) and then `projects`
  with the same id in one transaction. `organization.name`/`slug` are
  mirrors of `projects.name`/`slug`, written in the same transaction on
  every change. Docket reads only `projects`.
- **Rationale**: This gives the 1:1 mapping (FR-014) with no lookup.
  `member.organization_id` and `invitation.organization_id` then *are*
  project ids, so the scope check treats them as the project scope column
  (D8).
- **Alternatives rejected**: A separate `projects.organization_id` FK. That
  needs an extra join or translation on every scoped query.

### D4 — Invitation sign-up and first-user setup insert credentials directly

- **Decision**: Both flows are DAL transactions that insert `user` (lowercased
  email, `email_verified=false`) and `account` (`provider_id='credential'`,
  `account_id=user.id`, `password=hashPassword(pw)` from `better-auth/crypto`,
  F3), plus the flow's other rows. After commit, the server action calls
  `auth.api.signInEmail({ body, headers })` with the `nextCookies()` plugin
  (F11) to start the session. If that sign-in fails, the account still
  exists and the user is sent to `/login`.
- **Rationale**: Account creation and joining the project become one
  transaction (FR-029, edge cases "raced" and "invalidated between load and
  submit"). It uses Better Auth's own hasher, so sign-in verifies the hash
  unchanged, and the runtime schema check (F8) guards the column shapes.
- **Alternatives rejected**: `auth.api.signUpEmail` followed by a second
  transaction with compensation (deleting the user). That isn't atomic and
  needs a sign-up gate with a bypass flag.

### D5 — Login uses the HTTP endpoint (for rate limiting)

- **Decision**: The `/login` form is a small client component that posts to
  `/api/auth/sign-in/email` with `createAuthClient` from `better-auth/react`.
  `rateLimit: { enabled: true }` is set explicitly so dev and tests limit
  too. The memory store is kept; the built-in rule gives 3 sign-in attempts
  per 10 s per IP (F5). On error, the UI always shows "Email or password is
  incorrect." Client IP comes from `x-forwarded-for` behind a proxy;
  `advanced.ipAddress.ipAddressHeaders` defaults to `["x-forwarded-for"]`
  and is documented in the README.
- **Rationale**: Server-side `auth.api.signInEmail` skips the rate limiter
  (F5), so a server-action login would break FR-009. One web container
  makes the memory store adequate.
- **Alternatives rejected**: `storage: "database"`, which adds a table and
  query per request. Revisit if several web instances run behind a load
  balancer.

### D6 — Hashed single-use invitation tokens

- **Decision**: 32 random bytes from `crypto.randomBytes`, base64url-encoded
  (43 chars) in `/signup?token=…`. Only `sha256(token)` (hex) is stored, in
  `invitation_tokens.token_hash` (unique). At most one *active* token per
  invitation (partial unique index). The token is claimed with a single
  conditional `UPDATE … SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL … RETURNING`,
  joined to a still-`pending`, unexpired invitation, inside the
  accept/sign-up transaction. Regenerate sets `revoked_at` on the active
  token, inserts a new one and resets `invitation.expires_at`. Revoke sets
  `invitation.status='canceled'` and `revoked_at` on its tokens. A token is
  always created; the delivery decides whether the URL is shown (D7). `/signup`
  responses send `Referrer-Policy: no-referrer` and load no third-party
  resources.
- **Rationale**: Covers FR-026, edge-case races (only one conditional
  UPDATE can win) and SC-009.

### D7 — `InvitationDelivery` interface with one implementation

- **Decision**: `deliver({ invitation, project, inviter, acceptUrl, inviteeHasAccount })`
  returns `{ kind: "in_app" } | { kind: "manual_link", url, expiresAt }`.
  `ManualLinkOrInAppDelivery` returns `in_app` when the email has an
  account, otherwise `manual_link`. The URL exists only in the server
  action's response, rendered once. See [contracts/internal-interfaces.md](./contracts/internal-interfaces.md).
- **Rationale**: FR-027. A future email delivery is a second
  implementation.

### D8 — Scope enforcement: registry + SQL recorder + `crossProject` escape hatch

- **Decision**:
  - `src/server/db/project-owned.ts` exports a registry with one entry per
    project-owned table: `{ table, scopeColumn }`. Initial entries:
    `projects.id`, `organization.id`, `member.organization_id`,
    `invitation.organization_id`, `invitation_tokens.project_id`,
    `membership_audit_log.project_id`.
  - The Drizzle client is built with a `Logger` (F13) that forwards each
    query to registered observers. In production there are no observers and
    no output; params are never logged.
  - The Vitest harness registers an observer. After each test, it checks
    every recorded statement that touches a registered table. Each such
    table must be pinned by an equality predicate on its scope column to a
    bound parameter (`"t"."col" = $n`), or, for INSERT, include the scope
    column in its column list. Joins between registered tables count if the
    join is equality on both scope columns and one side is pinned.
    Violations fail the test and print the SQL.
  - Queries that are legitimately not project-scoped (resolving a project by
    slug inside `forProject`, "my projects", "my invitations", the token
    lookup, Better Auth internals) run inside
    `crossProject(reason, fn)`, an `AsyncLocalStorage` marker exported only
    by `src/server/dal/`. The recorder skips them and lists them in a
    summary.
  - A dedicated test proves the checker fails on a deliberately unscoped
    query.
- **Rationale**: FR-034/036, SC-008. A one-line registry addition covers new
  tables (Story 6 #5).
- **Alternatives rejected**: Postgres RLS (owner rejected it, decision 6).
  A full SQL parser dependency. Drizzle emits predictable, quoted SQL, and
  pattern checks on table and column identifiers are enough.

### D9 — Hand-written Drizzle schema, core query builder only

- **Decision**: `src/server/db/schema/auth.ts` defines the Better Auth tables
  with the exact columns from F7 (plus Docket-added constraints D10). Docket
  tables live in `projects.ts`, `invitations.ts`, `audit.ts`, `install.ts`.
  No `relations()` / relational query API. Joins are explicit, which also
  keeps the SQL predictable for D8. `advanced.database.generateId: "uuid"`.
- **Rationale**: F9. The runtime schema check (F8) catches drift.

### D10 — Extra constraints on Better Auth tables

- **Decision**: Docket adds these in its migrations:
  - `member`: unique `(organization_id, user_id)` and
    `check (role in ('owner','admin','editor'))`
  - `invitation`: `check (role in (...))`, plus a partial unique index on
    `(organization_id, lower(email)) where status = 'pending'`
- **Rationale**: Database-level guarantees for "one membership per person",
  the three roles (FR-021) and "duplicate pending invite refused" under
  concurrency (edge case).

### D11 — Docket invitation states mapped onto Better Auth values

- **Decision**: Store Better Auth's values. Docket shows them as:
  `pending`→Pending, `accepted`→Accepted, `rejected`→Declined,
  `canceled`→Revoked. **Expired** is not stored; it is derived
  (`status='pending' AND expires_at <= now()`).
- **Rationale**: Keeps the tables Better Auth-compatible (D1) and needs no
  job to flip state on expiry.

### D12 — Race-free last-owner protection and serialised membership changes

- **Decision**: Each membership-changing transaction starts with
  `SELECT … FROM projects WHERE id = $1 FOR UPDATE`, which serialises
  changes per project. It then reads the owner count and target rows and
  enforces FR-024 and FR-021 before writing. The audit row is written in the
  same transaction.
- **Rationale**: Two owners demoting each other at once can't leave zero
  owners (SC-006). Row locks are transaction-scoped, so they're fine with
  transaction-mode poolers (FR-005; constitution allows `FOR UPDATE`).

### D13 — First-run bootstrap guarded by a singleton row

- **Decision**: Table `install_state(id smallint primary key check (id = 1), first_user_id uuid, completed_at timestamptz)`.
  Bootstrap (env or `/setup`) runs in one transaction:
  `INSERT INTO install_state (id, …) VALUES (1, …)`, then fails if any
  `user` row exists, then inserts `user` + `account`. A concurrent second
  attempt blocks on the primary key and then fails with a unique violation,
  which is reported as "setup already complete". `/setup` is offered only
  while there is no `install_state` row **and** no user. If env credentials
  are configured, startup runs bootstrap before the server takes requests
  (D14), so `/setup` is never offered.
- **Rationale**: FR-012 "exactly one succeeds" without advisory locks.
  It's a system table, not project data (no `project_id`; see the Plan's
  Constitution Check).
- **Alternatives rejected**: A `SERIALIZABLE` transaction with
  `count(*)`. It's correct but harder to reason about and test.

### D14 — Startup: env validation → migrations → bootstrap, from `instrumentation.ts`

- **Decision**: `src/instrumentation.ts` `register()` (Node runtime only)
  calls `runStartup()`:
  1. parse env (any failure: print each variable name and reason, never
     values, then `process.exit(1)`);
  2. if `MIGRATE_ON_START` (default `true`), apply migrations from `./drizzle`
     using `DATABASE_URL_DIRECT ?? DATABASE_URL` with the drizzle-orm
     migrator (F14); on failure, exit 1;
  3. if bootstrap env vars are set, run the D13 bootstrap.
  The Dockerfile copies `drizzle/` into the runner stage. `pnpm db:migrate`
  (drizzle-kit) does the same in development. Both use
  `drizzle.__drizzle_migrations`.
- **Rationale**: `register()` must finish before the server serves (F16), so
  "never serve on migration failure" (FR-004) holds with **one image and no
  extra runtime files or dependencies**. The migrator already ships in the
  traced `drizzle-orm` package. It works the same under `next start`, the
  standalone `server.js` and Compose.
- **Concurrency note**: The migrator isn't locked (F14). For several
  replicas, set `MIGRATE_ON_START=false` on all but one, or run
  `pnpm db:migrate` as a release step (README).
- **Alternatives rejected**: A separate `node migrate.mjs && node server.js`
  entrypoint. The standalone trace wouldn't include the migrator files, so
  it needs `outputFileTracingIncludes` hacks or a second `node_modules` in
  the image.

### D15 — `db:check` = history check + "schema has no ungenerated changes"

- **Decision**: `db:check` runs `drizzle-kit check` and then
  `node scripts/check-migrations-current.mjs`. That script copies `drizzle/`
  to a temp dir, runs `drizzle-kit generate --config drizzle.config.ts --out <tmp>`
  (or an equivalent config override) and fails if any new migration file
  appears.
- **Rationale**: The constitution's gate is "migrations match schema", and
  `drizzle-kit check` alone doesn't verify that (F15). No new dependency.

### D16 — Secrets-at-rest format

- **Decision**: `enc:v1:<kid>:<iv>:<tag>:<ciphertext>`, each field base64url.
  AES-256-GCM via `node:crypto` with a 12-byte random IV and 16-byte tag.
  Optional AAD binds ciphertext to a context string (e.g. a row id) for
  later features. The key is `CREDENTIALS_ENCRYPTION_KEY`, 32 bytes as
  base64 (or 64 hex chars). `kid` = first 8 bytes (hex) of
  `SHA-256("docket-kid:" || key)`, so key changes are detected without
  another variable. Decryption with an unknown version or kid, a tampered
  value or the wrong key throws `SecretDecryptionError` with a fixed message
  (no plaintext, key or ciphertext). A later rotation feature can add a
  keyring keyed by `kid`. Contract: [contracts/internal-interfaces.md](./contracts/internal-interfaces.md).
- **Rationale**: FR-007, edge case "encryption key … changed". No dependency.

### D17 — Time-zone and slug validation (shared Zod schemas)

- **Time zone**: Trim. Reject anything starting with `+`, `-`, `−` or a
  digit (offsets, F17). Require the IANA name shape
  `^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+)*$`. Require
  `new Intl.DateTimeFormat("en", { timeZone })` not to throw. Store the
  value as entered (aliases like `Asia/Kolkata` are valid IANA names, F17).
  The picker lists `["UTC", ...Intl.supportedValuesOf("timeZone")]` and is
  pre-filled from the browser's resolved zone. The same zone ids later work
  with `@js-temporal/polyfill`, which uses `Intl`.
- **Slug**: `^[a-z0-9]+(-[a-z0-9]+)*$`, 3–48 chars. Reserved:
  `new, settings, api, setup, login, logout, signup, invitations, p, admin, static, _next`.
  Unique (unique index on `projects.slug`, mirrored on `organization.slug`).
- **Email**: `trim().toLowerCase()` then `z.email()`.
- **Password**: 12–128 chars (FR-010), also set as
  `minPasswordLength`/`maxPasswordLength` in Better Auth (F12).

### D18 — Routing and UI structure

- **Decision**:
  - `/p/new` is project creation (`new` is reserved).
  - `/p/[projectSlug]/layout.tsx` is the shell and resolves `forProject` on
    every request (non-member → `notFound()`).
  - Unbuilt screens use one dynamic `/p/[projectSlug]/[section]/page.tsx`
    with an allowlist (`calendar, posts, compose, generate, jobs, review, media, accounts, voice`).
    Later features add static `calendar/page.tsx` etc., which Next serves
    ahead of the dynamic segment.
  - `src/proxy.ts` (F16) does two cheap things: (1) if
    `getSessionCookie()` (F11) is absent on a protected path, redirect to
    `/login?next=<path>`; (2) on `/p/<slug>/…` requests, set the
    `docket_last_project=<slug>` cookie (docket-ui skill). `/` checks
    membership before using the cookie (FR-018).
  - Server actions return `{ ok: true, data } | { ok: false, error, fieldErrors? }`.
  - `next` redirect targets must be same-origin relative paths (starting
    with `/`, not `//`).
- **Rationale**: FR-013/017/018/020, docket-ui conventions. Proxy checks are
  optimistic only. The real check is always the DAL (FR-022).

---

## Dependencies added (constitution VI)

| Package | Kind | Why it's within the fixed stack |
|---|---|---|
| `better-auth@1.7.7` | runtime | Better Auth (fixed stack) |
| `@better-auth/drizzle-adapter@1.7.7` | runtime | Better Auth's Drizzle adapter is now a separate package (research) |
| `drizzle-orm@0.45.3` | runtime | Drizzle ORM (fixed stack) |
| `pg@^8.23` | runtime | the driver behind `drizzle-orm/node-postgres` (fixed stack) |
| `zod@4.6.5` | runtime | Zod (fixed stack) |
| `drizzle-kit@0.31.11` | dev | Drizzle migrations CLI (fixed stack: "SQL migrations committed") |
| `@types/pg` | dev | types for `pg` |

None added beyond the fixed stack. No UI library, no SQL parser, no `tsx` or
`esbuild` dependency. `@js-temporal/polyfill` isn't needed until slot maths
(entry 2). Implementation records the `pg` / adapter rationale in
`docs/decisions.md`.

## Best-practice notes applied

- **Neon/pooler**: one `pg.Pool` (max `DATABASE_POOL_MAX`, default 10). No
  `SET`, `LISTEN`, advisory locks or session temp tables. Named prepared
  statements aren't used (drizzle node-postgres sends unnamed queries).
  Migrations use the direct URL.
- **Sessions**: Better Auth `session.cookieCache` stays **off** (default), so
  sign-out and session expiry are seen on the next request. Membership is
  never cached across requests. React `cache()` only dedupes within one
  render.
- **Logs**: no request bodies, no SQL params, no tokens. Errors shown to users
  are fixed strings.
- **Testing**: real Postgres, migrated once per run. Tests create unique
  fixtures (random suffixes) and never depend on shared rows. Tests that
  need an empty install (bootstrap/setup) create and migrate a throwaway
  database. The harness refuses to reset a database whose name doesn't end
  in `_test`.
