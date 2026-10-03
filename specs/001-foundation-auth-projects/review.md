# Review: Docket Foundation — Accounts, Projects, Members, Invitations and Project Isolation

Reviewed 168 file(s) changed across 45 commit(s), against `37eed2e` (merge-base with `origin/main`)...`947b64f` (HEAD). This is the fourth review of this branch.

Since the third review (`86f8c33`), nine commits landed:
- six from the implement pass (`433522a`…`6265756`, T096–T101);
- three at 10:11 from a concurrent session with Docker access (`cde679d`, `739864d`, `947b64f`). These arrived while this review was running.

HEAD moved twice under the review, so everything below was re-checked against `947b64f`. The working tree is clean apart from `tasks.md`, where the implement pass left its T096–T101 ticks and the T100/T101 section uncommitted.

**Read in full:**
- every hunk of `86f8c33..947b64f`:
  - `scripts/prestart.mjs`, `Dockerfile`, `package.json` (`build`, `build:prestart`);
  - `src/server/dal/scope.ts`, `src/server/services/{projects,setup}.ts`, `src/server/services/invitations/index.ts`, `src/server/env.ts`, `src/server/startup/index.ts`;
  - `src/app/{page,root-redirect}.ts(x)`, `src/app/login/page.tsx`, `src/app/p/new/new-project-form.tsx`, `src/lib/validation/slug.ts`, `eslint.config.mjs`;
  - `README.md`, `docs/decisions.md`;
  - `tests/integration/{project-validation,lock-recheck,anonymous-entry}.test.ts`, `tests/lint/db-import.test.ts`, `tests/startup/prestart.test.ts`, `src/server/startup/startup.test.ts`, `src/app/root-redirect.test.ts`;
- alongside them: `src/proxy.ts`, `src/server/dal/install.ts`, `src/app/setup/page.tsx`, `src/server/db/project-owned.ts`, `src/lib/validation/{index,timezone,email}.ts`, `next.config.ts`, `docker-compose.yml`, `.dockerignore`, `.github/workflows/ci.yml`, `tests/setup/global-setup.ts`;
- the spec artifacts: `spec.md`, the constitution, `tasks.md`, and the third `review.md`.

**Sampled:** the lines that the third review's MINOR findings F5–F9 cite, to check whether each is still open (all are; carried below as F3–F7).

**Not re-read:** the code from `de61583` and earlier that this range didn't touch. The third review read it in full, and none of the nine new commits change it. `pnpm-lock.yaml` and `drizzle/meta/*` are generated.

**Gates:**

| Gate | Result |
|---|---|
| `pnpm lint` | exit 0 (run on `6265756`; no source changed after it) |
| `pnpm typecheck` | exit 0 (run on `6265756`) |
| `pnpm test` (`DATABASE_URL=…127.0.0.1:5433/docket_test`) | 33 files, 250 tests, all pass (run on `6265756`; no test or source changed after it) |
| `pnpm db:check` | "Migrations are current." |
| `next build` + the `build:prestart` esbuild step (clean `git archive 947b64f` copy in `$TMPDIR`, env holding only `DATABASE_URL`, as in CI) | exit 0; `.next/standalone/scripts/prestart.mjs` is 468 KB |

**Probes.** Every probe ran in `$TMPDIR` against throwaway `docket_review4*_test` databases on the local Postgres 17, all dropped afterwards. The runner-stage layout was assembled exactly as the `Dockerfile`'s `COPY` lines do it, and started with its `CMD` (`node scripts/prestart.mjs`).

1. **The entrypoint at `6265756`,** before `cde679d`: it exits 1 on every start with "Docket: database migration failed (ERR_MODULE_NOT_FOUND). Not starting." Next bundles `drizzle-orm` into `.next/server/chunks`, so the standalone `node_modules` held only `next`, `pg`, `react`, `react-dom` and `sharp`. `node server.js` from the same layout worked. So T101 had briefly turned a working image into one that never starts. `cde679d` fixed it independently, and the commit message describes this exact failure. This was a BLOCKER until 10:11. It is resolved at HEAD, and the missing guard is F1.
2. **The entrypoint at `947b64f`, fresh install:**
   - "migrations applied" at 194 ms, before "✓ Ready" at 341 ms;
   - `/api/health` 200;
   - `/` → 307 `/login`, then `/login` → 307 `/setup`, and `/setup` 200;
   - `/p/x` → 307 `/login?next=%2Fp%2Fx`;
   - no second migration from `instrumentation.ts`, so the `DOCKET_PREMIGRATED` hand-off works.
