# Review: Docket Foundation — Accounts, Projects, Members, Invitations and Project Isolation

Reviewed 73 file(s) changed across 9 commit(s), against `37eed2e` (merge-base with `origin/main`)...`951d0a7` (HEAD), **plus the uncommitted working tree**. This is the second review of this branch. Since the first one (`122e4da`):

- the owner installed the dependencies (`7c999ff`) and amended the constitution (`951d0a7`);
- one implement pass worked Phase 10 (T085–T092) and committed nothing.

So the working tree holds 16 modified and 6 untracked paths. This review covers the present state (committed plus uncommitted). Where the two differ, it says which one a finding is about.

**Read in full:**
- every file the last implement pass touched: `src/proxy.ts`, `src/lib/auth-gate{,.test}.ts`, `src/lib/action-result{,.test}.ts`, `src/server/dal/errors.ts`, `src/server/env{,.test}.ts`, `src/server/crypto/secrets{,.test}.ts`, `tests/helpers/scope-check{,.test}.ts`, `README.md`, the `docs/decisions.md` additions, `vitest.config.ts`, `next.config.ts`, `drizzle.config.ts`, `.env.example`, `src/app/page.tsx`, `src/app/titles.test.ts` and `src/app/p/[projectSlug]/settings/layout.tsx`;
- `tasks.md` (and its diff against HEAD), `spec.md`, `plan.md`, `.specify/memory/constitution.md`, `contracts/{dal,server-actions}.md`, `docker-compose.yml`, `Dockerfile`, `.github/workflows/ci.yml`, `package.json` and `pnpm-workspace.yaml`;
- the pipeline's `state.json`, `cost.log` and the last implement pass's final report.

**Sampled:**
- `src/app/root-redirect.ts`, `src/server/crypto/tokens.ts`, `src/lib/validation/{token,email,password}.ts`, `src/components/shell/{LeftNav,ProjectSwitcher}.tsx` and `src/app/p/[projectSlug]/[section]/page.tsx`: re-read to re-check the first review's F9/F10, which those files carry.
- `contracts/routes.md` (grep for invitation and login copy), `research.md` F5 (the rate-limit claim in the README) and the installed `better-auth/dist/cookies` source (`getSessionCookie`).

**Not re-read:**
- `src/components/ui/*`, `src/app/layout.tsx`, `src/app/not-found.tsx` and `src/lib/validation/{slug,timezone,name,role,policies}.ts`. They haven't changed since the first review read them in full.
- `pnpm-lock.yaml`: generated.
- `data-model.md`: still no schema or migration exists to compare against it.

**Gates run here:**
- `pnpm lint`: exit 0.
- `pnpm typecheck` on the working tree: exit 0.
- **HEAD's** committed `src/server/crypto/secrets.ts` typechecked in isolation under the repo's compiler options: TS2769 at lines 46 and 47. The fix exists only in the working tree (F2).
- `pnpm test`: exit 1, `ERR_LOAD_URL tests/setup/global-setup.ts`.
- The same suite under a throwaway config in `$TMPDIR`, without the global setup: **11 files, 79 tests, all pass**.
- `pnpm build`: not run (see "What I could not check").

**Probes run here (scripts in `$TMPDIR`, nothing written to the repo):**
- `checkScope` run against SQL produced by the installed `drizzle-orm@0.45.3` through `drizzle.mock()`, then `.toSQL()` (F3).
- `failFromError` run against the default-constructed DAL errors (F4).
- A TCP check of `localhost:5432`, which is open.

## Verdict

**No. The branch still does not deliver the feature and is not mergeable. The cause is now a stale task list, not a missing install.**

The dependencies are installed (`package.json:29-38`, `node_modules/{better-auth,drizzle-orm,pg,zod}`), and T001 and T085 are ticked. But 53 of the 57 open tasks still give the T001 install as their blocker (`🛑 BLOCKED: … (T001 blocked, no registry access)`, or "not installed" in T082). That covers every open task from T012 to T078 except T076, plus T082. Two more, T076 and T089, are blocked only on those. The last implement pass saw the dependencies were installed (its own T085 note says so), fixed the Phase 10 items, and left every stale marker in place. The pipeline then moved on with "57 of 92 task(s) left". So all four P1 stories are still non-functional:
- no schema, migrations, auth, DAL or services;
- no login, setup, signup, invitations or project pages;
- `/` is still the create-next-app page.

