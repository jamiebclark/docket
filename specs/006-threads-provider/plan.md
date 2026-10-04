# Implementation Plan: Threads provider (Meta, part 2)

**Branch**: `006-threads-provider` | **Date**: 2026-10-04 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/006-threads-provider/spec.md`

## Summary

Docket gains a `threads` provider in its own folder, registered by one line. It reuses the shared Meta module from 005 (Graph client, error table, secret scrubbing, env helpers) without copying it.

- **Connect** is a second OAuth connect group, `threads`, with its own `THREADS_APP_ID` / `THREADS_APP_SECRET` and an optional `THREADS_GRAPH_BASE` (default `https://graph.threads.com`, because the `.net` host is unverified, U1):
  1. the login goes to `https://threads.com/oauth/authorize` with `threads_basic,threads_content_publish`;
  2. the callback exchanges the code server-side for a short-lived token, then `th_exchange_token` for a 60-day token, then reads `/me`;
  3. only the long-lived token is stored, encrypted, with its issue time and expiry (FR-013).

  A paste fallback (exchange → renewal → profile, research D6) covers deployments without an HTTPS redirect.
- **Renewal** runs in the existing scheduled token-refresh section. `th_refresh_token` is called only when the token is ≥ 24 h old and unexpired:
  - a token under 24 h is parked until it is old enough (G11);
  - an expired token, or a definitive refusal, becomes `needs_reauth`;
  - network errors and 5xx are transient.
- **Validation** uses Threads' own rule: 500 units, where an emoji grapheme counts its UTF-8 bytes and every other character counts per code point. This works through a provider-declared counting rule (G9), so the composer's live count equals the enforced count. Image rules (JPEG/PNG, 8 MB, 320–1,440 px wide, 1:10–10:1, 20 images, 1,000-character alt text) are capabilities that the 003 media planner already enforces.
- **Publishing** is a pure, total step machine, one request per tick:
  1. create (carousel items first, then the carousel; or one TEXT/IMAGE container);
  2. `check_status` via `continue` + `notBefore` (30 s, then 60 s, 5-minute cap; `ERROR` → fatal, `EXPIRED` → recreate at most twice, `PUBLISHED` → ambiguous);
  3. `check_quota` against `threads_publishing_limit`, on top of the engine's own 250/24 h counter;
  4. one `mayPublish` `threads_publish`. A timeout, reset, 5xx or unparseable reply is `ambiguous`; 190 → `needs_reauth` (G7).
- **Docs**:
  - `docs/meta-setup.md` replaces its Threads placeholder with the dashboard steps and a local HTTPS walkthrough (hosts file `docket.local`, mkcert, `next dev --experimental-https … -H docket.local`);
  - a README "Connecting Threads" section;
  - `docs/adding-a-provider.md` covers G9/G10 and a Threads worked example;
  - `docs/decisions.md` gets the 006 entries.

