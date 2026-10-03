# Review: Docket Foundation — Accounts, Projects, Members, Invitations and Project Isolation

Reviewed 58 file(s) changed across 6 commit(s), against `37eed2e` (merge-base with `origin/main`)...`1135f90` (HEAD), **plus the uncommitted working tree**. The working tree has 7 modified and 5 untracked paths that the last implement pass left uncommitted: `docs/decisions.md`, `next.config.ts`, `package.json`, `tasks.md`, `src/app/page.tsx`, `src/lib/action-result.ts`, `vitest.config.ts`, `.env.example`, `drizzle.config.ts`, `src/app/p/[projectSlug]/settings/layout.tsx`, `src/app/titles.test.ts` and `src/lib/action-result.test.ts`. So this review covers the present state: the committed diff and the uncommitted changes together.

**Read in full:** every source, test and config file in the diff and working tree:
- `src/**` (env, crypto, validation, lib helpers, proxy, app routes, shell and ui components)
- `tests/helpers/scope-check{,.test}.ts`
- `Dockerfile`, `docker-compose.yml`, `drizzle.config.ts`, `vitest.config.ts`, `next.config.ts`, `package.json`
- `.env.example`, the `docs/decisions.md` additions, `README.md` and `.github/workflows/ci.yml`

Also read in full: `spec.md`, `plan.md`, `tasks.md`, `.specify/memory/constitution.md`, and `contracts/{server-actions,dal,routes}.md`.

**Sampled:**
- `contracts/internal-interfaces.md` (secrets, tokens and delivery sections)
- `research.md` (F11, F17, D6, D16–D18, U1–U3)
- `contracts/env.md` (variable list, compared mechanically against `.env.example`)
- `quickstart.md` (grep only)

**Not reviewed:**
- `data-model.md`: no schema or migration landed to compare against it.
- `checklists/requirements.md`: it is a spec-quality checklist, not an obligation.

**Gates run here:**
- `pnpm lint`: exit 0.
- `pnpm typecheck`: exit 1 (see F1, F4).
- `pnpm test`: exit 1. Vitest's global setup file is missing (F5).
- Vitest with a throwaway config in `$TMPDIR`: no global setup, and `zod` aliased to the copy already in the pnpm store (`node_modules/.pnpm/zod@4.6.5`). Result: **11 files, 71 tests, all pass**.
- `pnpm build`: not run (see "What I could not check").

## Verdict

**No. This branch does not satisfy the spec and is not mergeable.**

The cause is structural, not a coding defect. T001 (installing `better-auth`, `drizzle-orm`, `pg`, `zod` and `drizzle-kit`) failed: the implement sandbox could not reach registry.npmjs.org. Every database, auth, DAL, service and page task depends on it. So 57 of 84 tasks are open, and all four P1 stories (US1, US2, US3, US6) are non-functional. There is no schema, migration, Better Auth instance, `forProject`, service or login/setup/signup/invitations/project-creation page, and `/` is still the create-next-app template.

What did land is mostly good, small, pure and well tested:
- the env parser
- the AES-256-GCM facility
- token helpers
- shared Zod schemas
- the auth-gate and last-project logic
- switcher logic
- the scope checker
- UI primitives
- the Compose file and `.env.example`

Several pieces of it still have to be fixed before the remaining work is built on them:
- The proxy's session-cookie names were written from memory, which the constitution forbids (F2).
- The scope checker, which backs the isolation guarantee, misses subquery and `NOT` cases (F3).
- Typecheck fails in `secrets.ts`, and installing the dependencies won't fix that (F4).
- Gate wiring was ticked before the files it points at existed, so `pnpm test` and the Docker build now fail (F5).
- T079 is ticked, but README.md was never touched (F6).
- The shared action-error mapper is missing three of T027's error types (F7).
- Env validation silently drops cross-field errors (F8).

**What to do:** a human installs the pinned dependencies (T001) somewhere with registry access and commits the lockfile. Then implement runs the existing open tasks plus the Phase 10 remediation tasks below. Until then, every further implement pass will hit the same block.

