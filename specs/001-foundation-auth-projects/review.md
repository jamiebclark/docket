# Review: Docket Foundation — Accounts, Projects, Members, Invitations and Project Isolation

Reviewed 168 file(s) changed across 47 commit(s), against `37eed2e` (merge-base with `origin/main`)...`716f760` (HEAD), **plus the uncommitted working tree**. This is the sixth review of this branch.

**What changed since the fifth review:** no new commits. The Phase 13 implement pass (T102, T103) left its work uncommitted: 10 modified files and 3 untracked ones. So this review covers the **present working tree**, not just `base...HEAD`:
- **Modified:** `.env.example`, `README.md`, `docs/decisions.md`, `tasks.md` (two ticks), `src/app/invitations/page.tsx`, `src/app/p/[projectSlug]/layout.tsx`, `src/app/p/new/page.tsx`, `src/server/auth/auth.ts`, `src/server/env.ts`, `tests/integration/auth-endpoints.test.ts`.
- **Untracked:** `src/components/shell/SignedInHeader.tsx`, `src/server/auth/sign-in-limit.ts`, `tests/integration/signed-in-header.test.ts`.

**Read in full:**
- **The whole uncommitted delta:** every file listed above.
- **Code the delta depends on:**
  - `src/components/shell/{InvitationBadge,UserMenu,actions}.tsx|ts`, `src/app/invitations/actions.ts`, `src/app/layout.tsx`, `src/proxy.ts`, `src/lib/validation/email.ts`;
  - `docker-compose.yml`, the `Dockerfile` runner stage, `src/app/login/login-form.tsx`.
- **Better Auth 1.7.7 internals the fix relies on:**
  - `better-auth/dist/api/rate-limiter/index.mjs` (custom-rule override at `:262-277`, special rules at `:305-319`);
  - `@better-auth/core/dist/utils/ip.mjs` (`getIPFromHeader`, `getIP`: trusted-proxy walk, single-value rule, test/dev localhost fallback);
  - `better-auth/dist/api/dispatch.mjs` (`hooks.before` runs before the endpoint);
  - `better-auth/dist/api/routes/sign-in.mjs:318` (email lowercased, not trimmed);
  - Next's `proxyClientMaxBodySize` doc (10 MB default buffer).
- **Spec artifacts:** `spec.md` (FR-009, FR-013, FR-027, FR-028, FR-040), research D5, the fifth `review.md`, the Phase 13 block of `tasks.md`, the constitution headings, and the `docket-ui` skill's structure rules.

**Sampled:**
- **Carried MINORs:** the lines cited by the fifth review's MINOR findings (carried below as F3–F12). I re-checked that each still points at the code it describes. Only `layout.tsx` moved, so F3 is now `:20`.
- **Not re-read:** the rest of the feature. It is byte-identical to what the fifth review read in full.

**Not reviewed:** `src/components/ui/{Badge,Button,Table,EmptyState}.tsx` (presentational), and `pnpm-lock.yaml`, `drizzle/meta/*` (generated). None of these changed.

**Gates (run on the working tree in this pass):**

