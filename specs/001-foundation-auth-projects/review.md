# Review: Docket Foundation — Accounts, Projects, Members, Invitations and Project Isolation

Reviewed 168 file(s) changed across 46 commit(s), against `37eed2e` (merge-base with `origin/main`)...`960386e` (HEAD). This is the fifth review of this branch.

**What changed since the fourth review:** only `review.md` (`947b64f..960386e`). No code changed. So this pass did not re-check a delta. It read the feature again as a whole and probed the built server on paths the earlier reviews had not exercised. The working tree is clean apart from `tasks.md`, where the implement pass left its T096–T101 ticks and the "Front-end survey findings" section uncommitted.

**Read in full:**
- **Server:** `src/server/{env.ts,startup/index.ts}`, `src/instrumentation.ts`, `scripts/prestart.mjs`, `src/server/db/{client,cross-project,migrate,project-owned}.ts`, `src/server/db/schema/*.ts`, `src/server/auth/{auth,access,session}.ts`, `src/server/crypto/{secrets,tokens}.ts`.
- **DAL:** `src/server/dal/*.ts`.
- **Services:** `src/server/services/{projects,members,setup,audit}.ts`, `src/server/services/invitations/{index,delivery}.ts`.
- **Shared libs:** `src/lib/{action-result,safe-redirect,auth-gate}.ts`, `src/lib/validation/*.ts`, `src/proxy.ts`.
- **Pages and actions:** every page, layout and action under `src/app/` (root, login, setup, signup, invitations, `p/new`, project shell, settings, members), `src/app/api/{auth,health}`.
- **Components:** `src/components/shell/*`, `src/components/invitations/DecisionForm.tsx`, `src/components/ui/{Dialog,Field,Select,CopyField}.tsx`.
- **Config:** `next.config.ts`, `Dockerfile`, `docker-compose.yml`, `package.json`, `.github/workflows/ci.yml`, `scripts/check-migrations-current.mjs`, `vitest.config.ts`.
- **Tests:** `tests/setup/*`, `tests/helpers/*`, `tests/integration/{auth-endpoints,permissions,members,invitation-tokens}.test.ts`.
- **Spec artifacts:** `spec.md`, `plan.md`, the constitution, `tasks.md`, the README's sessions/testing sections, research F5/D5, and the fourth `review.md`.

**Sampled:**
- The remaining integration tests (`invitation-accept`, `lock-recheck`, `project-validation`, `no-plaintext`, `scope-check`, `bootstrap`): only the cases the fourth review relied on.
- `tests/startup/prestart.test.ts`.
- The lines cited by the fourth review's MINOR findings, which are carried below as F6–F12.

**Not reviewed:**
- `src/components/ui/{Badge,Button,Table,EmptyState}.tsx`: presentational.
- `pnpm-lock.yaml`, `drizzle/meta/*`: generated.

**Gates (run on HEAD in this pass):**