## Findings

- [ ] 🛑 BLOCKER F1 — The feature is not delivered: all P1 stories are non-functional because the dependency install (T001) never happened
      where:  package.json:21, src/app/page.tsx:6, src/app/p/[projectSlug]/[section]/page.tsx:24, specs/001-foundation-auth-projects/tasks.md:36
      why:    `dependencies` has only next/react/react-dom, so nothing under `src/server/{db,auth,dal,services,startup}` exists. There is no `drizzle/`, no `eslint.config.mjs` import ban, and no `/login`, `/setup`, `/signup`, `/invitations`, `/p/new` or `/p/[projectSlug]/layout.tsx`. `src/app/page.tsx` is still the create-next-app page; T081 only added a `metadata` export to it. The switcher, nav, badge and user menu components aren't mounted anywhere. With no project layout, `/p/<any-slug>/calendar` renders its placeholder for anyone whose request carries a cookie with the session-cookie name. There is no membership or existence check, which contradicts FR-023 / US6 #1 in the present state.
      owed:   Install the T001 dependencies from an environment that can reach the registry, and commit `package.json` + `pnpm-lock.yaml`. Then complete the existing open tasks T012–T078; they already describe the missing work, so no new tasks are added for it.
      traces: US1, US2, US3, US6; FR-003–FR-006, FR-009–FR-037; SC-001, SC-003–SC-006, SC-009–SC-011

- [ ] 🛑 BLOCKER F2 — The proxy recognises sessions by cookie names written from memory, not from research or the installed package
      where:  src/lib/auth-gate.ts:7, src/proxy.ts:10, src/lib/auth-gate.test.ts:29
      why:    Constitution I (NON-NEGOTIABLE) requires library facts to come from `docs/research/` or the installed package, never from memory. Research F11 and D18 say the proxy should call `getSessionCookie()` from `better-auth/cookies`. Instead, T039 hard-coded `better-auth.session_token` / `__Secure-better-auth.session_token` because the package wasn't installable, and did not mark the names `NEEDS RESEARCH`. The unit test asserts the guessed strings back to themselves, so it can't catch a wrong guess. If either name, or a configured cookie prefix, differs, every signed-in request to a protected path redirects to `/login`, which locks out all users.
      owed:   After F1, call `getSessionCookie(request)` (F11) from `src/proxy.ts` and pass its result into the pure `loginRedirectFor`. Delete the `SESSION_COOKIES` constant and the test case that asserts it.
      traces: FR-013, constitution I, research D18