| Gate | Result |
|---|---|
| `pnpm lint` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm db:check` | "Migrations are current." |
| `pnpm test` (`DATABASE_URL=…127.0.0.1:5433/docket_test`, `BETTER_AUTH_SECRET` and `CREDENTIALS_ENCRYPTION_KEY` unset) | 34 files, 254 tests, all pass, 26.5 s. That is 4 more tests than the fifth review. The output has 0 `scope-check` lines (F8) |
| `next build` + the `build:prestart` esbuild step (a copy of the working tree in `$TMPDIR`, env holding only `DATABASE_URL`) | exit 0; `.next/standalone/scripts/prestart.mjs` is 468.1 KB |

**Probes.** I assembled the runner-stage layout exactly as the `Dockerfile`'s `COPY` lines do and started it with its `CMD` (`node scripts/prestart.mjs`, `NODE_ENV=production`). It ran against a throwaway `docket_review6b_test` database on the local Postgres 17, seeded with three users:
- `admin`: the bootstrap account, with no projects and one pending invitation;
- `bob`: owner of `bea-co`;
- `carol`: no projects.

The server ran three times: with defaults, then with `TRUSTED_PROXIES`, then with `TRUSTED_IP_HEADERS`. The database and build were removed afterwards.

1. **Zero-project user (fifth-review F2):**
   - admin signs in → 200, and `/` → 307 `/p/new`;
   - `/p/new` contains `href="/invitations"`, the count `1 pending` and "Sign out";
   - `/invitations` shows the same header and lists the invitation;
   - `/p/bea-co` as bob still shows the header (no count, since bob has nothing pending) and the project switcher.
2. **Client-chosen `X-Forwarded-For` (fifth-review F1):**
   - ten wrong passwords for carol, each with a different single-IP header, gave `401 401 401 429 429 429 429 429 429 429`;
   - carol's correct password in the same window → 429, and `"  CAROL@Example.com "` → 429 (counted as the same key);
   - after the window → 200.
3. **Two-entry header** (`a1.example, 10.0.0.1`, which lands in Better Auth's shared `no-trusted-ip` bucket; the server logged that warning): carol failed three times (`401 ×3`), then bob signed in with a different two-entry header → **200**.
4. **Honest client** (no header, so Next fills in the socket IP), 33 distinct unknown emails: `401` ×30, then `429` from attempt 31. The 30-per-10-second per-IP backstop holds.
5. **`TRUSTED_PROXIES=198.51.100.0/24`:**
   - 31 attempts with `203.0.113.5, 198.51.100.1` → first 429 at attempt 31;
   - `203.0.113.6, 198.51.100.1` straight after → 401;
   - so the setting is wired, and it resolves the real client behind the proxy.
6. **`TRUSTED_IP_HEADERS=x-real-ip`:**
   - 31 attempts with `x-real-ip: 203.0.113.9` and a *different* `X-Forwarded-For` each time → first 429 at 31;
   - `x-real-ip: 203.0.113.10` → 401;
   - so the setting is wired, and `X-Forwarded-For` is ignored.
7. **Startup:** "database migrations applied", then "✓ Ready", on every start. This matches the fifth review's probe 7.

## Verdict

**Both blocking findings from the fifth review are fixed, and the fixes were shown on the built server. Nothing blocks the merge.** What remains is ten MINORs: two new ones about the per-email limiter and its README text, plus eight carried over. A human must also commit the working tree and close the three tasks that need a human.

**F1 (FR-009) is closed.** The `before` hook adds a per-email limit, which the forged-header probe could not get around (probe 2). Two other changes relax the shared-bucket lockout:
- the per-IP rule for `/sign-in/email` is now 30 per 10 seconds (probes 3–4);
- `advanced.ipAddress` can now be configured from env, and both settings were shown to take effect (probes 5–6).

The two new integration tests separate the old behaviour from the new. Without the hook the first test's 4th try is 401. With Better Auth's 3-per-10-second shared bucket, the second test's sign-in is 429.

**F2 (FR-028) is closed.** One `SignedInHeader` now replaces the project layout's inline header, and it renders on `/p/new` and `/invitations` too. So there is still exactly one implementation, and FR-018's redirect is unchanged (probe 1). The header test renders it against real Postgres and a real `countMine`.

**The two passes fit together.** The header is a server component that fetches through `services/invitations`, as the `docket-ui` rules require. The limiter sits in the same hook as the sign-up gate, and it applies only to HTTP requests, so the in-process sign-ins in setup and sign-up are untouched. The README, `.env.example` and decisions #22 describe the code, with one wrong parenthetical (F2).

**What I would do:**
1. Commit the working tree.
2. Pick up F1 (MINOR) and F2 (MINOR) with the other MINORs after the merge.
3. Have a human run T083 (Docker and browser survey), T084 (Neon) and T089 (`docker build`).

## Findings

- [ ] MINOR F1 — The per-email sign-in limiter keys its in-memory map on the raw, unvalidated `email` string from the request body, and it re-implements email normalisation that `src/lib/validation` already owns
      where:  src/server/auth/sign-in-limit.ts:7, src/server/auth/sign-in-limit.ts:8-10, src/server/auth/sign-in-limit.ts:13, src/server/auth/auth.ts:64-65, src/lib/validation/email.ts:3, src/proxy.ts:25
      why:    The `before` hook runs before Better Auth validates the body (`dispatch.mjs:210`). So the hook counts any string: `typeof email === "string"` is the only check.
              - **Memory.** `key = email.trim().toLowerCase()` is stored for the 10-second window, so each request can pin a key as large as its body. The proxy matcher covers `/api/auth`, and Next buffers up to 10 MB per body (`proxyClientMaxBodySize` default). A forged `X-Forwarded-For` sidesteps the per-IP backstop. So memory held equals upload bandwidth × 10 s.
              - **CPU.** Once the map holds more than 10,000 live keys, every attempt walks the whole map (`:8-10`) and deletes nothing.
              - **Duplicated rule.** T096 made `emailSchema` the single source of email rules, which trims, lowercases and caps at 254 characters. The limiter repeats two of those three steps by hand.
              It is safe to ship because the cost is bandwidth-bound and expires in 10 s. Better Auth's own memory store keeps only short, validated IP keys.
      owed:   Derive the key with `emailSchema.safeParse(email)`. When parsing fails, skip counting, because Better Auth rejects that body and cannot match it to a stored user (`sign-in.mjs:318` looks up the lowercased address). Cap the map, for example by refusing new keys or evicting the oldest past the cap. Add a unit test for `createEmailAttemptLimiter`: window reset, case and space folding, and that an over-long string is not stored.
      traces: FR-009, constitution IV (one set of rules, many callers)

- [ ] MINOR F2 — The rewritten README says every route other than `/sign-in/email` keeps "100 per 10 seconds". In fact Better Auth's built-in rules hold `/sign-up*`, `/change-password` and `/change-email` to 3 per 10 s, and password reset to 3 per 60 s
      where:  README.md:60, node_modules/better-auth/dist/api/rate-limiter/index.mjs:305-319
      why:    T102 asked for this section to "describe only what holds". The parenthetical understates the limit on `/change-password`, the other endpoint that checks a password.
      owed:   Replace the line with what is true. For example: "Other routes keep Better Auth's built-in rules: 3 per 10 seconds for `/sign-up*`, `/change-password` and `/change-email`, 3 per 60 seconds for password-reset requests, and 100 per 10 seconds elsewhere."
      traces: FR-040, FR-009

- [ ] MINOR F3 — When the session cookie is present but the session is invalid, the project layout's login redirect drops everything after `/p/<slug>` (fifth-review F3, unchanged)
      where:  src/app/p/[projectSlug]/layout.tsx:20, src/proxy.ts:8
      why:    The proxy only checks that a cookie is present, and the layout knows only the slug. The fifth review measured it: `/p/bea-co/settings/members` with a stale cookie redirects to `next=%2Fp%2Fbea-co`.
      owed:   Pass the full path and query to the layout, for example as a request header set in `src/proxy.ts`. Add a case to `src/lib/auth-gate.test.ts`.
      traces: FR-013, edge case "Expired session"

- [ ] MINOR F4 — Audit rows are written two ways, and only `recordAudit` refuses `token|url|password|secret` detail keys. The invitations service calls `tx.audit.insert` directly at six sites (fifth-review F4, unchanged)
      where:  src/server/services/audit.ts:5-18, src/server/services/invitations/index.ts:121, src/server/services/invitations/index.ts:153, src/server/services/invitations/index.ts:177, src/server/services/invitations/index.ts:232, src/server/services/invitations/index.ts:246, src/server/services/invitations/index.ts:374
      why:    The SC-009 guard covers the writer least likely to need it. Today's detail keys are only `role`, `invitationId` and `newAccount`, so nothing leaks.
      owed:   Move `assertSafe` into `createAuditRepo().insert` (`src/server/dal/audit.ts:25`), then delete or thin `recordAudit`. Add a test that a `tokenHash` detail key throws.
      traces: FR-033, SC-009, constitution IV and VII

- [ ] MINOR F5 — Dead ends and parallel helpers left by separate passes (fifth-review F5, unchanged)
      where:  src/server/services/projects.ts:30, src/server/dal/users.ts:1, src/server/dal/members.ts:46, src/server/auth/session.ts:15, src/server/dal/scope.ts:111-114, src/app/setup/actions.ts:25-29, src/app/p/new/actions.ts:25-26, src/lib/action-result.ts:76
      why:    Left over from separate passes:
              - **Unused:** `projects.get`, `dal/users.ts`, `MembersRepo.insertOwner`, `requireSession`.
              - **Parallel helpers:** `requirePermission` is used only by tests, while every service hand-writes `if (!scope.can(…))`. Two actions repeat `fieldErrorsFromZod` by hand.
              - **Dead logic:** `getRoot` always returns its argument.
      owed:   Delete the unused exports. Use `requirePermission` in the services or drop it. Use `fieldErrorsFromZod` in both actions. Remove `getRoot`, or make it do what its comment says.
      traces: FR-034, constitution IV

- [ ] MINOR F6 — No automated gate runs the real container entrypoint (fourth-review F1, unchanged)
      where:  tests/startup/prestart.test.ts:13, scripts/prestart.mjs:16, .github/workflows/ci.yml:68
      why:    Every `prestart` test injects `migrate`, and CI's `docker` job builds the image but never starts it. The T101 regression (`ERR_MODULE_NOT_FOUND` on every start) passed every gate.
      owed:   Add a CI smoke step that starts the built image, or the assembled `.next/standalone`, against the Postgres service. Assert that `/api/health` returns 200, and that a failing migration exits 1 before the port opens.
      traces: FR-004, FR-006, constitution II

- [ ] MINOR F7 — The pre-start migration runs before configuration is validated (fourth-review F2, unchanged)
      where:  scripts/prestart.mjs:10-13, src/server/startup/index.ts:29
      why:    Two consequences:
              - a blank encryption key with the database up still migrates before the variable is named;
              - with the database down, only "migration failed" is printed, and `MIGRATE_ON_START=0` is ignored by `prestart`.
      owed:   Bundle `src/server/env.ts` into `prestart`, run `parseEnv` first, and take the URL and the flag from the parsed env.
      traces: FR-001, US1 #5

- [ ] MINOR F8 — The scope-check summary is never printed (fifth-review F8, unchanged)
      where:  tests/setup/scope-recorder.ts:40, specs/001-foundation-auth-projects/contracts/dal.md:112
      why:    `process.on("beforeExit")` never fires in a Vitest worker. This pass's 254-test run printed 0 `scope-check` lines.
      owed:   Print the summary from an `afterAll` in the setup file, or from a reporter, and confirm it appears in `pnpm test`.
      traces: FR-036, constitution II

- [ ] MINOR F9 — The last-owner demotion message has no "transfer ownership first" hint, and the `invitation_invalid` action copy differs from `routes.md` (fifth-review F9, unchanged)
      where:  src/server/dal/errors.ts:30, src/server/services/members.ts:58, src/lib/action-result.ts:50, specs/001-foundation-auth-projects/contracts/routes.md:23
      why:    `changeRole` throws the bare default message. `/signup` uses the `routes.md` sentence for the same outcome that the action words differently.
      owed:   Put the hint in `LastOwnerError`'s default message and use the `routes.md` sentence, with assertions.
      traces: FR-024, US4 #5, US3 #7

- [ ] MINOR F10 — Three hand-rolled forms render field errors without `aria-live` (fifth-review F10, unchanged)
      where:  src/app/p/new/new-project-form.tsx:35, src/app/p/[projectSlug]/settings/settings-form.tsx:27, src/app/setup/setup-form.tsx:28, src/components/ui/Field.tsx:40
      why:    The form-level `role="alert"` shows only when there are no field errors, so a server-side field error such as "That URL name is already taken." is not announced.
      owed:   Use `Field` and `Select` from `src/components/ui/`, or add `aria-live="polite"` to those spans.
      traces: FR-041

- [ ] MINOR F11 — The DAL has two locked-transaction abstractions and two cross-project helpers, and the invitations service imports from past `dal/index.ts` (fifth-review F11, unchanged)
      where:  src/server/dal/invitations.ts:89, src/server/dal/scope.ts:47, src/server/db/cross-project.ts:11, src/server/dal/index.ts:4, src/server/services/invitations/index.ts:13-23
      why:    `withLockedProject` is unlabelled, not wrapped in `crossProject`, and not exported from the sanctioned surface.
      owed:   Rename it to an invitee-specific name, wrap it in `crossProject`, export it through `dal/index.ts`, and keep one cross-project helper.
      traces: FR-034, constitution III

- [ ] MINOR F12 — Small rules are written twice, and readers treat an empty `DATABASE_URL_DIRECT=` differently (fifth-review F12, unchanged)
      where:  drizzle.config.ts:4, tests/setup/global-setup.ts:12, src/server/env.ts:110, scripts/prestart.mjs:12, src/server/crypto/tokens.ts:14, src/lib/validation/token.ts:3, src/components/shell/LeftNav.tsx:6, src/app/p/[projectSlug]/[section]/page.tsx:4
      why:    `env.ts` and `prestart` use `||`, while `drizzle.config.ts` and the test `globalSetup` use `??`. The token regex is defined twice, and so are the nav sections.
      owed:   Use `||` at both `??` sites. Build `invitationTokenSchema` on `isWellFormedToken`. Derive `PLACEHOLDERS` from `NAV_SECTIONS`.
      traces: FR-002, FR-020, FR-026

- NOTE F13 — The per-email limit is the right fix, but it has a cost that decisions #22 (`docs/decisions.md:128`) does not record. Anyone who knows a user's email can keep that user from signing in by sending three attempts every 10 seconds, forging `X-Forwarded-For` to stay under the per-IP backstop (probe 2: carol's correct password got 429 inside the window). That is inherent to per-account limiting, and the window is only 10 s. But FR-040 asks for judgement calls to be logged, and this consequence is part of the call. Consider one sentence in #22, and whether the README should say it too.

- NOTE F14 — The Phase 13 work exists only in the working tree. That is the T102 and T103 code, tests and docs, and the two `tasks.md` ticks (10 modified files and 3 untracked, listed above). It has to be committed before the merge. Three tasks stay open, and each one needs a human:
  - T083: Docker and browser survey;
  - T084: Neon;
  - T089: `docker build`, which needs the Docker socket.

  T089 looks closable from decisions #20 and CI's `docker` job, as the fourth and fifth reviews noted.

- NOTE F15 — What I checked and found sound, so the reader can weigh the findings above:
  - **One header implementation:** `SignedInHeader` (`src/components/shell/SignedInHeader.tsx:11`) replaces the layout's inline header rather than copying it (`src/app/p/[projectSlug]/layout.tsx:32`).
  - **The invitation count stays fresh:** decline and accept on `/invitations` both `redirect` (`src/app/invitations/actions.ts:26`, `:40`), so the header count re-renders.
  - **The inviter's copy is now true:** "They will see it under Invitations when they sign in" (`invitations-panel.tsx:115`) holds for zero-project users.
  - **The limiter applies to HTTP requests only:** `ctx.request && ctx.path === "/sign-in/email"` (`src/server/auth/auth.ts:63`). In-process `auth.api` sign-ins after setup and sign-up are not counted. The login form already maps 429 to "Too many attempts" (`src/app/login/login-form.tsx:26`).
  - **The custom rule overrides Better Auth's special rule:** custom rules are applied after the built-in rules (`rate-limiter/index.mjs:262-277`), so `/sign-in/email` gets 30 per 10 s per IP and no other path changes.
  - **The new env vars reach the container:** `TRUSTED_*` arrive through Compose's `env_file: .env` (`docker-compose.yml:26`). Invalid `TRUSTED_PROXIES` entries are logged and ignored by Better Auth (`create-context.mjs:91-94`).
  - **The new tests discriminate:** with the old code, `auth-endpoints.test.ts:98` gets 401 on the 4th try and `:108` gets 429. Removing the count makes `signed-in-header.test.ts:18` fail.
  - **Still open from earlier reviews:**
    - `permissions.test.ts:37` is titled "admin can … invite an editor" but never invites anyone;
    - `/login` sends no `Referrer-Policy`, though its `next` can carry a token.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted | Not checkable here |
|---|---|---|---|---|---|---|
| Functional requirements | 41 | 38 | 3 | 0 | 0 | 0 |
| Success criteria | 11 | 7 | 1 | 0 | 0 | 3 |
| Constitution principles | 7 | 5 | 1 | 0 | 0 | 0 (V is N/A) |

**Functional requirements:**
- **Satisfied in this pass, measured:**
  - FR-009, previously partial (probes 2–6 and `auth-endpoints.test.ts:88-131`). F1 and F2 here are MINOR follow-ups;
  - FR-028, previously partial (probe 1 and `signed-in-header.test.ts`);
  - FR-018 (probe 1: `/` → `/p/new`, unchanged);
  - FR-004 and FR-012 (probe 7);
  - FR-039 (all five gates above).
- **Partial:**
  - FR-001 (F7);
  - FR-013 (F3);
  - FR-041 (F10).
- **Satisfied, unchanged since the fifth review's evidence:** the remaining 33. Their code is byte-identical, and the suite run here passes.

**Success criteria:**
- **Satisfied:**
  - SC-002 and SC-004 (by the fifth review; code unchanged);
  - SC-005, SC-006, SC-008, SC-009 and SC-010 (suite run here).
- **Partial:** SC-011. The local half passes (probe 7); the Neon half is still "not verified" (T084).
- **Not checkable here:** SC-001, SC-003 and SC-007 (browser and timing).

**Constitution principles:**
- **Satisfied:** I, III, IV, VI and VII. F1, F4, F5, F11 and F12 are convention gaps, not violations.
- **Partial:** II. The scope summary has never printed (F8), and the entrypoint has no executed guard (F6).
- **N/A:** V.

**Tasks:** every task except T083, T084 and T089 is ticked, and each tick I checked matches the code. This review adds no tasks, because nothing blocks.

## What I could not check

- **Docker itself:** `docker build` and `docker compose up` (the Docker socket isn't available here). I ran the runner-stage layout and its `CMD` from a fresh build of the working tree instead. That covers everything except the Linux base image, the `nextjs` user's permissions, and Compose's health-gated ordering.
- **A real reverse proxy** (nginx, Caddy or a CDN). Probes 5–6 send the headers such a proxy would forward, but I didn't run one.
- **Memory under a large-body flood (F1):** reasoned from the code and Next's documented 10 MB buffer, not measured. The sandbox blocks reading the server's memory use.
- **More than one instance:** the per-email counter is per process, as the README says. I didn't run two.
- **Anything in a browser:**
  - clicking Sign out on `/p/new` and `/invitations`. The form and server action are the same ones the project shell uses, and the markup is present;
  - the login → `next` round trip, and setup, sign-up, accept and decline through the UI;
  - Ctrl/⌘+K focus and its return, and ≤ 4 keystrokes (SC-007);
  - `<dialog>` focus trapping and screen-reader announcements;
  - the last-project cookie surviving a browser restart;
  - the SC-001 and SC-003 timings.
- **Neon (SC-011's second half, T084):** no connection string is available.
- **CI on GitHub:** the gates were run locally with CI's env shape. The workflow run itself wasn't observed.
- **Housekeeping a human must do:** my first probe attempt crashed during seeding and left a standalone server listening on `127.0.0.1:3123` (pid 62526). The sandbox refused `kill` and `ps`. The database it pointed at has since been dropped, so it serves nothing useful; run `kill 62526`. Everything else from this pass has been removed: the `docket_review6*_test` databases and the `$TMPDIR` build.