| Gate | Result |
|---|---|
| `pnpm lint` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm db:check` | "Migrations are current." |
| `pnpm test` (`DATABASE_URL=…127.0.0.1:5433/docket_test`, no auth or crypto env in the shell) | 33 files, 250 tests, all pass, 25.9 s. The output contains 0 `scope-check` lines (F8) |
| `next build` + the `build:prestart` esbuild step (a `git archive HEAD` copy in `$TMPDIR`, env holding only `DATABASE_URL`) | exit 0; `.next/standalone/scripts/prestart.mjs` is 468.1 KB |

**Probes.** I assembled the runner-stage layout exactly as the `Dockerfile`'s `COPY` lines do and started it with its `CMD` (`node scripts/prestart.mjs`, `NODE_ENV=production`). It ran against a throwaway `docket_review5_test` database on local Postgres 17, which was dropped afterwards, along with the temporary build.

1. **Login rate limit, honest client** (no `X-Forwarded-For` sent): 401 401 401 **429**. The built-in 3-per-10-seconds rule works.
2. **Login rate limit, client-chosen `X-Forwarded-For`** (a different value on each try): ten wrong passwords in under 1 s gave 401 ×10 and no 429. The correct password then signed in with 200 (F1).
3. **Login rate limit, two-entry `X-Forwarded-For`** (`a, b`, which is what an appending proxy forwards when the client sends its own header):
   - three failures, then 429 on the fourth;
   - then a *different* user's correct login, also with a two-entry header, got 429;
   - the server logged Better Auth's "falling back to a single shared per-path bucket" warning (F1).
4. **Zero-project user with a pending in-app invitation:**
   - sign-in 200, and `/` → 307 `/p/new`;
   - `/p/new` contains no `/invitations` link and no "Invitations" text;
   - `/invitations`, typed by hand, lists the invitation (F2).
5. **Stale session cookie:**
   - `GET /p/bea-co/settings/members` with a present but invalid `better-auth.session_token` → 307 `/login?next=%2Fp%2Fbea-co`;
   - the same request with no cookie → `/login?next=%2Fp%2Fbea-co%2Fsettings%2Fmembers` (F3).
6. **Sign-up and organization gates on a fresh install:**
   - `/sign-up/email` → 400; with a query string → 400;
   - `/sign-up/email/` and `//sign-up/email` → 308 to the canonical path, which is gated;
   - `/SIGN-UP/EMAIL` and `/sign-up/email%2F` → 404;
   - `/organization/create` → 404; `/organization/create/` → 308; `/Organization/create` → 404.
   - Afterwards the database held 0 users and 0 organizations. SC-004 holds for path variants.
7. **Startup:** migrations were applied, then "✓ Ready", then "first account created from environment", on each start. This matches the fourth review's probes 2–3.

## Verdict

**Not mergeable yet: two MAJOR findings, both in P1 security or onboarding paths, and both shown on the built server.** Everything the fourth review confirmed still holds, because no code has changed: shared validation, the locked re-check, the lint ban, the entrypoint ordering, and the sign-up gate (probe 6 adds the path variants). The DAL, services and tests are coherent and substantive. The two gaps sit between passes:

- **F1 (FR-009).** The login rate limit is keyed on `X-Forwarded-For`, a header the client controls, and the Compose stack publishes the app directly on port 3000. So an attacker who sends their own header gets unlimited password guesses. Behind a multi-hop proxy, any client can lock every user out of login.
  - The auth pass chose Better Auth's defaults, and the plan said the IP header would be documented.
  - The Docker pass exposed the app directly.
  - The README claims limiting is "on in every environment".
  - The only test sends a fixed header, so it cannot see this.
- **F2 (FR-028).** The shell pass put the pending-invitation badge, the only link to `/invitations`, inside the project layout. The redirect pass sends a signed-in user with no projects to `/p/new`, which sits outside that layout. The delivery pass gives existing accounts in-app delivery only, with no link. So a removed member who is invited back has no way to find the invitation in the UI, and the inviter has nothing to resend.

Fix both (T102, T103), then let a human run T083 (browser survey) and T084 (Neon). The MINORs can follow the merge.

## Findings

