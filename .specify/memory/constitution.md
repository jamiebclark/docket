# Docket Constitution

Docket is a self-hosted, multi-project social scheduler and LLM post generator
(Facebook Pages, Instagram, Threads, Bluesky). The full product brief is
`docs/build-prompt.md`; verified platform and library facts are in
`docs/research/`; judgement calls are logged in `docs/decisions.md`. Read all
three before specifying or planning anything.

## Core Principles

### I. Verified facts over memory (NON-NEGOTIABLE)
Platform APIs and libraries change often. Endpoint names, parameters, scopes,
limits and library APIs MUST come from `docs/research/*.md` (which cite official
sources) or from the installed package's own docs/types in `node_modules`
(e.g. `node_modules/next/dist/docs/`). Never from memory. When the brief and the
research disagree, the research wins; record the disagreement in the spec. If a
needed fact is not in `docs/research/`, mark it `NEEDS RESEARCH` in the
artifact rather than guessing — phases cannot fetch the web.

### II. Nothing is "working" unless it ran
Never report a behaviour as working without executing it. Anything that needs
real credentials is covered by a mocked-HTTP test instead and reported as
"verified with mocks only". Provider tests never make live calls.

### III. Project isolation is enforced in one place
Every table except users/auth tables carries `project_id`. All access to
project-owned data goes through the scoped data-access layer (`src/server/dal/`),
which resolves membership and role on every call. Route handlers, server
actions, jobs and the public API MUST NOT import the raw database client;
a lint rule enforces this, and a test fails if a query touches a project-owned
table without a project scope. Roles (`owner`, `admin`, `editor`) are checked on
the server, never only in the UI.

### IV. One service layer, many callers
The UI, generation jobs, the scheduler tick and the public API call the same
service functions in `src/server/services/`. No duplicated logic per caller.
Slot allocation, approval policy and publishing each have exactly one
implementation.

### V. Providers are plug-ins
Adding a social provider means adding one folder under `src/providers/<key>/`
and registering it. No changes to the scheduler, composer or schema. Providers
declare capabilities and publish via a resumable step machine (`advance()`
returns continue / done / retryable_error / fatal_error / ambiguous). A publish
whose outcome is unknown is marked `ambiguous` and never retried
automatically: a missed post beats a duplicate post.

### VI. Boring, few dependencies
Stack is fixed: Next.js (App Router, standalone output), TypeScript strict,
Tailwind 4, Postgres via Drizzle ORM (`drizzle-orm/node-postgres`, SQL
migrations committed), Better Auth, Zod at every boundary, Vitest,
`@js-temporal/polyfill` for time-zone maths, sharp for images, S3-compatible
storage behind an interface. Adding any other runtime dependency or any
infrastructure (queues, Redis, etc.) requires a justification in plan.md and an
entry in `docs/decisions.md`. Pipeline phases cannot reach the npm registry:
dependencies are pre-installed (see `docs/decisions.md` #19). If a task needs a
package that is not in `package.json`, mark it `NEEDS DEPENDENCY: <pkg>` and
continue with other tasks — never hand-roll a substitute or guess its API.

### VII. Secrets never leak
Credentials are encrypted at rest (AES-256-GCM, key from env). Tokens never
reach the browser, logs, `publish_attempts`, error messages or test snapshots.
Env vars are validated at startup with Zod and documented in `.env.example`.

## Engineering Constraints

- Node 24 LTS, pnpm. Must run on local Docker Compose (web, worker, postgres)
  and on Neon with only the connection string changed. Migrations use the
  direct (non-pooled) URL; no session-level Postgres features (advisory locks,
  LISTEN) because Neon's pooler is in transaction mode.
- Scheduler work lives in `runTick()`: bounded (well under 30 s), safe to run
  concurrently, safe to kill mid-run. Claims use `FOR UPDATE SKIP LOCKED` plus
  a lease column; no provider call happens inside a held transaction.
- All times stored in UTC; wall-time conversion only via Temporal with
  explicit DST disambiguation.
- Accessibility: full keyboard use, visible focus, labelled controls, sensible
  empty and error states. Server components by default; client components only
  for interactivity. Follow the `docket-ui` skill for UI work.
- Out of scope until a spec says otherwise: video, stories, reels, analytics,
  inbox/comments, other platforms, billing, public sign-up, Netlify.

## Development Workflow

- **Commits**: Conventional Commits (`feat:`, `fix:`, `test:`, `refactor:`,
  `docs:`, `build:`, `ci:`, `chore:`), enforced by commitlint. Commit after
  each completed task (or small group of tightly related tasks) — small,
  logical, human-readable commits. Stage explicit paths only:
  `git add <path> <path>`. NEVER `git add -A`, `git add .` or `git commit -a`.
  Spec artifacts are committed by the phase that writes them, e.g.
  `git add specs/<feature>/spec.md && git commit -m "docs(spec): ..."`.
  Every commit message ends with the trailer
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Releases**: semantic-release on `main` derives versions from commit types,
  so commit types must be accurate (`feat` = user-visible capability, `fix` =
  bug fix; breaking changes use `!`).
- **Quality gates** (CI must be green before merge): `pnpm lint`,
  `pnpm typecheck`, `pnpm test` (Vitest, real Postgres service), `pnpm build`,
  Docker image build, `pnpm db:check` (migrations match schema) once Drizzle
  exists, commitlint on PR commits.
- **Run checks in proportion to the change** (they are expensive; CI runs the
  full set on every push anyway):
  - per task: only the affected tests, e.g. `pnpm vitest run <test files>` or
    `pnpm vitest run --changed`, plus `pnpm typecheck` when types changed and
    `pnpm lint <files>` for touched files. A task is done when those pass;
  - once per implement phase, at the end (the final pass): the full
    `pnpm lint && pnpm typecheck && pnpm test`, plus `pnpm db:check` if the
    schema changed and `pnpm build` if routes, config or server/client
    boundaries changed;
  - never run `pnpm build` or the full suite after every task, and never run
    the same full check twice without a code change in between.
- **Tests required** per the brief's quality bar: provider `validate`/`advance`
  with mocked HTTP incl. error and ambiguous paths; scheduler concurrency,
  kill-recovery, backoff, no-retry-on-ambiguous; slot double-booking, DST,
  reuse; membership roles, immediate removal, last owner, expired/revoked
  invitations; job item isolation, idempotency.
- **Docs**: each entry updates README / `docs/*.md` for what it adds, and
  appends any judgement call to `docs/decisions.md`.

## Governance

This constitution and `docs/build-prompt.md` supersede default agent habits.
Where they conflict, the constitution wins on process and the build prompt wins
on product behaviour; `docs/research/` wins on external facts. Amendments are
made by editing this file in a `docs(constitution):` commit with a version
bump.

**Version**: 1.2.0 | **Ratified**: 2026-10-03 | **Last Amended**: 2026-10-03