- [ ] MAJOR F3 — The scope checker accepts queries that read other projects' rows (subqueries and `NOT`)
      where:  tests/helpers/scope-check.ts:49, tests/helpers/scope-check.ts:61, tests/helpers/scope-check.ts:70, tests/helpers/scope-check.test.ts:29
      why:    When the same table appears more than once without an explicit alias, every occurrence gets the table name as its alias (`:49`). And `whereClause` is "everything after the first `where`" (`:61`). Together, a pin in a subquery pins the outer, unpinned reference too. Separately, only `or` is treated as disjunctive (`:70`), so a negated pin counts as a pin. I ran `checkScope` against the registry entries for `projects`, `member` and `invitation`, and both of these pass with **no violation**:
              `select "member"."organization_id" from "member" where "member"."user_id" in (select "user_id" from "member" where "member"."organization_id" = $1)` (returns every project of every user in project $1)
              `select * from "member" where not "member"."organization_id" = $1` (returns every other project's members)
              This contradicts `contracts/dal.md` rule 2 ("each referenced registered table must be pinned") and SC-008 ("100%… limited to a single project"). T019's tests have no subquery or `NOT` case, so the checker meant to catch isolation bugs has a hole that its own tests can't see.
      owed:   Fail closed. Check each occurrence of a registered table separately: per SELECT scope, or by flagging any statement that has a nested `select` or a `not` touching a registered table unless every occurrence is pinned. Add both probe statements above as tests that expect a violation.
      traces: FR-036, SC-008, US6 #3, constitution III

- [ ] MAJOR F4 — Typecheck fails in the secrets facility for a reason that installing the dependencies won't fix
      where:  src/server/crypto/secrets.ts:46, src/server/crypto/secrets.ts:47, src/server/crypto/secrets.ts:53, src/server/crypto/secrets.test.ts:43
      why:    The repo's `tsconfig.json` has `noUncheckedIndexedAccess: true`, so `parts[3]`, `parts[4]` and `parts[5]` are `string | undefined`. `Buffer.from(…, "base64url")` then fails with TS2769, and `p[0]` in the test fails with TS18048. T021 and T023 are ticked, but the constitution says a task isn't done until typecheck passes for the code it touched. The notes on T042 and T082 blame only the missing `zod`, so a pass that installs the dependencies will still find typecheck red and won't know why.
      owed:   Narrow the parts, e.g. destructure `const [prefix, version, kid, iv, tag, ct] = parts` after the length check, with a guard that each is defined. Do the same in the test. Re-run `tsc --noEmit`.
      traces: FR-007, FR-039, constitution quality gates

- [ ] MAJOR F5 — Gate wiring was ticked before the files it references existed, so `pnpm test` and the Docker build now fail outright
      where:  vitest.config.ts:12, vitest.config.ts:13, Dockerfile:36, package.json:15, .github/workflows/ci.yml:61
      why:    T005 (uncommitted) adds `globalSetup: tests/setup/global-setup.ts` and `setupFiles: tests/setup/scope-recorder.ts`. Neither file exists (T016 and T020 are blocked), so `pnpm test` exits 1 with `ERR_LOAD_URL` before running a single test, though the 71 unit tests pass without it. T041 (committed at HEAD) adds `COPY --from=build /app/drizzle ./drizzle`, but `drizzle/` doesn't exist (T014 is blocked), so CI's `docker` job fails on this branch today. T002's `db:check` runs `scripts/check-migrations-current.mjs`, which doesn't exist (T015). Committing the untracked `drizzle.config.ts` turns that CI step on (`hashFiles('drizzle.config.ts')`).
      owed:   Don't commit the `globalSetup`/`setupFiles` lines or `drizzle.config.ts` until T014–T016 and T020 have landed. Once they have, confirm that `pnpm test`, `pnpm db:check` and `docker build .` each exit 0.
      traces: FR-039, FR-037, constitution quality gates

- [ ] MAJOR F6 — FR-040 docs: T079 is ticked but README.md was never changed, and the decisions log reports an observation nobody made
      where:  README.md:15, README.md:24, docs/decisions.md:102
      why:    README.md still has only the scaffold "Development" and `docker build` sections. It has none of what T079/FR-040 require: Compose usage, bootstrap vs `/setup`, the setup-exposure security note, session/rate-limit defaults, how to register a project-owned table, and the Neon pooled/direct URLs. `git log -- README.md` shows no commit on this branch. The new decisions entry says U2 (`nextCookies()` ordering) showed "no behavioural difference observed". But there is no auth config and `better-auth` isn't installed, so nothing was observed (constitution II).
      owed:   Write the README sections T079 lists, describing only behaviour that exists when they are written. Reword the U2 line to "not yet verified; settled when `src/server/auth/auth.ts` lands".
      traces: FR-040, SC-001, constitution II

- [ ] MAJOR F7 — The shared action-error mapper is missing three of T027's errors and replaces conflict messages and fields with a generic message
      where:  src/lib/action-result.ts:35, src/lib/action-result.ts:59, specs/001-foundation-auth-projects/tasks.md:82, specs/001-foundation-auth-projects/contracts/server-actions.md:44
      why:    T070 (ticked) says the helper is "used by every `actions.ts`". It maps `NotFoundError`, `ForbiddenError`, `LastOwnerError`, `ConflictError` and an `UnauthenticatedError` that no task defines. It doesn't map `InvitationInvalidError`, `EmailMismatchError` or `SetupUnavailableError` (T027), so those rethrow and the server action crashes. The spec instead requires:
              - "This invitation is no longer valid" for a used or raced link (US3 #7, edge case "Invitation link raced")
              - "setup already complete" for the losing side of a setup race (FR-012)
              - the email-mismatch message (US3 #11)
              Lines 59–62 also discard `ConflictError`'s own message and field. So "slug already used" can't render next to the slug field (US2 #3), and a duplicate invite loses "Regenerate the existing invitation instead" (contract line 44, spec edge case "Duplicate invite"). Matching by `err.name` also silently depends on every class in the not-yet-written `errors.ts` setting `this.name`.
      owed:   Map every T027 error to its `ErrorCode`. Let `ConflictError` (and `InvitationInvalidError` if useful) carry a fixed user-facing message and an optional `field`, and pass both through as `message`/`fieldErrors`. Drop `UnauthenticatedError`, or add it to T027's list. Add a test per mapping.
      traces: FR-011, FR-012, FR-029, US2 #3, US3 #7, US3 #11, contracts/server-actions.md

- [ ] MAJOR F8 — Env validation doesn't list every problem: the cross-field checks are skipped whenever any base field fails hard
      where:  src/server/env.ts:63, src/server/env.ts:24, src/server/env.ts:60, src/server/env.test.ts:30
      why:    Zod doesn't run an object-level `superRefine` after a non-continuable issue in the shape. That covers a missing required variable, or the `z.NEVER` returned from the int and boolean transforms. The bootstrap pairing, bootstrap email/password and `DATABASE_URL_DIRECT` checks all live in that `superRefine`. I tested `parseEnv` with zod 4.6.5:
              - `DATABASE_URL` unset with `DATABASE_URL_DIRECT=mysql://x` → reports only `DATABASE_URL`
              - `BOOTSTRAP_ADMIN_EMAIL` set, no password, `DATABASE_POOL_MAX=0` → reports only `DATABASE_POOL_MAX`
              FR-001 requires "listing every missing or malformed variable". The "every issue" test passes `{}`, which never exercises the cross-field checks.
      owed:   Run the cross-field checks whatever the base result. For example, compute them in `parseEnv` from the raw source and merge them with the Zod issues, or use the refinement `when` option (`zod/v4/core/checks.d.ts:11`). Add both cases above as tests.
      traces: FR-001, SC-002, US1 #5

- [ ] MINOR F9 — The root-redirect consumer needs `joinedAt`, but its planned producer doesn't return it
      where:  src/app/root-redirect.ts:1, src/app/root-redirect.ts:9, specs/001-foundation-auth-projects/contracts/server-actions.md:60
      why:    `decideRootRedirect` sorts by `joinedAt` to pick the "earliest-joined" project (`contracts/routes.md`). But `projects.listMine` is specified as `{ slug, name }[]` ordered by name, "for the switcher and `/`". A T047 written to that contract won't fit T049's consumer. Typecheck will catch it, but the likely shortcut (a fake `joinedAt`) would quietly change the fallback order. FR-018 itself is satisfied either way.
      owed:   Have `listMine` (or `users.listMyProjects`) also return `joinedAt` from `member.created_at`, and say so in the T046/T047 implementation.
      traces: FR-018, US2 #5

- [ ] MINOR F10 — Two lists each repeat something another pass already defined (token shape, section list)
      where:  src/server/crypto/tokens.ts:14, src/lib/validation/token.ts:3, src/components/shell/LeftNav.tsx:6, src/app/p/[projectSlug]/[section]/page.tsx:4
      why:    The 43-character base64url token regex appears twice: in `isWellFormedToken` and in `invitationTokenSchema`. The nav sections appear in both `NAV_SECTIONS` and `PLACEHOLDERS`. Later features edit one list and the copies drift apart. For example, a section added to the nav but not to the placeholder allowlist returns a 404.
      owed:   Build `invitationTokenSchema` on `isWellFormedToken` (or the reverse), and derive `PLACEHOLDERS` from `NAV_SECTIONS` minus `settings`.
      traces: FR-020, FR-026, constitution IV (single implementation)

- NOTE F11 — These parts are sound and match their contracts exactly:
  - `src/server/crypto/secrets.ts`: the `enc:v1:<kid>:<iv>:<tag>:<ct>` format, the kid derivation, a fixed error with no cause, and no logging (D16).
  - `src/server/crypto/tokens.ts` (D6).
  - `src/lib/validation/*` (D17 shapes and reserved slugs).
  - `src/lib/safe-redirect.ts`, `src/lib/auth-gate.ts:31` (`lastProjectSlugFor`) and `src/components/shell/switcher-logic.ts`.

  `.env.example` documents all 12 variables in `contracts/env.md`. The tests for these modules check behaviour, not implementation: tamper of each part, wrong key, AAD binding, and value-leak scans. The one exception is the cookie-name test in F2.

- NOTE F12 — The last implement pass left its output uncommitted (see the header list), including the tick changes for T002–T006, T070, T071 and T079–T081. Review can't commit code, so the next implement pass has to commit or revise these files. They must not go into one blanket commit: F5 explains why `vitest.config.ts` and `drizzle.config.ts` should wait.

## Coverage

Each row counts that section's FR, SC or principle IDs, checked against the present state of the code.

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements | 41 | 2 | 16 | 21 | 2 |
| Success criteria | 11 | 0 | 3 | 8 | 0 |
| Constitution principles | 7 | 4 | 1 | 1 | 1 |

Functional requirements:
- **Satisfied:** FR-002 (`.env.example`) and FR-007 (encryption facility; behaviour verified by 8 passing tests, typecheck issue in F4).
- **Partial:** FR-001, 003, 006, 008, 010, 013, 017, 018, 019, 020, 026, 028, 036, 038, 040, 041.
- **Absent:** FR-004, 005, 009, 011, 012, 014, 015, 016, 021, 022, 024, 025, 027, 029, 030, 031, 032, 033, 034, 035, 037.
- **Contradicted:** FR-023 (placeholder pages render for any slug, F1) and FR-039 (typecheck, test and docker gates fail, F4 and F5).

Success criteria:
- **Partial:** SC-002 (parser names variables but there's no startup hook), SC-007 (switcher logic built but not mounted), SC-008 (checker exists, with holes, F3).
- **Absent:** the rest.

Constitution principles:
- **Satisfied:** VI (no dependency added outside the fixed stack) and VII (landed code keeps secrets out of errors and logs).
- **Contradicted:** I (F2).
- **Partial:** II (F6, plus T005/T021/T023/T041 ticked while their gates fail).
- **Absent:** III (no DAL and no import ban; the checker has holes).
- **Counted as satisfied without being exercised:** IV (no services yet) and V (no providers in scope).

The task list has 27 ticked and 57 unticked. Of the 27 ticked, 4 contradict their gate or their own text: T005, T023, T041, T079.

## What I could not check

- **Better Auth's real session-cookie names, and U1/U2:** the package isn't installed, so I couldn't confirm or refute the F2 guess.
- **Any database behaviour:** there's no Postgres code, and I didn't start a Postgres. This includes migrations, `db:check`, scope recording against real Drizzle SQL, races and last-owner locking.
- **`pnpm build`:** not run. It would fail at its type-check step (F4 plus the missing `zod`), and `next build` can rewrite the tracked `tsconfig.json`, which is outside this phase's write scope.
- **`docker build` and `docker compose up`:** no image build was attempted. The F5 conclusion comes from reading `Dockerfile:36` against the absent `drizzle/` directory.
- **Browser behaviour:** Ctrl/⌘+K focus handling and its return, the ≤ 4-keystroke switch (SC-007), the native `<dialog>` focus trap, and screen-reader announcements from `Field`/`CopyField`. No browser is available to this phase.
- **CI on GitHub:** the conclusion that the `check` and `docker` jobs would fail comes from running the same commands locally, not from a CI run.
- **Neon (SC-011):** no connection string is available.