- [ ] MAJOR F1 — Login rate limiting is keyed on a client-chosen `X-Forwarded-For`. A client that sends its own value is never limited, and behind a multi-hop proxy every user shares one 3-per-10-seconds bucket
      where:  src/server/auth/auth.ts:44, docker-compose.yml:33, README.md:52-56, tests/integration/auth-endpoints.test.ts:88-95, specs/001-foundation-auth-projects/research.md:220-222
      why:    `betterAuth` sets `rateLimit: { enabled: true }` but no `advanced.ipAddress`. So Better Auth takes the client IP from `x-forwarded-for`:
              - it uses the value only when it is a single address;
              - otherwise it returns null and falls back to a shared `no-trusted-ip` bucket (`@better-auth/core/dist/utils/ip.mjs:190-218`, `better-auth/dist/api/rate-limiter/index.mjs:242-246`).
              Next fills that header from the socket only when the client didn't send one: `req.headers['x-forwarded-for'] ??= …remoteAddress` (`node_modules/next/dist/server/base-server.js:612`). Compose publishes the app directly (`"3000:3000"`).
              Measured on the standalone build:
              - with a fresh client-chosen IP on each try, 10 wrong passwords gave 0 × 429, and then the correct password signed in (probe 2);
              - with a two-entry header, one client's 3 failures made a different user's correct login fail with 429 (probe 3).
              The README says limiting is "on in every environment". Research D5 says the IP header setting "is documented in the README", but it isn't. The suite's only rate-limit test sends a constant `x-forwarded-for`, so it passes either way.
      owed:   Make the sign-in limit independent of a header the client chooses. For example:
              - add a per-email attempt limit for `/sign-in/email` in the existing `before` hook (same 3-per-10-seconds rule, in memory like Better Auth's store; check the hook's `ctx.body` shape in `node_modules/better-auth`);
              - make the trusted client-IP source configurable (`advanced.ipAddress.ipAddressHeaders` / `trustedProxies` from env), and document it in `.env.example` and the README together with the reverse-proxy requirement.
              Then correct `README.md:52-56` to describe what holds. Add integration tests:
              - four sign-ins for one email, each with a different `x-forwarded-for`, where the 4th is 429;
              - three failures from one client with a two-entry header, after which a different email can still sign in.
      traces: FR-009, research D5, FR-040

- [ ] MAJOR F2 — A signed-in user who belongs to no project never sees their pending invitations. The badge, which is the only link to `/invitations`, is rendered only inside the project shell, and in-app delivery gives the inviter no link to fall back on
      where:  src/app/p/[projectSlug]/layout.tsx:41, src/app/p/new/page.tsx:9-15, src/app/root-redirect.ts:10, src/server/services/invitations/delivery.ts:23, src/app/p/[projectSlug]/settings/members/invitations-panel.tsx:115
      why:    FR-028 says signed-in users MUST see a count badge of their pending invitations. `InvitationBadge` is mounted only in the `/p/[projectSlug]` layout. `/` sends a user with no projects to `/p/new` (`root-redirect.ts:10`), which renders outside that layout, with no badge, no link and no sign-out control.
              For an existing account, `defaultInvitationDelivery` returns `in_app` with no URL (`delivery.ts:23`), and the inviter is told "They will see it under Invitations when they sign in" (`invitations-panel.tsx:115`). Regenerate behaves the same way.
              So a member who was removed from, or left, their only project and is invited back can't reach the invitation from the UI. Neither can the first admin before creating a project. Probe 4: `/` → `/p/new`, the page has no `/invitations` link, and `/invitations` (typed by hand) lists the invitation.
      owed:   Render the pending-invitation link with its count, plus the user menu with sign-out, on every signed-in page outside the project shell. At least `/p/new` and `/invitations` need it. For example, extract a small signed-in header that the project layout and those pages share, so FR-018's redirect to project creation stays as it is. Add a test proving that a zero-project user with a pending invitation sees the count on `/p/new`, for example a render or decision test for the shared header.
      traces: FR-028, US3 #3, FR-027, US1 #7

- [ ] MINOR F3 — When the session cookie is present but the session is invalid, the project layout's login redirect drops everything after `/p/<slug>`
      where:  src/app/p/[projectSlug]/layout.tsx:23, src/proxy.ts:8
      why:    The proxy only checks that a cookie is present. A stale cookie therefore reaches the layout, which only knows the slug, and it redirects to `/login?next=/p/<slug>`. Probe 5: `/p/bea-co/settings/members` → `next=%2Fp%2Fbea-co`, while the cookie-less request keeps the full path. This happens after a rotated `BETTER_AUTH_SECRET`, a restored database, or a deleted session row, so it is uncommon. The page actions already keep their own path.
      owed:   Pass the full path and query to the layout, for example as a request header set in `src/proxy.ts` and read with `headers()`, and use it for `next`. Add a case to `src/lib/auth-gate.test.ts`.
      traces: FR-013, edge case "Expired session"