3. **Migration failure** (a pre-existing conflicting `"user"` table): exits 1 at 213 ms with "…migration failed. Not starting.". Nothing listens. FR-004 is met.
4. **Blank `CREDENTIALS_ENCRYPTION_KEY`, reachable database:**
   - migrations are applied first (one `drizzle.__drizzle_migrations` row written);
   - "Ready" prints, then the configuration error names the variable at 516 ms, without its value;
   - exit 1.
5. **Blank key and unreachable database:** exits 1 at 67 ms, naming only the migration failure (F2).
6. **Shared validation:** `+02:00`, `GMT+2` and `UTC+2` are rejected; `Etc/GMT+2`, `EST` and `Europe/London` are accepted.
7. **README session claims vs the installed package:** `node_modules/better-auth/dist/context/create-context.mjs:147-148` gives `expiresIn` 7 days and `updateAge` 1 day, and `src/server/auth/auth.ts:44` sets `rateLimit: { enabled: true }`. Both match the README.

## Verdict

**Mergeable, once a human finishes T083 and T084.** Every blocking finding from the third review is fixed, and each fix is verified, not just ticked:
- **F1:** the services now build from the shared `src/lib/validation` schemas, and `tests/integration/project-validation.test.ts` drives the spec's cases through `projects.create` and `projects.updateSettings` against real Postgres.
- **F2:** the project lock is now its own statement, and membership is re-read in a fresh snapshot (`src/server/dal/scope.ts:97-103`). `tests/integration/lock-recheck.test.ts` reproduces the race and would fail on the old code.
- **F3:** relative raw-db imports now fail lint, with four regression cases.
- **F4:** the README and decisions log now describe the code as it is (probe 7).
- **T100:** a fresh install sends anonymous visitors to `/setup`, which the live probe confirms.
- **T101:** migrations now run before the server listens.

The seam this phase exists to catch did appear once in this range. T101's entrypoint was unit-tested with an injected migrator and passed every gate, but it could not start in the real image (probe 1). A concurrent session caught it with Docker and fixed it in `cde679d`, and I re-verified that fix from a clean build (probes 2–4).

What remains is not blocking:
- No automated gate would catch that entrypoint regression again (F1).
- The pre-start migration now runs before configuration is validated (F2).
- The third review's five MINORs are still open (F3–F7).

I would merge after the human-only checks (T083 browser survey, T084 Neon), and fix F1 and F2 next, because they guard the self-hoster's one-command path.

## Findings

- [ ] MINOR F1 — No automated gate runs the real container entrypoint. The T101 regression (every start exits `ERR_MODULE_NOT_FOUND`) passed lint, typecheck, all 250 tests, build and CI's Docker job, and only a manual `docker compose up` caught it
      where:  tests/startup/prestart.test.ts:13, tests/startup/prestart.test.ts:25, tests/startup/prestart.test.ts:36, scripts/prestart.mjs:16, package.json:8, .github/workflows/ci.yml:68
      why:    Every `prestart` test injects `migrate`. So `defaultMigrate`, the only code that depends on what is resolvable inside the standalone image, never runs under test. CI's `docker` job builds the image but never starts it.
              At `6265756` the image could not start (probe 1), and nothing failed. `cde679d` fixed it by bundling the script with esbuild (`package.json:8`), and probes 2–4 confirm the fix. But whether the bundle can still resolve `pg` and `drizzle-orm`'s migrator is now checked by nothing. Bumping esbuild flags, adding a native or optional dependency, or moving `server.js` would silently break the self-hoster's only start path again.
      owed:   Add a smoke step to CI. Two options:
              - in the `check` job, which already has Postgres: after `pnpm build`, assemble `.next/standalone` as the `Dockerfile` does, run `node scripts/prestart.mjs`, assert `/api/health` returns 200, and assert that a deliberately failing migration exits 1 before the port accepts connections;
              - or `docker run` the image built in the `docker` job against a Postgres service.
      traces: FR-004, FR-006, SC-011 (local half), constitution II, constitution quality gates ("Docker image build")

