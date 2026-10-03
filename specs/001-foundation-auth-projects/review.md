# Review: Docket Foundation — Accounts, Projects, Members, Invitations and Project Isolation

Reviewed 163 file(s) changed across 35 commit(s), against `37eed2e` (merge-base with `origin/main`)...`de61583` (HEAD). This is the third review of this branch. Between the second review (`3b5baf7`) and now, the implement passes wrote the whole feature: schema, migration, DAL, services, Better Auth, startup, every page and the integration suite. The last 12 of those commits landed at 09:36, seconds after this review started. The working tree was clean when the gates below were run, so this review covers HEAD exactly.

**Read in full:**
- `src/server/db/{client,cross-project,migrate,project-owned}.ts` and `src/server/db/schema/*`
- `src/server/dal/*`
- `src/server/services/{projects,members,setup,audit}.ts` and `src/server/services/invitations/{index,delivery}.ts`
- `src/server/auth/{access,auth,session}.ts`, `src/server/startup/index.ts`, `src/server/env.ts`, `src/instrumentation.ts`, `src/proxy.ts`
- `src/lib/{action-result,auth-gate,safe-redirect,auth-client}.ts`, `src/lib/validation/*`, `src/server/crypto/tokens.ts`
- every `actions.ts`, plus every `page.tsx`/`layout.tsx` under `src/app/p/`, `src/app/{login,setup,signup,invitations}/` and `src/app/page.tsx`
- `members-panel.tsx`, `invitations-panel.tsx`, `settings-form.tsx`, `new-project-form.tsx`, `setup-form.tsx`, `signup-form.tsx`, `login-form.tsx`, `DecisionForm.tsx`
- `tests/setup/*`, `tests/helpers/{db,factories,auth}.ts`, and `tests/integration/{members,scope-check,auth-endpoints,auth-schema,no-plaintext}.test.ts`
- `eslint.config.mjs`, `tests/lint/db-import.test.ts`, `next.config.ts`, `drizzle.config.ts`, `docker-compose.yml`, the `Dockerfile` runner stage, `README.md` and `docs/decisions.md` §U1–U3
- `spec.md`, `plan.md`, `tasks.md`, the constitution, and `contracts/{dal,server-actions,routes}.md`

**Sampled:**
- the other integration tests (case lists, plus the slug and time-zone inputs in `projects.test.ts` and `project-settings.test.ts`)
- `ProjectSwitcher.tsx` (key handling and ARIA)
- `src/components/ui/Field.tsx`, `LeftNav.tsx`, `drizzle/0000_previous_tombstone.sql` (constraints vs `data-model.md`) and `.github/workflows/ci.yml`
- the `tests/helpers/scope-check.test.ts` cases added for the second review's F3

**Not reviewed:**
- `pnpm-lock.yaml` and `drizzle/meta/*`: generated.
- `src/components/ui/*` other than `Field`: unchanged since the first review read them.
- `src/server/crypto/secrets.ts`: unchanged since the second review.

**Gates, run here on HEAD:**