- [ ] MINOR F4 — Audit rows are written two ways. Members go through `recordAudit`, which refuses `token|url|password|secret` detail keys. The invitations service calls `tx.audit.insert` directly at six sites, so the guard misses the code that actually handles tokens and URLs
      where:  src/server/services/audit.ts:5-18, src/server/services/members.ts:60, src/server/services/invitations/index.ts:121, src/server/services/invitations/index.ts:153, src/server/services/invitations/index.ts:177, src/server/services/invitations/index.ts:232, src/server/services/invitations/index.ts:246, src/server/services/invitations/index.ts:374
      why:    `recordAudit` takes a `ProjectScope`. The invitee-side paths hold a `ProjectTx`, so that pass bypassed the guard. Today's details keys are only `role`, `invitationId` and `newAccount`, so nothing leaks. But the SC-009 guard covers only the writer least likely to need it.
      owed:   Move `assertSafe` into `createAuditRepo().insert` (`src/server/dal/audit.ts:25`) so every writer is checked. Then delete or thin `recordAudit`. Add one test that inserting a `details` key such as `tokenHash` throws.
      traces: FR-033, SC-009, constitution IV and VII

- [ ] MINOR F5 — Dead ends and parallel helpers left by separate passes
      where:  src/server/services/projects.ts:30, src/server/dal/users.ts:1, src/server/dal/members.ts:46, src/server/auth/session.ts:15, src/server/dal/scope.ts:111-114, src/server/dal/scope.ts:129-135, src/app/setup/actions.ts:25-29, src/app/p/new/actions.ts:25-26, src/lib/action-result.ts:76
      why:    Unused code:
              - `projects.get`;
              - `dal/users.ts`;
              - `MembersRepo.insertOwner`;
              - `requireSession` and `SessionRequiredError`.
              Parallel helpers:
              - `requireRole` and `requirePermission` (FR-034's role-check helper) are used only by `scope-resolution.test.ts`, while every service writes `if (!scope.can(…)) throw new ForbiddenError()` by hand;
              - two actions repeat the ZodError-to-field-errors loop that `fieldErrorsFromZod` already provides.
              Dead logic: `getRoot` (`scope.ts:111-114`) tests `"transaction" in exec`, which is also true of a Drizzle transaction handle, so it always returns `exec`. Its comment describes behaviour that never happens.
      owed:   Delete the unused exports. Use `requirePermission` in the services, or drop it. Use `fieldErrorsFromZod` in both actions. Remove `getRoot`, or make it do what its comment says.
      traces: FR-034, constitution IV

- [ ] MINOR F6 — No automated gate runs the real container entrypoint (fourth-review F1, unchanged)
      where:  tests/startup/prestart.test.ts:13, scripts/prestart.mjs:16, package.json:8, .github/workflows/ci.yml:68
      why:    Every `prestart` test injects `migrate`, so `defaultMigrate` never runs under test. CI's `docker` job builds the image but never starts it. The T101 regression (`ERR_MODULE_NOT_FOUND` on every start) passed every gate.
      owed:   Add a CI smoke step: assemble `.next/standalone` as the `Dockerfile` does, or `docker run` the built image, against the Postgres service. Assert that `/api/health` returns 200, and that a failing migration exits 1 before the port accepts connections.
      traces: FR-004, FR-006, constitution quality gates

- [ ] MINOR F7 — The pre-start migration runs before configuration is validated (fourth-review F2, unchanged)
      where:  scripts/prestart.mjs:10-13, src/server/startup/index.ts:29
      why:    The fourth review measured these, and the code is unchanged:
              - a blank encryption key with the database up still migrates, then names the variable;
              - with the database down, only "migration failed" is printed and the offending variables are never named;
              - `MIGRATE_ON_START=0` still migrates.
      owed:   Bundle `src/server/env.ts` into `prestart`, run `parseEnv` first and exit 1 on `formatEnvIssues`, then take the URL and flag from the parsed env.
      traces: FR-001, US1 #5

- [ ] MINOR F8 — The scope-check summary is never printed (fourth-review F5, unchanged)
      where:  tests/setup/scope-recorder.ts:40, specs/001-foundation-auth-projects/contracts/dal.md:112
      why:    `process.on("beforeExit")` never fires in a Vitest worker. This pass's 250-test run printed 0 `scope-check` lines.
      owed:   Print the summary from an `afterAll` in the setup file, or from a reporter, and confirm it appears in `pnpm test`.
      traces: FR-036, constitution II

- [ ] MINOR F9 — The last-owner demotion message has no "transfer ownership first" hint, and the invalid-invitation action message differs from the `routes.md` copy (fourth-review F3, unchanged)
      where:  src/server/dal/errors.ts:30, src/server/services/members.ts:58, src/lib/action-result.ts:50, specs/001-foundation-auth-projects/contracts/routes.md:23
      why:    `changeRole` throws the bare default message. `invitation_invalid` reads "invalid, expired or already used", but `/signup` uses the `routes.md` sentence for the same outcome.
      owed:   Put the hint in `LastOwnerError`'s default message and use the `routes.md` sentence for `invitation_invalid`, with assertions.
      traces: FR-024, US4 #5, US3 #7

- [ ] MINOR F10 — Three hand-rolled forms render field errors without `aria-live` (fourth-review F4, unchanged)
      where:  src/app/p/new/new-project-form.tsx:35, src/app/p/[projectSlug]/settings/settings-form.tsx:27, src/app/setup/setup-form.tsx:28, src/components/ui/Field.tsx:40
      why:    The form-level `role="alert"` shows only when there are no field errors. So a server-side error such as "That URL name is already taken." is not announced.
      owed:   Use `Field` and `Select` from `src/components/ui/`, or add `aria-live="polite"` to those spans.
      traces: FR-041

- [ ] MINOR F11 — The DAL has two locked-transaction abstractions and two cross-project helpers, and the invitations service imports from past `dal/index.ts` (fourth-review F6, unchanged)
      where:  src/server/dal/invitations.ts:89, src/server/dal/scope.ts:47, src/server/db/cross-project.ts:11, src/server/dal/index.ts:4, src/server/services/invitations/index.ts:13-23
      why:    `withLockedProject` is unlabelled, not wrapped in `crossProject`, and not exported from the sanctioned surface.
      owed:   Rename it to an invitee-specific name, wrap it in `crossProject`, export it through `dal/index.ts`, and keep one cross-project helper.
      traces: FR-034, constitution III

- [ ] MINOR F12 — Small rules are still written twice, and an empty `DATABASE_URL_DIRECT=` is treated differently by different readers (fourth-review F7, unchanged)
      where:  drizzle.config.ts:4, tests/setup/global-setup.ts:12, src/server/env.ts:99, scripts/prestart.mjs:12, src/server/crypto/tokens.ts:14, src/lib/validation/token.ts:3, src/components/shell/LeftNav.tsx:6, src/app/p/[projectSlug]/[section]/page.tsx:4
      why:    `env.ts` and `prestart` fall back with `||`, but `drizzle.config.ts` and the test `globalSetup` use `??`. The token regex and the nav sections are each defined twice.
      owed:   Use `||` at both `??` sites. Build `invitationTokenSchema` on `isWellFormedToken`. Derive `PLACEHOLDERS` from `NAV_SECTIONS`.
      traces: FR-002, FR-020, FR-026

- NOTE F13 — What I checked and found sound, so that the reader can weigh the findings above:
  - **Membership and token races:** `scope.transaction({ lockProject })` locks, then re-resolves membership in a fresh statement (`src/server/dal/scope.ts:98-103`). Every membership and invitation mutation re-checks its permission inside the lock. A token claim is one conditional `UPDATE … RETURNING` (`src/server/dal/tokens.ts:85-103`), rolled back if a later check fails.
  - **Sign-up:** `signUp` takes the email from the invitation, never from input (`src/server/services/invitations/index.ts:366-369`).
  - **Last owner:** protection runs under the lock for demote, remove and leave.
  - **Isolation:** non-members and unknown slugs both hit `notFound()` in the layout.
  - **Tests are substantive:** they hit real Postgres, and they include races (double sign-up, concurrent owner demotion, removal during lock wait) and failure cases (expired, revoked, regenerated-away and used tokens).
  - **One gap in the matrix:** `permissions.test.ts:37` is titled "admin can … invite an editor" but never invites anyone. It is the only weak spot I found in the permission tests.
  - **The fourth review's notes still stand:**
    - `/login` sends no `Referrer-Policy`, though its `next` can carry a token;
    - T089 looks closable from decisions.md #20;
    - the T096–T101 ticks are uncommitted.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted | Not checkable here |
|---|---|---|---|---|---|---|
| Functional requirements | 41 | 36 | 5 | 0 | 0 | 0 |
| Success criteria | 11 | 7 | 1 | 0 | 0 | 3 |
| Constitution principles | 7 | 5 | 1 | 0 | 0 | 0 (V is N/A) |

**Functional requirements:**
- **Partial:**
  - FR-001 (F7);
  - FR-009 (F1, measured);
  - FR-013 (F3, measured);
  - FR-028 (F2, measured);
  - FR-041 (F10).
- **Satisfied, with evidence gathered in this pass:**
  - FR-004 and FR-012 (probe 7);
  - FR-011 (probe 6 plus `auth-endpoints.test.ts`);
  - FR-021–FR-024 (`permissions.test.ts`, `members.test.ts`, `lock-recheck.test.ts`);
  - FR-026 (`invitation-tokens.test.ts`);
  - FR-035 (`db-import.test.ts` and lint);
  - FR-039 (all five gates above).
- **Satisfied, read here and unchanged since the fourth review's evidence:** the rest.

**Success criteria:**
- **Satisfied:**
  - SC-004 (probe 6 and tests);
  - SC-005, SC-006, SC-008, SC-009 and SC-010 (suite run here);
  - SC-002 (measured by the fourth review; code unchanged).
- **Partial:** SC-011. The local half passes (probe 7); the Neon half is "not verified".
- **Not checkable here:** SC-001, SC-003 and SC-007 (browser and timing).

**Constitution principles:**
- **Satisfied:** I, III, IV, VI and VII. F4 and F5 are convention gaps, not violations.
- **Partial:** II. T078's scope summary has never printed (F8), and the entrypoint has no executed guard (F6).
- **N/A:** V.

**Tasks:** every task except T083, T084 and T089 is ticked. This review adds T102 and T103.

## What I could not check

- **Docker itself:** `docker build` and `docker compose up` (the Docker socket isn't available here). I ran the runner-stage layout and its `CMD` from a clean build instead. That covers everything except the Linux base image, the `nextjs` user's permissions, and Compose's health-gated ordering.
- **A real reverse proxy in front of Docket** (nginx, Caddy or a CDN). Probe 3 sends the header that an appending proxy forwards. I didn't run one.
- **Anything in a browser:**
  - the login → `next` round trip, and setup, sign-up, accept and decline through the UI;
  - Ctrl/⌘+K focus and its return, and ≤ 4 keystrokes (SC-007);
  - `<dialog>` focus trapping and screen-reader announcements (F10 comes from reading the code);
  - the last-project cookie surviving a browser restart;
  - the SC-001 and SC-003 timings;
  - Better Auth U2 (`nextCookies()` on a server-action sign-in). The setup and sign-up actions use it, and only a browser shows that the cookie lands.
- **Neon (SC-011's second half, T084):** no connection string is available.
- **CI on GitHub:** the gates were run locally with CI's env shape. The workflow run itself wasn't observed.