Planning found **five generic framework gaps**. Each is fixed for every provider and recorded in `docs/decisions.md` (details in [research §2](./research.md#2-framework-gaps-found-while-planning)):

- **G9**: provider-declared text counting rule (`CustomCountingRule`).
- **G10**: a connect group's callback-address requirement (HTTPS / not localhost). When the address does not qualify, the connect action is unavailable with a reason and start is refused server-side; paste stays available.
- **G11**: the scheduled refresh honours a transient `retryAt` by parking the refresh lease (capped at 24 h).
- **G12**: a group's static `callbackHint` is shown after a failed callback (the tester-invite reminder, FR-014).
- **G13**: providers may show non-secret account notes (the estimated expiry, FR-015).

There is no schema change. The scheduler's claim, lease, backoff, limit, recovery and G7 logic is unchanged.

## Technical Context

**Language/Version**: TypeScript 5 (strict) on Node 24 LTS (`>=24.10 <25`; planning checked on 24.16).

**Primary Dependencies**: all already installed (decision #19). **Nothing new.**

- Platform `fetch` (undici) through the shared `graphRequest`. No Threads SDK.
- `Intl.Segmenter` and Unicode property escapes (`\p{Extended_Pictographic}`, `\p{Regional_Indicator}`), built into Node 24, for the counting rule.
- `TextEncoder` for byte lengths.
- zod 4 for credentials, state, settings and env.
- Next.js 16.3.8, used as before: Route Handler `/connect/callback`, Server Actions, server components. The dev-server flags `--experimental-https`, `--experimental-https-key`, `--experimental-https-cert` and `-H` come from `node_modules/next/dist/docs/01-app/03-api-reference/06-cli/next.md`. Per `allowedDevOrigins.md`, the dev server allows the hostname it was started with, so `next.config.ts` is unchanged.
- Vitest.
- mkcert is a developer tool the deployer installs. It is not a project dependency (FR-037).

**Storage**: PostgreSQL 17.

- **No migration.** Existing columns are reused: `social_accounts.{credentials_encrypted, credentials_expires_at, settings, status, last_error, last_refreshed_at, refresh_lease_until, refresh_lease_owner}`, `post_targets.{step_state, external_id}` and `connect_attempts.candidates_encrypted`.
- Media comes from the provider variant's public URL. A public bucket is required, as for Instagram.

**Testing**: Vitest against real Postgres (the existing harness).

- `tests/helpers/fake-graph.ts` (005) is reused, gaining only a logged `host` field.
- New `tests/helpers/threads-publish.ts`.
- Unit tests sit beside the code; integration tests are in `tests/integration/threads/`.
- Throwaway-provider tests cover G9–G13.
- The DB clock is used instead of sleeps. **No live calls** (FR-034).

**Target Platform**: the existing `node:24-slim` image for `web` and `worker`. The worker bundle gains only pure TypeScript.

**Project Type**: the single Next.js app.

- `src/providers/**` stays a leaf: the lint rule bans `src/server/**` imports.
- Generic engine code stays in `src/server/scheduler/`, the services in `src/server/services/`.

**Performance Goals** (SC-004):

- Each step makes at most **one** platform request, bounded by `SCHEDULER_PROVIDER_TIMEOUT_SECONDS`.
- Text or a single image publishes in 4 ticks when ready at the first check; an N-image carousel in N + 4.
- Connect makes ≤ 3 requests (code, long-lived, profile); paste makes ≤ 3; each is within the 15 s connect timeout.
- Counting is O(length) per check.

**Constraints**:

- No provider I/O inside a transaction. No sleeps or loops in `advance`.
- `publish` is the only `mayPublish` step. Containers are never recreated after a publish request.
- Tokens, the app secret and codes never reach the browser, logs, attempts, step state, `last_error`, messages or snapshots (FR-033).
- Facebook and Instagram behaviour and test expectations are unchanged (FR-003).

**Scale/Scope**:

- 1 new provider folder (~14 source files).
- 5 generic fixes, touching ~12 framework files.
- 3 env vars.
- No new routes, pages or tables.
- Docs: `meta-setup.md`, README, `adding-a-provider.md`, `decisions.md`, `.env.example`.

**Unknowns**: no `NEEDS CLARIFICATION` remains.

- R1–R10 are not in `docs/research/meta.md` and cannot be fetched by a phase. Each is resolved as an **interim decision** in [research §1](./research.md#1-interim-values-for-the-specs-needs-research-items): one constant, covered by mocks, recorded in `docs/decisions.md` as unverified. This is the treatment the spec prescribes.
- U1 and U2, and all live behaviour, are reported as "unverified" / "verified with mocks only".

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design (below).*

| Principle | Status | How this plan complies |
|---|---|---|
| I. Verified facts over memory | ✅ | Hosts, scopes, token grants, lifetimes, the 24 h rule, media types, limits, statuses, polling advice and the publishing limit come from `docs/research/meta.md`. Next.js flags come from the bundled docs. Everything missing (version segment, code-exchange shape, profile read, error codes, carousel params, container lifetime, quota fields, redirect ports, the emoji rule, the permalink) is R1–R10, each with an interim value in one constant, mocked tests and a decisions entry. Brief-vs-research differences are in the spec's table. |
| II. Nothing is "working" unless it ran | ✅ | Every path has mocked-HTTP tests. Live connect, renewal and publishing, U1, U2 and the local HTTPS walk (quickstart §7) are reported as "verified with mocks only" or "not verified". Quickstart §8 is the owner's live check. |
| III. Project isolation | ✅ | No new table or query shape. Accounts, targets and connect attempts go through the existing project-scoped repos. `listAccounts` notes come from already-scoped rows. Roles are checked on the server at start (including the new G10 refusal), callback, paste, chooser and choose. The authz table gains the unavailable-group rows. |
| IV. One service layer | ✅ | One connect service for every group, with G10 and G12 inside it. One validation path (`validateTargetContent`) with G9 inside the shared counter. One refresh path (`applyRefreshResult`) with G11 as an option. |
| V. Providers are plug-ins | ⚠️ justified | Threads is one folder plus one registry line. G9–G13 are generic framework fixes, which the spec classes as defects (FR-002). Each is optional, provider-neutral, tested with a throwaway provider and recorded with a reversal. No schema change. The ambiguous-never-retried rule is untouched: only `publish` is `mayPublish`, and recreation happens only before it. See Complexity Tracking. |
| VI. Boring, few dependencies | ✅ | No new dependency. Built-in `Intl.Segmenter` and regex Unicode properties, `fetch` and `TextEncoder`. mkcert is a developer tool, not a package. |
| VII. Secrets never leak | ✅ | Only the long-lived token is stored, AES-256-GCM with row AAD. Code and short-lived token exist only in outgoing requests. Timestamps are stored as numbers, so redaction keys only on the token. Platform messages are scrubbed. Summaries use an allow-list. The paste field is cleared and never echoed. The no-secrets integration test is extended to Threads connect, callback, paste, renewal and every advance path. Env is Zod-validated at start-up through G8 and documented in `.env.example`. |
| Eng. constraints | ✅ | `runTick` stays bounded: one request per step, `continue` + `notBefore`, no polling loops. No provider call inside a transaction. UI changes follow `docket-ui`: server page, existing client leaf components, `role="alert"` messages, keyboard-operable controls and plain-text notes. Video stays out (the step state names the media type so it can be added later, FR-005). |
| Workflow | ✅ | Conventional commits with explicit paths. Per-task targeted tests, then the full `pnpm lint && pnpm typecheck && pnpm test && pnpm build` once at the end (routes and the accounts screen change). `db:check` confirms no migration. Docs are deliverables (FR-035–FR-040). |

**Gate result: PASS.** The principle V deviation (generic framework fixes) is justified below.

### Post-design re-check (after Phase 1)

Re-evaluated against [data-model.md](./data-model.md) and [contracts/](./contracts/):

- **Duplicate safety**:
  - `publish` is the only `mayPublish` step. Lease recovery on it stays `recovered_ambiguous`.
  - A rate limit on `publish` is retryable only because a rate-limited request is not executed (same as 005).
  - Temporary codes, 5xx, resets, timeouts, unparseable replies and a missing id on `publish` are `ambiguous`.
  - `PUBLISHED` seen at `check_status` (before our publish) is `ambiguous`.
  - `EXPIRED` and the 23 h age guard recreate only before `publish`. After `publish` the result is `done`, `fatal_error` or `ambiguous`.
  - `auto_publish_text` is not used, so no create step can publish.
- **Credentials**:
  - G7 flags `needs_reauth` only when the ciphertext is unchanged, so a renewal racing a publish cannot lock out a fresh token.
  - Renewal runs under the existing refresh lease.
  - G11 parking uses the same column, so a parked account cannot be refreshed twice.
- **Limits**:
  - The engine counter enforces 250/24 h before any request (SC-006).
  - The quota step never blocks on an unknown reading.
  - A quota wait longer than 23 h recreates containers before publishing.
- **Authorization**: the G10 refusal is server-side, before any state. Paste remains `account:manage` only. Editors see no connect, paste or reconnect controls.
- **Time**: all instants are UTC (`Date`, epoch ms in credentials, ISO in step state). There is no wall-clock maths in this feature.
- **Secrets**: the `group` query parameter (G12) carries only a registered group key. Hints are static strings, so nothing from the platform is reflected.
- **Scope**: outside `src/providers/threads/` and `src/providers/meta/`, the code diff is the registry line plus the G9–G13 files listed below, `.env.example`, `.gitignore` and one `package.json` script.

**Re-check result: PASS.**

## Project Structure

### Documentation (this feature)

```text
specs/006-threads-provider/
├── plan.md              # This file
├── research.md          # Phase 0: interim R1–R10, gaps G9–G13, decisions D1–D12
├── data-model.md        # Phase 1: account, settings, credentials, candidate, step state, env
├── quickstart.md        # Phase 1: validation guide (mocked), local HTTPS walk, owner live check
├── contracts/
│   ├── threads-api.md   # outbound Threads HTTP calls and outcome classification
│   ├── providers.md     # G9/G10/G12/G13 type changes; the threads provider and connect group
│   ├── connect.md       # connect service, callback route, accounts screen (G10/G12/G13)
│   └── scheduler.md     # engine behaviour relied on; G11
├── checklists/          # from /speckit-specify
└── tasks.md             # Phase 2 (/speckit-tasks, not created here)
```

### Source Code (repository root)

```text
src/providers/
├── threads/                         # NEW (FR-001)
│   ├── index.ts                     # threadsProvider
│   ├── config.ts                    # env parse (THREADS_*), constants: authorize URL, API version, 60 d, 24 h
│   ├── capabilities.ts              # D4 + default publish limit
│   ├── text.ts                      # threadsCountingRule (D3, G9)
│   ├── validate.ts                  # validateThreads
│   ├── settings.ts                  # ThreadsSettings + accountNotes (G13)
│   ├── credentials.ts               # ThreadsCredentials schema + read helper
│   ├── oauth.ts                     # authorize URL, code / long-lived / refresh exchanges, profile read
│   ├── connect-group.ts             # threadsConnectGroup (G10 requirement, G12 hint, paste D6)
│   ├── refresh.ts                   # refreshThreads (D7)
│   ├── state.ts                     # step state schema, cadence constants, recreation cap
│   ├── steps.ts                     # threadsStepFor, validState
│   ├── quota.ts                     # readQuota (R7)
│   ├── publish.ts                   # advanceThreads
│   └── *.test.ts                    # unit tests beside each module
├── meta/
│   ├── graph.ts                     # MetaApp.version nullable; GraphRequestInput.unversioned (D2)
│   ├── errors.ts                    # scrub: + refresh_token (D2)
│   └── config.ts                    # export env helpers (D2)
├── connect.ts                       # NEW (G10): redirectUriProblem (pure)
├── types.ts                         # G9, G10, G12, G13 members
├── text.ts                          # G9: countText custom, countingRuleName, countingUnit
├── validation.ts                    # G9: unit from countingUnit
└── registry.ts                      # + threadsProvider (one line)

src/server/
├── services/connect.ts              # G10 view + start refusal; G12 groupKey on accounts outcome
├── services/accounts.ts             # G13 AccountView.notes
├── services/posts/compose.ts        # G9 countingRule name
├── scheduler/credentials.ts         # G11 holdTransient option
├── scheduler/token-refresh.ts       # G11 passes holdTransient
└── dal/accounts.ts                  # G11 RefreshPatch.refreshLeaseUntil

src/app/
├── connect/callback/route.ts        # G12 &group=<key>
└── p/[projectSlug]/accounts/
    ├── page.tsx                     # G12 hint in banner; G13 notes; reconnect only when available
    └── ConnectGroupSection.tsx      # G10 unavailable state with reason, doc and paste form

tests/
├── helpers/fake-graph.ts            # + host in the request log
├── helpers/threads-publish.ts       # NEW
├── integration/threads/             # NEW: connect, paste, refresh, publish-e2e, carousel,
│                                    #      container-status, outcomes, quota, limits
├── integration/compose/counting-rule.test.ts       # NEW (G9, throwaway provider)
├── integration/connect/redirect-requirement.test.ts # NEW (G10/G12, throwaway group)
├── integration/scheduler/token-refresh-hold.test.ts # NEW (G11)
├── integration/accounts-notes.test.ts               # NEW (G13)
└── integration/meta/no-secrets.test.ts              # extended to Threads

docs/meta-setup.md, docs/adding-a-provider.md, docs/decisions.md, README.md, .env.example,
.gitignore (+ certificates/), package.json (+ "dev:https")
```

**Structure Decision**: the existing single Next.js app. The provider is a leaf folder under `src/providers/threads/`. The shared Meta module gets only provider-neutral additions (D2). The generic fixes go where the behaviour already lives (types, shared counter, connect service, refresh helper, accounts screen), so no Threads-specific code exists outside the provider folder and the shared Meta module.

## Implementation notes for the tasks phase

1. **Order**:
   1. G9–G13 with throwaway-provider tests, each a separate commit (`feat(providers): …` / `fix(scheduler): …`);
   2. the Meta module additions, with the Facebook and Instagram suites green;
   3. Threads config, counting, validation;
   4. OAuth, connect group and paste;
   5. refresh;
   6. the step machine;
   7. the registry line;
   8. engine end-to-end tests;
   9. the no-secrets extension;
   10. docs;
   11. the final gates.
2. **G9 serialisation**: after the change, no `TargetCheck` or `ConnectGroupView` may carry a function. The compose-check route test asserts the JSON shape.
3. **G10 host test**: refuse `localhost`, `foo.localhost`, `127.0.0.1`, `[::1]`, `192.168.1.10` and any `http:` address. Accept `https://docket.local:3000` and `https://example.com`.
4. **Counting tests** include the keycap `1️⃣`, `☺` and `☺️`, decomposed `é` and the 496 + 😀 boundary (research D3 table).
5. **Polling tests** move the DB clock: +30 s, +60 s, … +5 min. They assert `next_attempt_at`, never wall time.
6. **Docs**:
   - `meta-setup.md`'s existing step 7 (mkcert fallback for Facebook) is updated to share the new "Local HTTPS for Threads" section, using port 3000 and the `dev:https` script. The anchor `#local-https-for-threads` must exist, because G10's message links to it.
   - The README section names the Website permissions removal path.
   - `adding-a-provider.md` gets §3 (custom counting rule), §4 (redirect requirement, callback hint), §9 (24 h renewal and parking) and a Threads worked example.
7. **Decisions entries** (FR-040): FR-013, G9–G13 (what/why/reverse), R1–R10 interim values, the D3 emoji reading (with the text-presentation note), the D4 readings (8,000,000 bytes; 1:10–10:1 inclusive), cadence 30 s / 60 s / 5 min, recreation cap 2 and the 23 h guard, the paste order and its network-stop refinement (D6), the estimated expiry, not using `auto_publish_text`, tokens in GET queries (D10), and "verified with mocks only" with U1/U2.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| G9: framework counting type widened (touches `types.ts`, `text.ts`, `validation.ts`, `compose.ts`) | Threads' rule (emoji by bytes, others per code point) is not one of the three built-ins, and FR-021 requires the composer count to equal the enforced count | A fourth built-in `"threads"` value would put platform code in the shared counter; a separate provider `countText` would leave `capabilities.text.countingRule` wrong for Threads |
| G10: connect-group redirect requirement (service, section, reconnect button) | Threads refuses `http://` and `localhost` callbacks; without a server-side check the login fails on Threads' page with no explanation (FR-009) | A start-up error would break every other provider on a local `http://` deployment; a Threads `if` in the connect service violates FR-002 |
| G11: scheduled refresh honours transient `retryAt` (credentials helper, token-refresh section, one RefreshPatch field) | FR-017's "retry at issue + 24 h" is otherwise ignored, so a young token would be reclaimed every tick, using refresh slots and rewriting `last_error` | A new "next refresh" column is a schema change; ignoring it leaves the defect |
| G12: static callback hint plus `group` query parameter | FR-014's tester-invite reminder cannot be shown today, because the callback keeps only a generic code | Reflecting the platform's error text through the URL risks injection and leaks; a Threads-only banner code is not generic |
| G13: optional `accountNotes` hook plus `AccountView.notes` | FR-015 requires the account to say the expiry is estimated, and the mark must clear after renewal without decrypting on the page | A new column is a schema change; decrypting credentials for display widens the secret surface; a settings write in refresh needs a `RefreshResult` change used by nobody else |