Every further implement pass will skip the same 53 tasks for a reason that is no longer true.

The Phase 10 fixes themselves are good:
- The proxy now uses Better Auth's `getSessionCookie`.
- Typecheck is clean.
- The error mapper covers all seven DAL errors and carries the conflict message and field.
- Env validation reports cross-field issues alongside base ones.
- The README describes only what exists.

But none of it is committed, so HEAD, which is what would merge, still has the guessed cookie names and a failing typecheck (F2). And the scope checker's fix covers the exact two probes it was given, not the class: Drizzle's own `not(and(…))` and `insert … select` output still pass unflagged (F3).

**What to do:** clear the stale markers (T093), commit the finished work in explicit-path groups (T094), and close the checker holes (T095). Then let implement run the existing Phase 2–9 tasks, which already describe the missing feature. A Postgres is listening on `localhost:5432` here, so DB-backed tasks should be attempted rather than presumed blocked.

## Findings

- [ ] 🛑 BLOCKER F1 — The feature is still undelivered: 53 open tasks carry a "T001 blocked, no registry access" marker that stopped being true when the dependencies were installed, so implement skips them
      where:  specs/001-foundation-auth-projects/tasks.md:58, specs/001-foundation-auth-projects/tasks.md:36, specs/001-foundation-auth-projects/tasks.md:286, specs/001-foundation-auth-projects/tasks.md:231, package.json:29, src/app/page.tsx:6
      why:    T001 (`tasks.md:36`) is ticked "installed from the front-end session". T085 (`:286`) is ticked too, but its own text ends "then resume the open tasks T012–T078", and that never happened. Every one of those tasks still opens with a `🛑 BLOCKED: needs … (T001 blocked, no registry access)` prefix (e.g. T012 at `:58`). T082 (`:231`) still says the deps are "not installed", while `package.json:29-38` and `node_modules/` have them. The last implement pass reported "T085: The dependencies were already installed… I changed nothing" and still went straight to Phase 10. The pipeline state records "57 of 92 task(s) left". As a result, all of US1, US2, US3 and US6 (P1) are still non-functional:
              - nothing exists under `src/server/{db,auth,services,startup}`;
              - `src/server/dal/` holds only `errors.ts`;
              - there is no `drizzle/`, no ESLint import ban, and no `/login`, `/setup`, `/signup`, `/invitations`, `/p/new` or `/p/[projectSlug]/layout.tsx`;
              - `src/app/page.tsx:6` is still the template page.
              With no project layout, `/p/<any-slug>/calendar` renders its placeholder for anyone with a session cookie. Nothing checks membership or that the project exists, which contradicts FR-023 / US6 #1 in the present state. Only T083 and T084 (Docker daemon, browser, Neon) are genuinely blocked on a human.
      owed:   Strip the stale prefix from every task whose only stated blocker is T001 or the missing packages. Keep T083 and T084. Then re-run T012–T078 in phase order. Mark a task 🛑 again only with a cause observed in that pass. For DB-backed tests, try `TEST_DATABASE_URL`/`DATABASE_URL` against the Postgres on `localhost:5432` before declaring a database block.
      traces: US1, US2, US3, US6; FR-003–FR-006, FR-009–FR-037; SC-001, SC-003–SC-006, SC-009–SC-011; constitution II