| Gate | Result |
|---|---|
| `pnpm lint` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm test` (`DATABASE_URL=…127.0.0.1:5433/docket_test`) | 29 files, 226 tests, all pass |
| `pnpm db:check` | exit 0, "Migrations are current." |
| `next build` (clean `git archive HEAD` copy in `$TMPDIR`, env holding only `DATABASE_URL`, as in CI) | exit 0; `.next/standalone/drizzle/` is present |

**Probes (all in `$TMPDIR`; the only database objects created were rows in `docket_test` and a throwaway `docket_srvprobe_test`, which was dropped afterwards):**

1. **Standalone server** (`node server.js` from that build) against a fresh database:
   - an empty `CREDENTIALS_ENCRYPTION_KEY` exits 1 in 449 ms, naming the variable;
   - a migration failure exits 1 in 329 ms with "Docket: database migration failed. Not starting.";
   - on a healthy install: migrations are applied, `GET /api/health` returns 200 `{"ok":true}`, `/` returns 307 → `/login`, `/setup` returns 200, `/p/anything` returns 307 → `/login?next=%2Fp%2Fanything`, `POST /api/auth/sign-up/email` returns 400 "Sign-up requires an invitation", and `/api/auth/organization/list` returns 404.
2. **Service vs shared validation schemas** (F1).
3. **Concurrent removal against `scope.transaction({ lockProject })`** (F2).
4. **The ESLint import ban with relative paths** (F3).
5. **The `setupFiles` scope recorder end to end:** an unscoped `select` on `member` fails its test with the contract's message. SC-008 is met.

## Verdict

**Close, but not yet mergeable.** The feature is built and it runs. All five gates pass on HEAD, and the real standalone server does what US1 and the HTTP contract require. Every user story has an integration test behind it that hits real Postgres, and the tests check real behaviour, not mocks of the code they test:
- the token-race and setup-race tests;
- the no-plaintext scan over every table;
- the scope recorder.

The first two reviews' blockers (undelivered feature, uncommitted work, scope-checker holes) are resolved.

What remains is the class of defect this review exists to catch: passes that each did their part plausibly, but didn't fit together.
- **F1 (BLOCKER):** the shared validation module built in Phase 2 (T010) is never imported. The services that later passes wrote carry their own slug and time-zone rules, and those rules contradict the spec: reserved slugs, 2-character slugs and `+02:00` offsets are accepted, and valid 41–48-character slugs are rejected. The unit tests assert the spec's rules against the unused module, so the suite is green while the production path is wrong.
- **F2 (MAJOR):** the membership re-check inside the project lock reads a snapshot taken before the lock was granted. A member removed while their request waits on the lock still gets through. Probed here: a removed admin created an invitation and got its link.
- **F3 (MAJOR):** the import ban misses relative imports from `src/server/services/`.
- **F4 (MAJOR):** the README and decisions log still say the auth server and DAL "are not written yet".

All four are small, local fixes. I'd fix them under the remediation phase below and then merge. The human-only items (T083 Docker and browser survey, T084 Neon) stay open and are listed under "What I could not check".

## Findings

- [ ] 🛑 BLOCKER F1 — The services validate slugs and time zones with their own rules, which contradict the spec, while the spec-correct shared schemas in `src/lib/validation/` are imported by nothing
      where:  src/server/services/projects.ts:15, src/server/services/projects.ts:18, src/server/services/projects.ts:19, src/server/services/projects.ts:21, src/server/services/projects.ts:6, src/server/services/projects.ts:30, src/lib/validation/slug.ts:18, src/lib/validation/timezone.ts:3, src/server/services/setup.ts:5, src/server/services/invitations/index.ts:34, src/server/env.ts:20, src/app/p/new/new-project-form.tsx:14, src/lib/validation/validation.test.ts:1
      why:    T010 built `src/lib/validation/*` to the spec's rules: slug 3–48 characters plus a reserved list, an IANA shape check that rejects offsets, project name 1–80. No file outside `src/lib/validation/` imports it (`grep -rn lib/validation src tests` finds nothing).
              T047 then wrote `createProjectSchema`/`updateSettingsSchema` with different rules: slug 2–40, only `new` reserved, time zone checked by `Intl.DateTimeFormat` alone, name 1–100. Node 24's `Intl` accepts `+02:00`, `-0530` and `EST` (checked here). I ran both schemas on the same inputs:

              | Input | Service | Spec / shared lib |
              |---|---|---|
              | slug `settings`, `api`, `login`, `signup`, `setup`, `invitations` | accepts | rejects |
              | slug `ab` | accepts | rejects |
              | 45-character slug | rejects | accepts |
              | time zone `+02:00`, `-0530` | accepts | rejects |
              | 81-character project name | accepts | rejects |

              That contradicts the spec's Slug rules and Project time zone edge cases, US2 #3, FR-015 and `data-model.md` ("slug: D17 rules"). Bad slugs and offset zones get persisted on project rows, and later entries' Temporal code will read them as project time zones. The client form copies the wrong limit too (`slugify(…).slice(0, 40)`).
              `setup.ts`, `invitations/index.ts` and `env.ts` also re-implement the email and password rules. `" Admin@Example.com"` fails `firstUserSchema` (no trim) but passes the invite schema.
              The test suite hides all of this. `validation.test.ts` asserts the spec's cases against the unused module. The integration tests only send inputs both rule sets agree on (`new`, `Bad Slug`, `Mars/Olympus`).
      owed:   Make `src/lib/validation` the single source:
              - Build `createProjectSchema`/`updateSettingsSchema` from `projectNameSchema`, `slugSchema`, `timeZoneSchema` and the policy schemas.
              - Use `emailSchema`, `passwordSchema`, `personNameSchema` and `roleSchema` in `setup.ts`, `invitations/index.ts` and `env.ts` (`crossFieldIssues`).
              - Use `slugSchema`'s max in `slugify`.
              - Add integration cases through `projects.create` and `projects.updateSettings` that expect `validation` for `settings`, `ab`, `+02:00` and an 81-character name, and success for a 45-character slug.
      traces: FR-015, FR-010, US2 #3, US5 #1, spec Edge Cases (slug rules, time zone, email case), constitution IV

- [ ] MAJOR F2 — The "re-check membership inside the locked transaction" reads a stale snapshot, so a member removed or demoted while their request waits on the lock can still act
      where:  src/server/dal/scope.ts:75, src/server/dal/scope.ts:99, src/server/dal/scope.ts:101, src/server/services/projects.ts:59, src/server/services/projects.ts:61, specs/001-foundation-auth-projects/contracts/dal.md:44
      why:    `resolve(…, lock=true)` locks the project row and re-reads the caller's `member` row in one statement: `select … from projects inner join member … for update of projects`. Under READ COMMITTED, that statement's snapshot is taken before it blocks on the lock. When the removal transaction commits and releases the lock, the waiting statement returns the `member` row as it was before the removal. So `fresh` still holds the old role, and every lock-protected mutation proceeds:
              - invite, regenerate, revoke;
              - changeRole, remove, leave, transfer;
              - updateSettings.
              **Probe:** an owner's transaction locked the project and deleted an admin's `member` row. While it was open, the admin's request (scope already resolved) called `invitations.create`. Then the owner committed. Result: `{"ok":true,"delivery":"manual_link"}`, one pending invitation with `inviter_id` = the removed admin, and the admin no longer a member. The same applies to a concurrent demotion: a just-demoted admin keeps admin permissions for that request. Last-owner protection still holds, because `countOwners()` is a separate, fresh statement.
              This contradicts `contracts/dal.md` ("re-checks the membership inside the transaction (so a member removed concurrently can't act)") and FR-022 ("on every request, re-verify"). `members.test.ts` covers removal only sequentially.
              Separately, `projects.updateSettings` checks `project:update` only on the pre-transaction scope (`:59`) and never on the transaction scope (`:61`). The members and invitations services do re-check inside the transaction.
      owed:   In `scope.transaction` with `lockProject`:
              - run `select id from projects where id = $1 for update` as its own statement;
              - then resolve the membership in a second statement, which gets a fresh snapshot after the lock is granted;
              - throw `NotFoundError` if it's gone.
              Re-check `tx.can({ project: ["update"] })` inside `updateSettings`. Add an integration test that reproduces the probe:
              - hold the lock with a raw client and delete the member;
              - start the mutation, then commit;
              - expect `NotFoundError` and no rows written.
      traces: FR-022, FR-034, SC-005, US4 #3, spec Edge Case "Removed while mid-form", constitution III

- [ ] MAJOR F3 — The raw-database import ban only matches paths containing `server/db`, so `src/server/services/*` can import `../db/client` without a lint error
      where:  eslint.config.mjs:12, eslint.config.mjs:23, tests/lint/db-import.test.ts:12
      why:    The restricted patterns are `@/server/db`, `@/server/db/*`, `**/server/db` and `**/server/db/**`. They match against the import string, so a relative import from inside `src/server/` never contains `server/db`. Through the ESLint Node API with the repo's config:
              - **allowed:** `src/server/services/example.ts` → `"../db/client"` and `"../db/schema"`; `src/server/services/invitations/example.ts` → `"../../db/client"`; `src/server/example.ts` → `"./db/client"`;
              - **blocked:** `src/app/example.ts` → `"../server/db/client"`, and any `@/server/db/…`.
              The services layer is where every later roadmap entry adds code, so this is the likeliest bypass. US6 #4 ("code outside the sanctioned data-access area… imports the raw database client → lint fails") fails for it. No current file uses the hole (grep is clean). The test only probes `src/app/example.ts`.
      owed:   Restrict by resolved location, not by string shape. For example, add patterns that match relative `db` imports (`**/db`, `**/db/*`, `**/db/**`, plus `./db`/`../db` forms), or a files-scoped block for `src/server/{services,crypto}/**` that bans `../db*`. Keep `src/server/{dal,db,auth,startup}/**` exempt. Extend `tests/lint/db-import.test.ts` with the four allowed-today cases above, each expecting the error.
      traces: FR-035, US6 #4, constitution III

- [ ] MAJOR F4 — The README and decisions log still describe the auth server, DAL and registry as not written, and session-lifetime docs are missing, although T079 and T090 are ticked
      where:  README.md:46, README.md:48, README.md:51, README.md:54, README.md:58, docs/decisions.md:101, docs/decisions.md:102, docs/decisions.md:103
      why:    The README says:
              - "`src/server/auth/auth.ts`) is not written yet, so these defaults are not configured or verified in Docket" (`:51`);
              - "The registry … and the data-access layer are not implemented yet" (`:58`);
              - Better Auth rate-limits "only when `NODE_ENV=production`" (`:48`).
              All three are false at HEAD:
              - `auth.ts` exists and sets `rateLimit: { enabled: true }` in every environment;
              - `auth-endpoints.test.ts` verifies the 429;
              - `src/server/db/project-owned.ts` and `src/server/dal/` exist.
              The README also never mentions session lifetime, which the spec's Assumptions say is "documented in the README". It never mentions the `db:*` scripts, or that `pnpm test` needs a Postgres database whose name ends `_test`.
              `docs/decisions.md:103` says U2 is unverifiable because "`src/server/auth/auth.ts` does not exist yet", and `:101` is an orphaned sentence fragment from an earlier edit.
              The second review flagged this as MINOR F7, and no task picked it up. The constitution's Docs rule says each entry updates the README for what it adds. SC-001 depends on the README alone.
      owed:   Rewrite `README.md:46-59` from the real config:
              - Better Auth's default session lifetime and refresh, read from the installed package;
              - rate limiting on in all environments at 3 per 10 s for sign-in;
              - the one-line registry addition in `src/server/db/project-owned.ts` and the scope-recorder failure it prevents.
              Add a Testing note (`DATABASE_URL` with a `_test` database name, `pnpm db:check`). Update `docs/decisions.md` U2 with what was observed, or "not verified (needs a browser)", and delete the orphan line at `:101`.
      traces: FR-040, spec Assumptions (session lifetime and rate limiting, setup exposure), SC-001, constitution workflow (Docs)

- [ ] MINOR F5 — Some user-facing copy still misses the spec: the last-owner demotion message has no transfer hint, and the raced or invalid invitation message differs from the fixed copy
      where:  src/server/dal/errors.ts:30, src/server/services/members.ts:58, src/lib/action-result.ts:64, src/lib/action-result.ts:50, specs/001-foundation-auth-projects/contracts/routes.md:23
      why:    `changeRole` throws `new LastOwnerError()`, and `failFromError` keeps that message ("A project must keep at least one owner."). So a direct demotion of the last owner gets no "transfer ownership first" suggestion (US4 #5). Only `leave` passes a custom message, and only `leave` is tested for it (`members.test.ts:33`).
              A raced `signUpWithInvitation` or `acceptInvitationByToken` shows "This invitation is invalid, expired or already used." The `/signup` page shows the `routes.md` sentence ("…no longer valid. Ask the person who invited you for a new one.") for the same outcome. This is second-review F4, still open.
      owed:   Put the transfer hint in `LastOwnerError`'s default message. Use the `routes.md` sentence for `invitation_invalid`. Assert both in tests.
      traces: FR-024, US4 #5, US3 #7, spec Edge Case "Invitation link raced"

- [ ] MINOR F6 — Three hand-rolled forms render field errors without an `aria-live` region, unlike the shared `Field` primitive, so a server-side field error isn't announced
      where:  src/app/p/new/new-project-form.tsx:34, src/app/p/[projectSlug]/settings/settings-form.tsx:27, src/app/setup/setup-form.tsx:28, src/components/ui/Field.tsx:40
      why:    T030's `Field` puts errors in `aria-live="polite"`. Later passes built `/p/new`, project settings and `/setup` with raw `<input>`s and plain `<span>` errors (`grep aria-live` finds none in those files). The form-level `role="alert"` only renders when there are no field errors. So "That URL name is already taken." beside the slug field is silent for a screen-reader user. FR-041 calls for "inline announced errors". The members, invitations and signup forms do use the shared primitives, so the convention split falls between passes.
      owed:   Use `Field`/`Select` from `src/components/ui/` in those three forms, or give their error elements `aria-live="polite"`.
      traces: FR-041, constitution (Accessibility), docket-ui

- [ ] MINOR F7 — The scope summary is never printed, so T078's "confirm the scope summary" couldn't have been observed, and cross-project query counts are invisible
      where:  tests/setup/scope-recorder.ts:40, specs/001-foundation-auth-projects/tasks.md:222
      why:    The summary is printed from `process.on("beforeExit")`. Vitest workers are torn down rather than draining, so it never fires: `grep -c scope-check` on the full `pnpm test` output gives 0. The check itself works (probe 5). But `contracts/dal.md` ("skipped and counted in a summary") and T020 ("prints summary of checked and cross-project queries") are unmet. T078 is ticked on evidence the suite never produces, which matters under constitution II.
      owed:   Print the summary from an `afterAll` in the setup file, or aggregate in a Vitest reporter or `globalSetup` teardown. Confirm the line appears in `pnpm test` output.
      traces: FR-036, contracts/dal.md (summary), constitution II

- [ ] MINOR F8 — Two locked-transaction abstractions and two cross-project helpers, and services reach past the DAL index
      where:  src/server/dal/invitations.ts:68, src/server/dal/invitations.ts:89, src/server/dal/scope.ts:47, src/server/dal/invitations.ts:3, src/server/dal/tokens.ts:3, src/server/dal/index.ts:1, src/server/services/invitations/index.ts:12
      why:    The phases built these separately:
              - `withLockedProject` and `ProjectTx` (T059) sit beside `scope.transaction({ lockProject })` and `ProjectScope` (T027), with a parallel set of repos and no membership resolution;
              - `crossProject` (`scope.ts:47`) is a pass-through to `runCrossProject`, and the DAL modules use the two interchangeably;
              - the invitations service imports `withLockedProject`, `insertInvitedUser`, `claimToken` and `lookupToken` straight from `dal/invitations` and `dal/tokens`, which `dal/index.ts` ("the sanctioned surface") doesn't export.
              The invitee flows legitimately need a non-member transaction, and every current caller uses it correctly. But it's an unlabelled second way to get write access to a project's repos without membership, and it doesn't run inside `crossProject`, so the scope summary can't show it.
      owed:   Rename it to say what it is (for example `forInvitee(projectId)`), run it inside `crossProject("invitee transaction")`, and export the invitee surface through `dal/index.ts`. Pick one cross-project helper name.
      traces: FR-034, constitution III, contracts/dal.md

- [ ] MINOR F9 — Small duplicated rules carried over from second-review F5
      where:  drizzle.config.ts:4, src/server/env.ts:98, src/server/crypto/tokens.ts:14, src/lib/validation/token.ts:3, src/components/shell/LeftNav.tsx:6, src/app/p/[projectSlug]/[section]/page.tsx:4
      why:    The `DATABASE_URL_DIRECT` fallback is `??` for drizzle-kit but `||` in `env.ts`, so an exported empty `DATABASE_URL_DIRECT=` sends drizzle-kit to `""`. The token regex is written twice, and the nav sections twice (`NAV_SECTIONS`, `PLACEHOLDERS`).
      owed:   Use `||` in `drizzle.config.ts`, build `invitationTokenSchema` on `isWellFormedToken`, and derive `PLACEHOLDERS` from `NAV_SECTIONS`.
      traces: FR-002, FR-020, FR-026

- NOTE F10 — Status of the second review's findings at HEAD:
  - **F1** (stale blockers, feature undelivered): resolved. Every task T012–T082 is done, and the gates pass.
  - **F2** (uncommitted work): resolved. The tree is clean, and HEAD passes all five gates.
  - **F3** (scope-checker holes): resolved. The four statements are tests at `tests/helpers/scope-check.test.ts:85-96`.
  - **F4** (copy drift): still open, as F5 here.
  - **F5** (duplicated rules): its password and email part is now part of F1; the rest is F9.
  - **F6** (`joinedAt`): resolved (`src/server/dal/projects.ts:69`).
  - **F7** (README deferred): still open, as F4 here.
  - **F9** (later-entry dependencies, `pg` not exact-pinned): stands as an observation.

- NOTE F11 — Several ticked tasks in `tasks.md` carry annotations that are no longer true. This review may not edit existing tasks, so they stay:
  - T039 says "since `better-auth/cookies` is not installable", but `src/proxy.ts:3` imports it.
  - T049, T051 and T054 are still marked "PARTIAL".
  - T060 says its tests were "not run".

  The code behind each of these tasks is in place. Only the notes mislead a reader.

- NOTE F12 — `/signup` sends `Referrer-Policy: no-referrer` (`next.config.ts:10`). But the "Log in to accept" path puts the invitation token into `/login?next=/signup?token=…` (`src/app/signup/page.tsx:58`), and `/login` has no such header. No third-party resource loads on `/login`, so nothing leaks today. A later entry that adds an external asset or link there should extend the header.

## Coverage

Each item was checked against HEAD. "Not checkable here" means the item needs a browser, Docker or Neon (see the last section).

| Checked | Count | Satisfied | Partial | Absent | Contradicted | Not checkable here |
|---|---|---|---|---|---|---|
| Functional requirements | 41 | 36 | 4 | 0 | 1 | 0 |
| Success criteria | 11 | 6 | 2 | 0 | 0 | 3 |
| Constitution principles | 7 | 4 | 2 | 0 | 0 | 0 (V is N/A) |

Functional requirements:
- **Contradicted:** FR-015 (F1).
- **Partial:** FR-022 (F2), FR-035 (F3), FR-040 (F4) and FR-041 (F6).
- **Satisfied, with evidence:**
  - FR-001, 004 and 013 by the live server probe;
  - FR-003 by `db:check`;
  - FR-011 by the live 400 and `auth-endpoints.test.ts`;
  - FR-012 by the setup race test;
  - FR-021 by `permissions.test.ts`;
  - FR-026 by `invitation-tokens.test.ts`, including the concurrent double-submit;
  - FR-033 by `audit.test.ts`;
  - FR-036 by probe 5;
  - FR-039 by the five gates run locally.
- **Satisfied by reading:** FR-006 (Compose) and FR-019 (switcher). Neither was run here.

Success criteria:
- **Satisfied:**
  - SC-002 (449 ms, variable named, no value);
  - SC-004, SC-006, SC-008, SC-009 and SC-010.
- **Partial:**
  - SC-005: sequential removal is satisfied; the concurrent case isn't (F2).
  - SC-011: the local half is satisfied; the Neon half is "not verified" and is recorded as such.
- **Not checkable here:** SC-001, SC-003 and SC-007.

Constitution principles:
- **Satisfied:** I, IV, VI and VII.
- **Partial:**
  - II: T078 is ticked on output the suite never prints (F7).
  - III: the lint hole (F3) and the stale re-check (F2).
- **N/A:** V.
- **Workflow:** commits are Conventional, and the tree is clean.

**Tasks:** 92 ticked and 3 open. T083 and T084 are owed to a human. T089 is blocked only by `docker build`. Its other conditions now hold: `pnpm test` and `pnpm db:check` exit 0, and `drizzle/` exists.

## What I could not check

- **`docker build` and `docker compose up --build`:** the Docker socket isn't reachable from this sandbox. So the image build (T089), the runner stage's `COPY … /app/drizzle`, and the Compose health-check ordering weren't exercised. The standalone `server.js` from a local `next build` was exercised instead, against a throwaway database.
- **Anything in a browser** (T083):
  - the login → `next` round trip, setup, sign-up, accept and decline through the UI;
  - server-action form posts, including `useActionState` error rendering and the redirect after a slug change;
  - Ctrl/⌘+K focus and its return, and ≤ 4 keystrokes (SC-007);
  - native `<dialog>` focus trapping, and screen-reader announcements (F6 comes from reading the code);
  - the `docket_last_project` cookie surviving a browser restart;
  - the 3-minute invite-to-member flow (SC-003), and fresh clone to logged in under 10 minutes (SC-001).
- **Better Auth U2 (`nextCookies()` ordering in a real browser session):** not observed. The server-side sign-in in `completeSetup` and `signUpWithInvitation` was never run end to end.
- **Login rate limiting behind a real client IP:** `auth-endpoints.test.ts` sets `x-forwarded-for` itself. Whether the Compose deployment supplies a client IP that Better Auth's limiter can key on wasn't checked.
- **Neon (SC-011, T084):** no connection string is available.
- **CI on GitHub:** the gates were run locally, with CI's env shape (only `DATABASE_URL`). The workflow itself wasn't observed.