- [ ] MINOR F2 — The pre-start migration runs before any configuration is validated. A misconfigured app migrates the database before refusing to start, and when the database is unreachable the offending variables are never named
      where:  scripts/prestart.mjs:10, scripts/prestart.mjs:11, scripts/prestart.mjs:37, src/server/startup/index.ts:29
      why:    `migrationUrl` looks only at `DATABASE_URL(_DIRECT)` and `MIGRATE_ON_START`. Before T101, `runStartup` parsed the whole env first and only then migrated. The measured behaviour now:
              - blank key, database up: migrations are written, then the app exits naming the variable at 516 ms (probe 4);
              - blank key, database down: only "database migration failed. Not starting." at 67 ms (probe 5);
              - `MIGRATE_ON_START=0`, which `env.ts` rejects because only `true`/`false` are allowed, still migrates, because `prestart` only skips on the exact string `"false"`.
              US1 #5 says the database-preparation step "stops immediately with a message naming each offending variable". FR-001 requires "listing every missing or malformed variable".
              On the documented Compose path the impact is small. Compose itself refuses to start without the two secrets (`docker-compose.yml:30-31`), and Postgres is health-gated. So SC-002 still holds, and the migrations written are ones the app would apply anyway.
      owed:   Validate before migrating:
              - bundle `src/server/env.ts` into `prestart` (esbuild resolves the `@/` alias through `tsconfig.json`);
              - call `parseEnv` first, and on failure print `formatEnvIssues` and exit 1;
              - take `MIGRATE_ON_START` and the migration URL from the parsed env, not from raw strings.
      traces: FR-001, US1 #5, SC-002

- [ ] MINOR F3 — The last-owner demotion message still has no "transfer ownership first" hint, and the raced or invalid invitation message still differs from the fixed copy (third-review F5, unchanged)
      where:  src/server/dal/errors.ts:30, src/server/services/members.ts:58, src/lib/action-result.ts:50, specs/001-foundation-auth-projects/contracts/routes.md:23
      why:    `changeRole` throws a bare `new LastOwnerError()` (`members.ts:58`), whose default message has no transfer hint. US4 #5 asks for one. Only `leave` (`members.ts:103`) passes a custom message.
              `invitation_invalid` reads "This invitation is invalid, expired or already used." The `/signup` page uses the `routes.md` sentence ("…no longer valid. Ask the person who invited you for a new one.") for the same outcome.
      owed:   Put the hint in `LastOwnerError`'s default message. Use the `routes.md` sentence for `invitation_invalid`. Assert both in tests.
      traces: FR-024, US4 #5, US3 #7

- [ ] MINOR F4 — Field errors in three hand-rolled forms are rendered without an `aria-live` region, unlike the shared `Field` primitive, so a server-side field error is not announced (third-review F6, unchanged)
      where:  src/app/p/new/new-project-form.tsx:35, src/app/p/[projectSlug]/settings/settings-form.tsx:27, src/app/setup/setup-form.tsx:28, src/components/ui/Field.tsx:40
      why:    The form-level `role="alert"` renders only when there are no field errors. So "That URL name is already taken." beside the slug field is silent for a screen-reader user. Those three files contain no `aria-live` at all. FR-041 asks for "inline announced errors".
      owed:   Use `Field` from `src/components/ui/` in these forms, or give their error `<span>`s `aria-live="polite"`.
      traces: FR-041, constitution (Accessibility)