- [ ] MAJOR F2 — All the remediation is uncommitted, so HEAD, which is what merges, still has the guessed cookie names, failing typecheck and incomplete error and env handling
      where:  src/proxy.ts:3, src/server/crypto/secrets.ts:41, src/lib/action-result.ts:35, src/server/env.ts:109, src/server/dal/errors.ts:1, vitest.config.ts:12, drizzle.config.ts:4
      why:    The constitution's workflow says to commit after each completed task, staging explicit paths only. T086, T087, T088 and T090–T092, plus the earlier T004, T006, T071 and T079–T081, are ticked but exist only in the working tree (`git status`: 16 modified, 6 untracked). At HEAD:
              - `src/lib/auth-gate.ts` still hard-codes `SESSION_COOKIES` (the first review's BLOCKER F2);
              - `src/server/crypto/secrets.ts:46-47` fails TS2769 (re-verified here), so CI's `check` job is red on the branch;
              - `failFromError` still lacks three of the seven DAL errors (first-review F7), and `parseEnv` still drops cross-field issues (first-review F8).
              Two of the uncommitted paths must **not** go in yet. `vitest.config.ts:12-13` points `globalSetup`/`setupFiles` at files that don't exist, which makes `pnpm test` exit 1. `drizzle.config.ts` turns on CI's `db:check` step (`ci.yml`, `hashFiles('drizzle.config.ts')`), which runs a script that doesn't exist (T015). A blanket commit, including the runner's fallback `feat(<slug>)` commit (decisions #17), would sweep both in. The constitution also cites `docs/decisions.md` #19 (`951d0a7`), and that entry exists only in the uncommitted `docs/decisions.md:106`.
      owed:   Commit the finished tasks now, one Conventional Commit per task or tight group, with explicit paths (see T094). Commit `vitest.config.ts` without the `globalSetup`/`setupFiles` lines, and leave `drizzle.config.ts` uncommitted, until T089's preconditions hold. Then confirm `git show HEAD:src/lib/auth-gate.ts` has no `SESSION_COOKIES`, and that `pnpm lint && pnpm typecheck` pass on a clean checkout of HEAD.
      traces: FR-039, FR-013, FR-001, constitution workflow (commits, quality gates), constitution I

- [ ] MAJOR F3 — The scope checker still fails open on SQL that Drizzle itself generates: `not ( … and … )` and `insert … select`
      where:  tests/helpers/scope-check.ts:83, tests/helpers/scope-check.ts:88, tests/helpers/scope-check.ts:185, tests/helpers/scope-check.ts:39, tests/helpers/scope-check.test.ts:43
      why:    T087 asked for "fail closed". It got a pattern list instead:
              - The negation guard (`:83`) only fires when `not` or `not (` sits *immediately* before the pin.
              - The reversed form (`:88-93`) has no negation guard at all.
              - The insert branch (`:185-193`) checks only the column list and never looks at an `insert … select` source.
              - Tables are found only after `from`, `join`, `update` or `into` (`:39`), so a comma-joined table is invisible.
              I ran `checkScope` with the registry entries for `projects`, `member` and `membership_audit_log` against `drizzle-orm@0.45.3` output from `drizzle.mock()`, and all of these pass with **no violation**:
              `db.select().from(member).where(not(and(eq(member.userId,u), eq(member.organizationId,p))))`
                → `… from "member" where not ("member"."user_id" = $1 and "member"."organization_id" = $2)` (every member of every project except one row)
              `db.insert(member).select(db.select().from(member).where(eq(member.userId,u)))`
                → `insert into "member" (…) select … from "member" where "member"."user_id" = $1` (reads every project's members)
              raw `select * from "member", "membership_audit_log" where "member"."organization_id" = $1`, and raw `… where not $1 = "member"."organization_id"`
              This contradicts `contracts/dal.md` rule 2 ("each referenced registered table must be pinned") and SC-008 ("100%"). The new test (`scope-check.test.ts:43`) covers only the literal probe from the first review.
      owed:   Fail closed by construction, not case by case:
              - treat any `not` in a scope's predicate as disqualifying its equality pins, as `or` already does;
              - check the `select` part of `insert … select` by the select rules;
              - find registered tables in comma-separated `from` lists (and `using`).
              Add the four statements above as tests that expect a violation.
      traces: FR-036, SC-008, US6 #3, constitution III

- [ ] MINOR F4 — Two of the mapper's user-facing messages miss the copy the spec and contracts fix: last owner (no transfer hint) and invalid invitation
      where:  src/server/dal/errors.ts:30, src/lib/action-result.ts:64, src/lib/action-result.ts:50, specs/001-foundation-auth-projects/contracts/routes.md:23
      why:    `failFromError` keeps the thrown message for `last_owner` (`action-result.ts:64`), and `LastOwnerError`'s default is "A project must keep at least one owner." (`errors.ts:30`). So `failFromError(new LastOwnerError())` returns exactly that, verified here, and the generic text with "Transfer ownership first." (`:48`) is never used. US4 #5 and the contract's `last_owner` line both require the transfer suggestion. Separately, `invitation_invalid` maps to "This invitation is invalid, expired or already used." (`:50`). But `routes.md:23` fixes the copy as "This invitation is no longer valid. Ask the person who invited you for a new one." (US3 #7, the "Invitation link raced" edge case). So a raced sign-up action and the `/signup` page would word the same outcome differently.
      owed:   Put the transfer hint in `LastOwnerError`'s default message, and use the `routes.md` sentence for `invitation_invalid`. Add a test that maps the default-constructed `LastOwnerError`.
      traces: FR-024, US4 #5, US3 #7, contracts/routes.md

- [ ] MINOR F5 — The same rule is defined twice in several places, and some copies already disagree
      where:  src/server/env.ts:20, src/server/env.ts:23, src/lib/validation/password.ts:3, src/lib/validation/email.ts:3, drizzle.config.ts:4, src/server/env.ts:98, src/server/crypto/tokens.ts:14, src/lib/validation/token.ts:3, src/components/shell/LeftNav.tsx:6, src/app/p/[projectSlug]/[section]/page.tsx:4
      why:    T092's rewrite re-implements the bootstrap password rule (`pw.length < 12 || > 128`, `env.ts:23`) and email check (`z.email()`, `:20`) instead of using `passwordSchema`/`PASSWORD_MIN`/`PASSWORD_MAX` and `emailSchema`. FR-010 says one rule applies to setup, sign-up *and* bootstrap. The two email checks already differ: `" Admin@Example.com"` fails at startup but is accepted, trimmed and lowercased at setup. The `DATABASE_URL_DIRECT` fallback is `||` in `env.ts:98` but `??` in `drizzle.config.ts:4`, so an exported empty `DATABASE_URL_DIRECT=` makes drizzle-kit throw "DATABASE_URL: required" even with `DATABASE_URL` set. First-review F10 is unchanged: the token regex appears twice (`tokens.ts:14`, `token.ts:3`), and the nav sections appear twice (`NAV_SECTIONS`, `PLACEHOLDERS`).
      owed:   Use the shared schemas in `crossFieldIssues`, use `||` in `drizzle.config.ts`, build `invitationTokenSchema` on `isWellFormedToken`, and derive `PLACEHOLDERS` from `NAV_SECTIONS`.
      traces: FR-010, FR-002, FR-020, FR-026, constitution IV

- [ ] MINOR F6 — The root-redirect consumer still needs `joinedAt`, but its planned producer doesn't return it (first-review F9, unchanged)
      where:  src/app/root-redirect.ts:1, src/app/root-redirect.ts:9, specs/001-foundation-auth-projects/contracts/server-actions.md:60
      why:    `decideRootRedirect` sorts by `joinedAt`, but `projects.listMine` is specified as `{ slug, name }[]`. T047/T049 written to the contract won't fit. Typecheck would catch it, but a placeholder `joinedAt` would silently change the FR-018 fallback order.
      owed:   Return `joinedAt` (`member.created_at`) from `listMine`/`users.listMyProjects` when T046/T047 land.
      traces: FR-018, US2 #5

- [ ] MINOR F7 — Two README sections are deferred "until it lands", and no open task will update them
      where:  README.md:51, README.md:57
      why:    T090 correctly wrote these sections as not implemented yet: session/rate-limit defaults, and how to register a project-owned table. But T079 and T090 are both ticked, and no open task (T025, T018, T028) mentions the README. So once auth and the registry exist, the README will be wrong, and FR-040 / the spec's "session lifetime … documented in the README" will stay unmet. Session lifetime isn't documented at all yet.
      owed:   When T025 and T018 land, rewrite `README.md:46-59` from the real config: session lifetime, rate-limit rule and `rateLimit.enabled`, and the one-line registry addition.
      traces: FR-040, spec Assumptions (session/rate-limit defaults)

- NOTE F8 — Status of the first review's findings in the present working tree:
  - **F2** (cookie names): fixed. `getSessionCookie` matches the installed `better-auth/dist/cookies/index.mjs:261`.
  - **F4** (typecheck): fixed.
  - **F6** (README): fixed for the current state.
  - **F7** (mapper): fixed, apart from the copy drift in F4.
  - **F8** (env cross-field): fixed. The two new test cases (`src/server/env.test.ts:67`) use exactly the inputs the first review showed failing, and they pass. I didn't re-run them against HEAD's version.
  - **F3** (scope checker): partly fixed (see F3 above).
  - **F1** (not delivered): still open (see F1 above).
  - **F5** (gates): still open as T089. It clears once T014–T016 and T020 land, which F1 unblocks.

  All four fixes are uncommitted (F2).

- NOTE F9 — `package.json` on this branch also carries packages for later roadmap entries: `@anthropic-ai/sdk`, `openai`, `@atproto/api`, `@aws-sdk/*`, `@better-auth/api-key`, `csv-parse`, `zod-openapi`, `sharp` and `@js-temporal/polyfill`. The owner installed them deliberately (`7c999ff`, decisions #19). Constitution VI still asks each entry's plan to justify a non-stack dependency, so the entries that use `openai`, `@anthropic-ai/sdk`, `csv-parse` and `zod-openapi` should do so. `pg` is `^8.23.1`, not exact-pinned. The plan says "pinned exactly", but T001's own text says `pg@8`.

## Coverage

Each row counts that section's FR, SC or principle IDs, checked against the present state of the code (working tree).

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements | 41 | 2 | 16 | 21 | 2 |
| Success criteria | 11 | 0 | 3 | 8 | 0 |
| Constitution principles | 7 | 5 | 1 | 1 | 0 |

Functional requirements:
- **Satisfied:** FR-002 (`.env.example`) and FR-007 (encryption facility: typecheck clean, 10 tests).
- **Partial:** FR-001, 003, 006, 008, 010, 013, 017, 018, 019, 020, 026, 028, 036, 038, 040, 041.
  - FR-001: the parser now lists every issue, but no startup hook refuses to start.
  - FR-013: the redirect is done, but there is no `/login` to return through.
  - FR-036: the checker has holes (F3), and there is no recorder or registry.
- **Absent:** FR-004, 005, 009, 011, 012, 014, 015, 016, 021, 022, 024, 025, 027, 029, 030, 031, 032, 033, 034, 035, 037.
- **Contradicted:**
  - FR-023: placeholder pages render for any slug (F1).
  - FR-039: HEAD fails typecheck (F2), `pnpm test` exits 1, and `Dockerfile:36` copies a missing `drizzle/`.

Success criteria:
- **Partial:** SC-002 (parser only), SC-007 (switcher built but not mounted) and SC-008 (checker with holes).
- **Absent:** the rest.

Constitution principles:
- **Satisfied:** I (now: cookie names come from the installed package), VI and VII.
- **Satisfied without being exercised:** IV (no services yet) and V (no providers in scope).
- **Partial:** II. The task list asserts blockers that no longer hold (F1).
- **Absent:** III. There is no DAL and no import ban, and the checker has holes.
- **Workflow rules (not a numbered principle):** per-task commits were not made (F2).

**Tasks:**
- 35 ticked, 57 open.
- Of the open tasks, 53 are stale-blocked on T001, and 2 (T076, T089) are blocked only on stale-blocked tasks. Just 2 (T083, T084) are genuinely blocked on a human.
- One ticked task contradicts its own text: T085 ("then resume the open tasks T012–T078").

## What I could not check

- **Any database behaviour:** no schema, migrations or DB code exist. Something listens on `localhost:5432`, but I didn't connect to it.
- **`pnpm build`:** not run. `next build` can rewrite the tracked `tsconfig.json`, which is outside this phase's write scope.
- **`docker build` / `docker compose up`:** the Docker socket is not accessible from this sandbox. The `Dockerfile:36` conclusion comes from reading it against the absent `drizzle/`.
- **CI on GitHub:** the conclusion that the `check` job fails at HEAD comes from typechecking HEAD's `secrets.ts` locally, not from a CI run.
- **Browser behaviour:**
  - Ctrl/⌘+K focus and its return;
  - the ≤ 4-keystroke switch (SC-007);
  - the native `<dialog>` focus trap;
  - screen-reader announcements.
- **Better Auth runtime facts U1/U2:** no auth instance exists to exercise them.
- **Neon (SC-011):** no connection string is available.
