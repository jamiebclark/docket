# Implementation Plan: Hardening for real use: failures view, limits audit, security pass, configuration and deployment

**Branch**: `010-hardening-deployment` | **Date**: 2026-10-04 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/010-hardening-deployment/spec.md`

## Summary

This entry makes Docket safe to run for real. It adds **no new platform, table or target status** and **no new dependency**. Everything reuses the existing services, engine and providers, with small generic changes logged as G14 and G15.

- **Failures view** (`/p/[slug]/failures`):
  - A read-only `services/failures.ts` lists every `ambiguous` and `failed` target. Ambiguous targets come first under "Needs your decision", then failed ones, each group newest first. Filters and page live in the URL. The full attempt log is rendered on the server in `<details>`, with identical polling runs collapsed but counted (research D5, D6).
  - The actions reuse `resolveAmbiguous` and `retryTarget` in `withLockedTarget`. `resolveAmbiguous` gains "not published + requeue", which takes the next free slot through the one allocator, `allocateNextFree`, and its unique index (D2, D3). If no slot is free it falls back to `failed`. The two new attempt outcomes are `resolved_not_published` and `requeued`.
  - External URLs must be `http` or `https` (D9). The dialogs move into one shared `TargetResolution` component, used by both the failures view and post detail (D10).
  - The nav shows a cheap ambiguous count (D7).
  - Engine pre-call failures are never ambiguous (D22, 002 F21).
- **Limits audit**:
  - `docs/limits.md` holds one table per provider and is checked against capabilities by a test (D13).
  - A table-driven enforcement test proves zero platform requests for every content limit, both before scheduling and **at publish time**. The publish-time check is new: today the tick never re-validates (research F15). The publish-time check runs on the first step through the shared `validateResolvedContent` (D11, G15).
  - The same test covers every rate limit. Bluesky gains its two approximate publish limits through `defaultPublishLimit` accepting an array (D12, G14).
- **Security pass**:
  - One same-origin guard in `proxy.ts` covers server actions, session route handlers and auth endpoints. It refuses mismatched origins and a missing `Origin` when a session cookie is present, which closes Next's missing-Origin hole (D16).
  - Security headers are split by when they can be computed. The static ones live in `next.config.ts`. The CSP nonce and HSTS are added per request in the proxy, and HSTS is sent only for https. The root layout becomes dynamic so every page carries the nonce (D17).
  - The tick endpoint gives one identical refusal for every failure case (D18).
  - A streaming bounded body reader is added (D19).
  - The address policy gains the IPv6 edge ranges, and a new `webhook` policy applies to deliveries through a lookup-guarded `postGuarded` (D20).
  - The audit guard moves into the DAL (D21).
  - An end-to-end secret scan covers logs, responses, pages, attempts, audit and webhook payloads, with a self-check (D23).
  - `docs/security.md` is the findings record (D24).
- **Configuration**:
  - One `validateConfiguration` serves the web process, the worker and **prestart before it migrates** (001 F7). It treats partly-set groups as errors, which reverses 007 change 6 for partial and malformed values.
  - Every variable read is validated, including `NODE_ENV`, `PORT` and `HOSTNAME`. Empty means unset everywhere (001 F12).
  - A static coverage test keeps code, `.env.example` and the validator in step (D25–D28).
- **Deployment**:
  - `docs/deployment.md` covers local Compose, Unraid (generic steps, with UI specifics marked unverified, U1), container host + Neon, Render free-tier facts, scheduler health, and Netlify as not supported.
  - Backup and restore commands are included (D30).
  - Compose binds to `127.0.0.1` by default (D31).
  - A bundled smoke script drives the real worker in the Compose stack (D29). The clean-checkout run is recorded with dates, or reported as not verified if Docker is unavailable (F27, U6).
- **Docs**: the README is rewritten in FR-039 order. `docs/adding-a-provider.md` is refreshed, and a test fails if a contract member is missing or if the 004 F5 contradictions return (D33, D34).

## Technical Context

**Language/Version**: TypeScript 5 (strict) on Node 24 LTS (`>=24.10 <25`).

**Primary Dependencies**: all already installed; **none added** (constitution VI).

- Next.js 16.3.8. Read `node_modules/next/dist/docs/01-app/` before touching routes, the proxy or the config (AGENTS.md). The facts used are the CSP guide (F1), build-time `headers()` (F2), the proxy's Node.js runtime (F3), Server Actions' origin rule (F4) and `proxyClientMaxBodySize` truncation (F5).
- Better Auth 1.7.7 (origin check F6, cookie flags F7).
- Drizzle ORM 0.45.3.
- Zod 4.6.5.
- `typescript` (devDependency) for the guide coverage test's AST read.
- esbuild for the new `build:smoke` bundle.
- Node built-ins: `node:http`/`node:https` `lookup`, `net.BlockList`, `node:crypto`.

**Storage**: PostgreSQL 17, one migration `0007` with three enum values and one partial index (see [data-model.md](./data-model.md) §1). No new tables or columns.

**Testing**: Vitest against real Postgres (per-worker clones). The existing helpers are used: fake PDS, Graph and LLM, webhook receiver, memory storage, DB clock. Pages are rendered with `renderToStaticMarkup(await Page(...))`. Route handlers and `proxy()` are called directly with `Request` and `NextRequest`. The new suites are:

- `tests/integration/{failures,limits,security}`;
- `tests/integration/docs/{limits-inventory,provider-guide,security-findings}.test.ts`;
- `tests/lint/env-coverage.test.ts`;
- `scheduler/pre-call-failures.test.ts`.

**No live network calls.** The quickstart maps every scenario to a test.

**Target Platform**: the existing `node:24-slim` image and Docker Compose (web, worker, postgres, plus the opt-in offline profile), or a container host with Neon. The worker and smoke bundles must not import `next/*` (existing lint test).

**Project Type**: the single Next.js app (`src/app`, `src/components`, `src/server`, `src/providers`, `src/lib`), plus `scripts/` and `docs/`.

**Performance Goals**:

- The failures page costs 3 queries plus counts: rows, attempts for the visible rows, and actor names. It uses the new partial index.
- The nav badge is one `count(*)` per project page (FR-005).
- The CSP and same-origin checks are pure string work in the proxy.
- Publish-time validation is one pure call per first step.

**Constraints**:

- `runTick()` stays bounded, concurrent-safe and kill-safe.
- No network call happens inside a held transaction. The requeue allocation runs inside the resolution transaction, as `addToQueue` does today, with no network involved.
- No advisory locks.
- Lock order is unchanged: post, then targets, then the occurrence index.
- Secrets never appear in output (contracts/http-security.md §6).
- Every role (owner, admin, editor) has `post:schedule` today (`src/server/auth/access.ts`), so "a member without the schedule right" exists only as a scope with a stubbed `can()` in tests. Non-members and API-key scopes are tested for real.

**Scale/Scope**:

- Self-hosted personal and team use.
- Failures lists are paginated at 25 rows, so hundreds of failures are fine.
- **Out of scope**: new platforms, video, analytics, billing, Netlify, CI jobs for Compose, and MINOR review items not named in the spec.

**NEEDS CLARIFICATION**: none. Every unknown is resolved in [research.md](./research.md) or recorded as NEEDS RESEARCH (U1–U6) with the behaviour the spec prescribes.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Pre-research | Post-design | How the design complies |
|---|---|---|---|
| I. Verified facts over memory | PASS | PASS | Next, Better Auth and Node facts were read from installed docs and source, and probed in this phase (research F1–F9, F27). Limits come only from `docs/research/` (F16). Unknowns are recorded as U1–U6: Unraid UI, the Facebook limit, approximate Bluesky figures, caption-level limits, a live browser CSP check, and Docker availability. Nothing is invented. |
| II. Nothing "working" unless it ran | PASS | PASS | Every behaviour has a mocked-HTTP or local test (quickstart §1–§5). The Compose run, backup and restore, and the browser CSP check are recorded with dates or as "not verified" (FR-037, U5, U6). Live platforms stay owed by the owner. |
| III. Isolation in one place | PASS | PASS | The new reads (`listAttention`, `countAttention`, `listForTargets`) are scoped DAL methods covered by the scope-check test. The failures route and actions go through `forProject` and `runAction`. Non-members get not-found everywhere (FR-006). |
| IV. One service layer | PASS | PASS | Resolutions stay in `services/posts`, shared by both screens. Requeue uses the one allocator (`allocateNextFree`). Publish-time validation shares `validateResolvedContent` with the scheduling gate. One `validateConfiguration` serves all three entry points. |
| V. Providers are plug-ins | PASS | PASS | Provider folders change only to declare limits (the Bluesky array) and to fix one doc comment. The engine's new checks are generic. G14 and G15 are logged as generic changes. |
| VI. Boring, few dependencies | PASS | PASS | No runtime or dev dependency is added. Undici is avoided (D20) and so is a browser driver (D29). |
| VII. Secrets never leak | PASS | PASS | The end-to-end scan includes a self-check (D23). The tick refusals are identical (D18). The audit guard sits in the repository (D21). Webhook destinations are checked. Env errors are printed without values. `.env.example` is checked for real-looking secrets. |
| Engineering: Compose and Neon, direct URL for migrations | PASS | PASS | Deployment docs cover both. `directUrlOf` gives one empty-means-unset reading. Prestart validates before it migrates. |
| Engineering: tick bounded, `SKIP LOCKED` + lease, no provider call in a held transaction | PASS | PASS | The publish-time check is pure and runs before credentials are read. Pre-call classification changes only the recorded outcome. |
| Engineering: accessibility and `docket-ui` | PASS | PASS | contracts/ui.md: real table markup, rowgroup headers, native `<details>`, labelled filter form, `Dialog` focus handling, live-region results and four states. |
| Workflow: tests per quality bar ("ambiguous never retried automatically", "slot double-booking", "membership roles") | PASS | PASS | 20× parallel requeue repeated (SC-003). Retry only by a human. Pre-call failures are tested. Authorization rows are added. |

**Result**: no violations, so Complexity Tracking is empty. Two judgement calls go against today's behaviour, and both are spec decisions logged in `docs/decisions.md`:

- startup now exits on partly-set or malformed LLM configuration (reversing 007 change 6 for those cases);
- the tick endpoint answers 401 instead of 404 when no secret is configured.

## Project Structure

### Documentation (this feature)

```text
specs/010-hardening-deployment/
├── plan.md              # This file
├── research.md          # Phase 0: facts F1–F28, decisions D1–D34, NEEDS RESEARCH U1–U6
├── data-model.md        # Phase 1: migration 0007, transitions, read models, validation, doc entities
├── quickstart.md        # Phase 1: runnable validation guide mapped to tests
├── contracts/
│   ├── services.md      # failures service, resolve/retry, validation core, engine, webhooks, safe-fetch, audit, config, smoke
│   ├── ui.md            # failures route, nav, TargetResolution, actions, post detail, a11y tests
│   ├── http-security.md # same-origin guard, headers/CSP, tick, body limits, outbound policies, secrets, cookies
│   └── docs-and-config.md # .env.example, Compose, deployment.md, limits.md, security.md, README, provider guide, decisions
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks; not created here)
```

### Source Code (repository root)

```text
drizzle/0007_*.sql (+ meta)                           # 3 enum values, post_targets_attention_idx
src/server/db/schema/{attempts,webhooks,posts}.ts     # enum values, index

src/server/dal/{targets,attempts,audit}.ts            # listAttention, countAttention, listForTargets; audit guard in insert
src/server/services/failures.ts (+ test)              # listFailures, countNeedsDecision, previewRequeue, groupAttemptRuns (new)
src/server/services/posts/{index,view,validate}.ts    # resolveAmbiguous union + requeue, retryBlockedReason, view actions/attemptCount, validateResolvedContent
src/server/services/audit.ts                          # delegates to the repo guard
src/server/services/accounts.ts                       # looseness warning over providerPublishLimits
src/server/services/webhooks/{deliver,endpoints}.ts   # postGuarded with "webhook" policy, save-time destination check, test overrides
src/server/net/safe-fetch.ts (+ test)                 # ranges, mapped/compat IPv4, "webhook" policy, postGuarded
src/server/http/body.ts (+ test)                      # readBodyWithin (new)
src/server/api/handle.ts                              # uses readBodyWithin
src/server/scheduler/{publishing,limits,http}.ts      # publish-time validation, pre-call classification, limits array, one tick refusal
src/server/env.ts (+ test)                            # NODE_ENV/PORT/HOSTNAME, ENV_VARIABLES, directUrlOf
src/server/llm/config.ts (+ test)                     # llmEnvIssues, LLM_VARIABLES
src/server/config-registry.ts                         # INTERNAL_VARIABLES, COMPOSE_ONLY_VARIABLES (new)
src/server/startup/{index,validate}.ts (+ tests)      # validateConfiguration (new), runStartup uses it
src/worker.ts                                         # validateConfiguration
scripts/prestart.mjs                                  # validate before migrate
scripts/smoke.ts                                      # Compose smoke (new), bundled by build:smoke
package.json                                          # build:smoke; build:prestart --external:sharp

src/providers/types.ts                                # defaultPublishLimit: PublishLimit | readonly PublishLimit[] (G14)
src/providers/limits.ts (+ test)                      # providerPublishLimits (new)
src/providers/bluesky/{index,settings}.ts             # two approximate limits; BlobRef comment fix

src/lib/validation/{scheduling,api}.ts                # externalUrlSchema; webhook URL literal/localhost refusal
src/lib/safe-redirect.ts (+ test)                     # safeExternalHref
src/lib/http/{same-origin,security-headers}.ts (+ tests)   # pure guard and header builders (new)
src/proxy.ts                                          # same-origin guard, CSP nonce, HSTS
next.config.ts                                        # static security headers (signup rule last)
src/app/layout.tsx                                    # async, await connection()

src/app/p/[projectSlug]/failures/{page,loading}.tsx   # failures view (new)
src/app/p/[projectSlug]/layout.tsx                    # countNeedsDecision → LeftNav
src/app/p/[projectSlug]/posts/actions.ts              # resolveTargetAction union, previewRequeueAction
src/app/p/[projectSlug]/posts/[postId]/page.tsx       # attempts count, Who column, safe link, TargetResolution
src/app/p/[projectSlug]/compose/check/route.ts        # bounded body
src/components/targets/TargetResolution.tsx           # shared dialogs (moved from posts/[postId]/TargetActions.tsx)
src/components/shell/LeftNav.tsx                      # Failures entry + count

tests/integration/failures/{list,attempts,resolve,requeue,concurrency,retry,authz,nav}.test.ts, ui.test.tsx
tests/integration/posts/{resolve-url,detail-resolution}.test.ts(x)
tests/integration/limits/enforcement.test.ts
tests/integration/security/{secret-scan,csrf,headers,body-limit,cookies}.test.ts
tests/integration/scheduler/pre-call-failures.test.ts
tests/integration/webhooks/destination.test.ts
tests/integration/tick-endpoint.test.ts               # extended
tests/integration/docs/{limits-inventory,provider-guide,security-findings}.test.ts
tests/lint/env-coverage.test.ts
tests/startup/prestart.test.ts                        # validate-before-migrate
tests/integration/actions-authz.test.ts               # new action rows

docker-compose.yml, .env.example                      # 127.0.0.1 bind, mock pass-through, groups and markers
docs/{deployment,limits,security}.md (new); README.md, docs/adding-a-provider.md, docs/decisions.md (010 section)
```

**Structure Decision**: same single Next.js app as entries 001–009. New code goes next to its kind: services in `src/server/services`, pure HTTP helpers in `src/lib/http`, server-only HTTP in `src/server/http`, and shared client UI in `src/components`. The only new route folder is `failures/`.

## Suggested build order (for /speckit-tasks)

1. **Foundations.** Migration 0007, the DAL reads, `externalUrlSchema`, `validateResolvedContent`, and `providerPublishLimits` (G14). These unblock everything else.
2. **US1 failures (P1).** The service, the `resolveAmbiguous` union with requeue, `retryBlockedReason`, `TargetResolution`, the route, nav, and post detail. Then the pre-call failure classification.
3. **US2 limits (P1).** Publish-time validation (G15), Bluesky limits, the enforcement test, and `docs/limits.md` with its doc test.
4. **US3 security (P1).**
   - same-origin guard;
   - headers and nonce;
   - tick refusal;
   - body reader;
   - address policies and webhook `postGuarded`;
   - audit guard;
   - secret scan;
   - `docs/security.md`.
5. **US4 config (P2).** `validateConfiguration`, the three entry points, the variable registry, the coverage test, `.env.example`, and the `||` fixes.
6. **US5 deployment (P2).** The smoke script and `build:smoke`, Compose edits, `docs/deployment.md`, then the clean-checkout run and backup/restore, or a recorded "not verified".
7. **US6 docs (P3).** The README, the provider guide and its test, and the `docs/decisions.md` 010 section.
8. **Final gate.** Quickstart §8, once.

## Complexity Tracking

> No constitution violations; nothing to justify.