- [ ] MINOR F5 — The scope-check summary is never printed, so the cross-project query counts that `contracts/dal.md` promises are invisible (third-review F7, unchanged)
      where:  tests/setup/scope-recorder.ts:40, specs/001-foundation-auth-projects/contracts/dal.md:112
      why:    The summary hangs off `process.on("beforeExit")`, which never fires in a Vitest worker. In the full 250-test run here, the output has 0 `scope-check` lines. The check itself works, and the third review's probe 5 confirmed it fails an unscoped query.
      owed:   Print the summary from an `afterAll` in the setup file, or from a reporter or `globalSetup` teardown. Then confirm the line appears in `pnpm test` output.
      traces: FR-036, constitution II

- [ ] MINOR F6 — The DAL still has two locked-transaction abstractions and two cross-project helpers, and the invitations service imports from past the DAL index (third-review F8, unchanged)
      where:  src/server/dal/invitations.ts:89, src/server/dal/scope.ts:47, src/server/db/cross-project.ts:11, src/server/dal/index.ts:4, src/server/services/invitations/index.ts:18, src/server/services/invitations/index.ts:23
      why:    `withLockedProject` gives write access to a project's repos without resolving membership. That is right for invitees, but it is unlabelled and not wrapped in `crossProject`, so it sits beside `scope.transaction({ lockProject })`. `crossProject` is a pass-through to `runCrossProject`. And `dal/index.ts`, "the sanctioned surface", doesn't export the invitee functions that the service uses.
      owed:   Rename `withLockedProject` to say it's for invitees (for example `forInvitee`), wrap it in `crossProject`, export it through `dal/index.ts`, and keep a single cross-project helper.
      traces: FR-034, constitution III

- [ ] MINOR F7 — A few small rules are still written twice, and an empty `DATABASE_URL_DIRECT=` is handled three different ways (third-review F9, plus one more site)
      where:  drizzle.config.ts:4, tests/setup/global-setup.ts:12, src/server/env.ts:99, scripts/prestart.mjs:12, src/server/crypto/tokens.ts:14, src/lib/validation/token.ts:3, src/components/shell/LeftNav.tsx:6, src/app/p/[projectSlug]/[section]/page.tsx:4
      why:    `env.ts` and `prestart.mjs` fall back with `||`, but `drizzle.config.ts` and the test `globalSetup` use `??`. So an exported empty `DATABASE_URL_DIRECT=` points `drizzle-kit` and the test harness at `""`. The token regex is written twice, and the nav sections twice (`NAV_SECTIONS`, `PLACEHOLDERS`).
      owed:   Use `||` in both `??` sites. Build `invitationTokenSchema` on `isWellFormedToken`. Derive `PLACEHOLDERS` from `NAV_SECTIONS`.
      traces: FR-002, FR-020, FR-026, constitution IV

- NOTE F8 — Status of the third review's findings and the survey tasks at HEAD:
  - **F1** (BLOCKER, divergent validation): resolved.
    - `src/server/services/projects.ts:2-8` imports the shared schemas, and `setup.ts`, `invitations/index.ts` and `env.ts` use `emailSchema` and `passwordSchema`.
    - `slugify` is capped at `SLUG_MAX` (`new-project-form.tsx:15`).
    - Ten integration cases, through both service entry points, check the reserved, short, offset, long-name and 45-character inputs.
  - **F2** (MAJOR, stale re-check): resolved. `scope.ts:97-103` locks, then re-resolves. `projects.updateSettings` re-checks inside the transaction, and both removal and demotion races are tested.
  - **F3** (MAJOR, lint hole): resolved. `eslint.config.mjs:23` adds `**/db` and `**/db/**`, `tests/lint/db-import.test.ts:23-32` covers the four imports, and `pnpm lint` on the tree is clean.
  - **F4** (MAJOR, stale docs): resolved. `README.md:46-75` and `docs/decisions.md:101-102` were checked against the code and Better Auth (probe 7).
  - **T100**: resolved (probe 2).
  - **T101**: resolved at `cde679d` (probes 1–3). Its missing regression guard is F1 here.
  - The third review's NOTE F12 (`/login` sends no `Referrer-Policy`, although `next` can carry an invitation token) still stands as an observation.

