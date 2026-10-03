# Contract: Scoped data-access layer (developer-facing)

Location: `src/server/dal/`. This is the **only** code (with
`src/server/db/`, `src/server/auth/` and `src/server/startup/`) allowed to
import the database client (FR-034, FR-035, constitution III).

## Entry point

```ts
// src/server/dal/scope.ts
export type Role = "owner" | "admin" | "editor";

export interface ProjectScope {
  readonly project: { id: string; slug: string; name: string; timezone: string;
                      defaultApprovalPolicy: ApprovalPolicy; defaultSchedulingPolicy: SchedulingPolicy };
  readonly membership: { memberId: string; userId: string; role: Role };
  can(request: PermissionRequest): boolean;        // createAccessControl role.authorize (F10)
  // Repositories: every query filters by project.id (or organization_id = project.id)
  readonly projects: ProjectRepo;
  readonly members: MemberRepo;
  readonly invitations: InvitationRepo;
  readonly invitationTokens: InvitationTokenRepo;
  readonly audit: AuditRepo;                        // insert + list only
  transaction<T>(fn: (tx: ProjectScope) => Promise<T>, opts?: { lockProject?: boolean }): Promise<T>;
}

/** Resolves membership + role for this call. Never cached across requests. */
export function forProject(session: Session | null, projectSlug: string): Promise<ProjectScope>;
//   throws NotFoundError when: no session, unknown slug, or user not a member.
//   One query: projects ⋈ member on (organization_id = projects.id AND user_id = session.user.id)
//   WHERE projects.slug = $1 — run inside crossProject("resolve project").

export function requireRole(scope: ProjectScope, ...allowed: Role[]): void;       // throws ForbiddenError
export function requirePermission(scope: ProjectScope, request: PermissionRequest): void; // throws ForbiddenError

/** The only way to run a query that is not pinned to one project. */
export function crossProject<T>(reason: string, fn: () => Promise<T>): Promise<T>;
```

- `NotFoundError` and `ForbiddenError` (`src/server/dal/errors.ts`) are the
  only errors services map to `not_found` / `forbidden`.
- `transaction(fn, { lockProject: true })` opens a Drizzle transaction,
  runs `SELECT id FROM projects WHERE id = $1 FOR UPDATE`, **re-checks the
  membership inside the transaction** (so a member removed concurrently
  can't act), and passes a transaction-bound scope to `fn`.
- User-level modules (`src/server/dal/users.ts`, `install.ts`, `tokens.ts`,
  `health.ts`) wrap each cross-project query in `crossProject(…)` with a
  specific reason.
- Wrappers in `src/server/auth/` run Better Auth calls inside
  `crossProject("better-auth", …)`.

## Lint rule (FR-035)

In `eslint.config.mjs`: `no-restricted-imports` for files matching
`src/**` **except** `src/server/dal/**`, `src/server/db/**`,
`src/server/auth/**`, `src/server/startup/**`. Restricted:

- paths: `pg`, `drizzle-orm/node-postgres`
- patterns: `@/server/db`, `@/server/db/*`, and relative imports matching
  `**/server/db`, `**/server/db/**`

Message: "Import the scoped DAL (`@/server/dal`) instead of the database
client." Tests under `tests/` may import the client (the harness needs it).
A test lints in-memory source with the ESLint Node API, using the path
`src/app/example.ts`, and expects this error (Story 6 #4).

## Project-owned registry (FR-036)

```ts
// src/server/db/project-owned.ts
export const projectOwnedTables = [
  { table: "projects",             scopeColumn: "id" },
  { table: "organization",         scopeColumn: "id" },
  { table: "member",               scopeColumn: "organization_id" },
  { table: "invitation",           scopeColumn: "organization_id" },
  { table: "invitation_tokens",    scopeColumn: "project_id" },
  { table: "membership_audit_log", scopeColumn: "project_id" },
] as const satisfies readonly ProjectOwnedTable[];
```

A later feature adds a line here for each new table. A unit test asserts that
every Drizzle table in `src/server/db/schema/` is either in this registry or
in an explicit `notProjectOwned` list (`user`, `session`, `account`,
`verification`, `install_state`), so forgetting to register a table fails.

## Scope check (test harness, FR-036, SC-008)

- `src/server/db/client.ts` builds `drizzle(pool, { logger })`. The logger
  forwards `(sql, params)` to `queryObservers` (an empty set in production).
  Each record captures `crossProjectReason` from the `crossProject`
  `AsyncLocalStorage`.
- `tests/setup/scope-recorder.ts` (a Vitest `setupFiles` entry) registers an
  observer, clears it `beforeEach`, and in `afterEach` runs
  `checkScope(records, projectOwnedTables)`. Any violation fails the test
  with:

  ```text
  Unscoped query on project-owned table "member" (needs "member"."organization_id" = $n):
    select "id", "role" from "member" where "member"."user_id" = $1
  ```

- Rules (`tests/helpers/scope-check.ts`, unit-tested on its own):
  1. Find the registered tables the statement references (`from`, `join`,
     `update`, `insert into`, `delete from`, quoted identifiers).
  2. **select/update/delete**: each referenced registered table must be
     *pinned*. That means either `"t"."col" = $n` (or unqualified
     `"col" = $n` when it is the only table) for its scope column, or joined
     by equality of scope columns to a pinned registered table. An `in (…)`,
     a range, or `or` across projects doesn't count.
  3. **insert**: the column list must include the scope column. Multi-row
     inserts are fine (one statement, values must be bound).
  4. Records with `crossProjectReason` are skipped and counted in a summary.
     Raw `sql\`` statements are checked by the same rules.
- `tests/integration/scope-check.test.ts` proves the check works. It issues
  a deliberately unscoped `select` on `member` through the raw client
  **outside** `crossProject` and expects `checkScope` to report it. It also
  checks that a pinned query passes.