- NOTE F9 — `tasks.md` bookkeeping for a human. This review may not edit existing tasks.
  - The T096–T101 ticks and the "Front-end survey findings" section are uncommitted in the working tree.
  - T089 is still open, marked "BLOCKED: `docker build .` needs the Docker socket". But decisions.md #20 records a successful `docker compose up --build`, and its other conditions held at the third review, so it looks closable by whoever ran that.
  - T083 is partly done: the survey's curl items passed. Its browser items are still open.
  - The third review's NOTE F11 annotations (T039, T049, T051, T054, T060) are still stale.

## Coverage

Each item was checked against `947b64f`. "Not checkable here" means it needs a browser, Docker itself or Neon (see the last section).

| Checked | Count | Satisfied | Partial | Absent | Contradicted | Not checkable here |
|---|---|---|---|---|---|---|
| Functional requirements | 41 | 39 | 2 | 0 | 0 | 0 |
| Success criteria | 11 | 7 | 1 | 0 | 0 | 3 |
| Constitution principles | 7 | 5 | 1 | 0 | 0 | 0 (V is N/A) |

**Functional requirements:**
- **Partial:** FR-001 (F2) and FR-041 (F4).
- **Satisfied, with evidence gathered here:**
  - FR-004 and FR-006 (image path) by probes 2–4 on the runner layout. Docker itself was observed only by the concurrent session (decisions.md #20).
  - FR-010 and FR-015 by `project-validation.test.ts` and probe 6.
  - FR-012 and FR-013 by probe 2.
  - FR-022 and FR-034 by `lock-recheck.test.ts`.
  - FR-035 by `db-import.test.ts`.
  - FR-039 by the five gates.
  - FR-040 by probe 7.
- **Satisfied at the third review and untouched since:** the rest, with the evidence listed there (`permissions.test.ts`, `invitation-tokens.test.ts`, `audit.test.ts`, `auth-endpoints.test.ts`, the scope recorder).

**Success criteria:**
- **Satisfied:**
  - SC-002 (516 ms through the real entrypoint, variable named, no value);
  - SC-004 and SC-006;
  - SC-005, now including the concurrent case;
  - SC-008, SC-009 and SC-010.
- **Partial:** SC-011. The local half passes through the real entrypoint; the Neon half is "not verified", and is recorded as such.
- **Not checkable here:** SC-001, SC-003 and SC-007.

**Constitution principles:**
- **Satisfied:** I (README facts read from the installed package), III, IV, VI and VII. VI holds because `esbuild` is a build-time devDependency, already a transitive dependency, and logged as decisions.md #20.
- **Partial:** II. T078 is still ticked on a summary the suite never prints (F5), and the entrypoint has no executed regression guard (F1).
- **N/A:** V.

**Tasks:** 98 ticked, 3 open (T083, T084 and T089; see F9).

## What I could not check

- **`docker build` and `docker compose up`:** the Docker socket isn't reachable from this sandbox. I rebuilt the runner stage's file layout by hand from a clean build and ran its `CMD`, which exercises everything the image does except the Linux base image, the `nextjs` user's file permissions, and Compose's health-gated ordering. The concurrent session reports a successful `docker compose up` in `cde679d` and decisions.md #20. I didn't observe that run.
- **Anything in a browser** (T083's remaining items):
  - the login → `next` round trip, setup, sign-up, accept and decline through the UI;
  - server-action error rendering, and the redirect after a slug change;
  - Ctrl/⌘+K focus and its return, and ≤ 4 keystrokes (SC-007);
  - `<dialog>` focus trapping and screen-reader announcements (F4 comes from reading the code);
  - the last-project cookie surviving a browser restart;
  - SC-001 and SC-003 timings.
- **Better Auth U2** (`nextCookies()` ordering on a server-action sign-in): still "not verified (needs a browser)", as `docs/decisions.md:101-102` now says.
- **Login rate limiting keyed on a real client IP behind Compose:** the test sets `x-forwarded-for` itself.
- **Neon (SC-011, T084):** no connection string is available.
- **CI on GitHub:** the gates were run locally with CI's env shape. The workflow run itself wasn't observed.
