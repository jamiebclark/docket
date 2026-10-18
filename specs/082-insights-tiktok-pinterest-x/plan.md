# Implementation Plan: TikTok and Pinterest numbers, and a priced opt-in for X

**Branch**: `082-insights-tiktok-pinterest-x` | **Date**: 2026-10-18 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/082-insights-tiktok-pinterest-x/spec.md`

## Summary

080 built the insights spine; 081 built the permission machinery. This entry finishes the
platforms, and it is **one repair, three readers and three generic hooks**, in that order.

**The repair comes first, because nothing else can work.** TikTok's published post is addressed by
a video id. What Docket stores in `post_targets.external_id` is the `publish_id` — an upload
receipt (`src/providers/tiktok/publish.ts:439`). The real id *is* read one line earlier and thrown
into an attempt row. Those rows are **never pruned** — `publish_attempts` has no retention anywhere
(housekeeping prunes allowance uses, standing-series runs, settled occurrences, orphan credit holds,
engagement items and metric snapshots, and `src/server/dal/attempts.ts` only inserts and selects);
an attempt disappears only by cascade when its post target or project is deleted, and a deleted
target has no insights to show. So the backfill reaches every historical publish whose status fetch
returned ids, and "unrecoverable" is a genuine edge case — a publish that never reached the status
fetch, or one predating `publicPostIds` being written at all — not an unknown fraction. So: a nullable
`post_targets.public_post_id` column, a write-forward through the generic publish result (**G36**),
a backfill from `publish_attempts.response_summary.publicPostIds` inside the same migration, and —
for the targets where the id is gone or was never issued — an honest frozen state rather than a
poll against an id TikTok will reject.

**Three generic hooks, because three platforms break three different generic assumptions.**

- **G35 — a declared identifier source.** A provider says which stored id its post reader needs:
  the target's `external_id` (everyone today) or its `public_post_id` (TikTok). The post claim
  requires that column to be non-null *in its own SQL*, so a target without one is never claimed,
  never leased and never decrypted for; the lazy insert freezes it `unqueryable` with no call spent.
- **G36 — a public post id on the publish result.** `{ kind: "done" }` may carry
  `publicPostId` beside the `externalId` and `url` it already carries, and the generic publish path
  persists it. No scheduler or engine code names TikTok.
- **G37 — per-surface eligibility.** A provider declares its post-read scopes and its account-read
  scopes **separately**, and the two claims each check their own set in SQL. Pinterest needs
  `pins:read` for pins and nothing new for the account; TikTok needs `video.list` for posts and
  `user.info.stats` for the account. A surface a provider declares no metrics for is not claimed at
  all, which is also how X's account surface stays silent.

**Then the readers.** TikTok `POST /v2/video/query/` (20 ids per call, four counts) and
`GET /v2/user/info/` (three counts). Pinterest `GET /v5/pins/{pin_id}/analytics` (four
`summary_metrics` counts, a 90-day-clamped window) and `GET /v5/user_account` — whose scope every
connected Pinterest account **already granted**, so Pinterest account history starts accruing the
moment this ships, with no reconnect and no flag. X `GET /2/tweets?ids=…&tweet.fields=public_metrics`
(100 ids per call, six public metrics), built, tested and **switched off**.

### The research changed two things

Done in full: [research.md](./research.md). Both corrections matter.

1. **Impressions are a *public* X metric.** `public_metrics.impression_count` is in the public
   family, needs no `non_public_metrics` request and carries no 30-day availability limit
   (research §3). FR-044 forbids `non_public_metrics`, which Docket never requests — so impressions
   ship, and the spec's parked billing question 2 narrows to a set nothing depends on.
2. **Pinterest's analytics window has a documented 90-day clamp** — `start_date` no more than 90
   days back, `end_date` no more than 90 days past `start_date` (research §2). That closes the
   spec's one open design question with a confirmed number rather than a guess.

One thing the research refused: **X's account numbers.** `GET /2/users/me`'s price is UNVERIFIED in
`docs/research/x.md:26`, and a user read may be a $0.010 standard read rather than a $0.001 owned
one. FR-043 forbids spending the operator's money on an unverified rate, so X declares
`account: []` and its account reader returns `unavailable` naming that reason — the posture 081 took
for Threads. It is the entry's second recorded refusal to guess.

### The honesty fix the spec asked for and 081 could not give it

FR-050 says a surface that reports itself unavailable **at run time** must reach the post panel. It
does not today: an `unavailable` read result sets `last_error` and backs off, but the panel's
`failing` state keys off `consecutive_failures > 0`, which `unavailable` deliberately does not
bump — so a member sees an indefinite *"not read yet"* for a surface Docket already knows it cannot
read. This is the state the X opt-in-off case and the Pinterest 403 both land in, so the entry
cannot ship without fixing it: two nullable columns (`unavailable_reason`, `unavailable_docs_path`)
on each poll-state table, written by the generic commit, cleared by any successful read, and read by
`buildTargetInsightsView` ahead of `not_polled_yet`. **No new provider hook** — the provider already
returns `{ kind: "unavailable", reason, docsPath }`; the generic layer merely stops throwing it
away. So it gets no G number, and `docs/adding-a-provider.md` records it as a change to how an
existing hook's output is used.

### What this entry delivers, and what it does not

| Story | In this entry | Why |
|---|---|---|
| US1 (TikTok has a queryable identifier) | **Yes** — column, G36 write-forward, in-migration backfill, honest frozen state | Nothing else can be built or tested without it |
| US2 (TikTok numbers on the post) | **Yes**, mocked HTTP | Every fact CONFIRMED (research §1) |
| US3 (Pinterest, account half with no reconnect) | **Yes** — account immediately, pins behind `pins:read` | G37 is what makes the split expressible |
| US4 (X available, priced, off) | **Yes** — reader built, opt-in default off, ceiling enforced through the existing reserve | |
| US5 (three setup guides) | **Yes** | |
| US6 (grant stays current at refresh) | **Yes** — TikTok and Pinterest refresh replies already parse `scope`; they just discard it | Two one-line changes plus tests |
| X account numbers | **No** — `account: []` | Price UNVERIFIED (FR-043) |
| Pinterest `SAVE_RATE`, `VIDEO_*`, `lifetime_metrics` | **No** | Derived, or NEEDS RESEARCH (research §2) |
| A `gone` state distinct from `unqueryable` for TikTok | **No** — one `unqueryable` reason naming both | Indistinguishable in the response (research §6.1) |
| Charts, trends, API, MCP, account screens | **No** | Entry 4 |

## Technical Context

**Language/Version**: TypeScript strict, Node 24 LTS, pnpm (no change)

**Primary Dependencies**: Next.js 16 (App Router, standalone), Drizzle ORM
(`drizzle-orm/node-postgres`), Zod 4, Better Auth, Vitest. **No new runtime dependency and no new
infrastructure.** Each reader uses the transport its own provider folder already owns —
`tiktokRequest` + `inspect` (`src/providers/tiktok/http.ts`), `pinterestRequest` +
`readPinterestMessage` (`src/providers/pinterest/http.ts`), `xRequest` + `readRate` + `problemText`
(`src/providers/x/http.ts`) — plus 080/081's spine: `checkInsightsAllowance`, `stricterBudget`,
`reserveFloor`, `nextRetryAt`, `redact`/`secretValues`, `writeHeartbeat`, `markInvalidEmitting`,
`insightsPermissionFor`, `postPollDecision`, `buildTargetInsightsView`, `PerformancePanel`,
`ReconnectGroupButton`.

**Storage**: Postgres via Drizzle. **One** migration, generated by `pnpm db:generate`, carrying:

1. `post_targets.public_post_id text` — nullable, with a length CHECK (1-64 characters) so an
   absurd or malformed value cannot be stored (FR-009);
2. `post_metric_poll_states.unavailable_reason text` + `.unavailable_docs_path text`, and the same
   pair on `account_metric_poll_states` — nullable, length-CHECKed, with a pair CHECK
   (`docs_path IS NULL OR reason IS NOT NULL`) (FR-050);
3. a **backfill** `UPDATE` inside the same migration file, filling `public_post_id` for TikTok
   targets from the most recent `publish_attempts.response_summary->'publicPostIds'->>0` that
   exists, skipping rows that already have one and rejecting values outside the CHECK.

No new table, no new enum type, no change to either snapshot table, no change to any existing
CHECK. `post_targets.external_id` keeps holding the publish id (FR-006).

**Testing**: Vitest. Unit tests for every pure part (`pinterestAnalyticsWindow`,
`plausiblePublicPostId`, the three readers' body-to-metrics mappers, the extended panel decision
table, the per-surface rule builder); integration tests against real Postgres (**port 5555**
locally) for the backfill, the two claims' per-surface SQL, the batching call shapes, the ceiling
deferral, the counts and the rendered three-platform panel; provider tests with **mocked HTTP
only** (constitution II) covering page / gone-or-unqueryable / rate-limited / credentials-invalid /
unavailable / fatal for each reader. 080's and 081's insights suites must pass **with no edit
except where a requirement here names one** — the three expected edits are the panel decision
table (one new state in the ordering), `insights-poll`'s counts (three new fields) and
`InsightsProviderRule` (the per-surface split).

**Target Platform**: Self-hosted Docker Compose (web, worker, postgres) and Neon with only the
connection string changed; migrations on the direct URL; no session-level Postgres features.

**Project Type**: Web application — Next.js App Router monolith with a worker running the same
`runTick()`.

**Performance Goals**: `runTick()` unchanged — insights keeps its 0.3 time share and its per-run
caps. The post claim gains one `IS NOT NULL` predicate on a column of a row it already joins; the
account claim gains one `OR`-of-`AND`s over the same indexed `granted_scopes` 081 added. TikTok at
20 ids per call and X at 100 both *reduce* calls per tick against 080's page size of 25. The post
detail page gains **no query**: two more columns on rows it already reads. The migration's backfill
is one `UPDATE … FROM (SELECT DISTINCT ON …)` over `publish_attempts`, bounded by the retained
attempt history.

**Constraints**: no provider call inside a held transaction; `FOR UPDATE SKIP LOCKED` on the
poll-state rows only; a publish is never deferred by a poll; `src/providers/**` imports nothing
from `src/server/**`; the DAL imports nothing from the provider registry (the scheduler passes
rules down); **no generic layer branches on a provider key**; no secret on any insights path; no
API, MCP or OpenAPI surface, so `OPERATIONS` is untouched and the enumerated-surface tests need no
edit.

**Scale/Scope**: one migration (one column, four columns, one backfill); three generic hooks
(G35-G37) plus one non-hook honesty fix; **four** new environment variables; three provider insights
modules; three new tick counts; two refresh-path changes; three setup guides plus four other docs
files; one new pure library function and one extended one.

## Constitution Check

*GATE: passed before Phase 0; re-checked after Phase 1 — see "Post-design re-check".*

| Principle | How this design satisfies it | Status |
|---|---|---|
| **I. Verified facts over memory (NON-NEGOTIABLE)** | The spec ordered research first (FR-001-FR-003) and it was done before any design: [research.md](./research.md) carries a source URL, a check date and a confidence word per row. **FR-004 is applied strictly** — which is why Pinterest's `VIDEO_*` and `lifetime_metrics` keys are not declared (§2), X's account surface is not built (§3), and nine open questions (R1-R9) ship as unverified with a stated fallback each. **No requirement, default, test or declared metric depends on an unanswered row** (§7). The method's own limit — search summaries, not page text — is recorded, as `docs/research/meta.md` and 081 both already do | PASS |
| **II. Nothing is "working" unless it ran** | Every behaviour is provable with mocked HTTP and the `mock` fixture, including the three run-time `unavailable` paths and the ceiling deferral. All three readers are reported **"verified with mocks only"** until the parked live checks run (quickstart §9). No provider test makes a live call | PASS |
| **III. Project isolation is enforced in one place** | No new table, so no new `project_id` to get wrong. `public_post_id` lives on the already-scoped `post_targets`; the four reason columns live on already-scoped poll-state tables. The two claims and the companion counts are cross-project by nature and each stays wrapped in `crossProject(reason, …)`. Every UI read goes through the scoped DAL; the panel's new fields arrive on rows `src/server/services/posts/view.ts` already reads | PASS |
| **IV. One service layer, many callers** | **One** eligibility decision per surface (`insightsPermissionFor`, called with the post set or the account set) for the panel, the accounts page and — mirrored in SQL — the two claims, **pinned to each other by the extended `tests/integration/insights/eligibility-matrix.test.ts`**: the SQL cannot call the function, so that test is the only available guarantee and it is the most valuable test in the entry. **One** ceiling (the existing reserve; no second enforcement path). **One** window function for Pinterest's dates. **One** write boundary for the public post id (the generic `stepOutcome` patch), with TikTok's provider code never touching the database | PASS |
| **V. Providers are plug-ins** | Every platform specific arrives as a **declaration value or a provider-owned function**: `postIdSource` (G35), `publicPostId` on the done result (G36), `postScopes`/`accountScopes` (G37), `maxPostsPerRead` (20 / 100 / 1), `readBudget`, the metric key lists, the window function, the error mappers. The scheduler learns nothing about TikTok, Pinterest or X — a later platform needing a second identifier or a per-surface scope split needs no scheduler change. `src/providers/**` still imports nothing from `src/server/**` | PASS |
| **VI. Boring, few dependencies** | No new runtime dependency, no new infrastructure, no new table, no npm install. The X ceiling reuses `stricterBudget`/`reserveFloor` rather than adding a spend ledger — the spec's own assumption, and why this entry adds no new enforcement path. Four new env variables, all defaulting to off or to the conservative value | PASS |
| **VII. Secrets never leak** | Tokens stay inside the provider modules; every error string goes through that provider's own scrubber and then `redact(…, secretValues(credentials))` in the generic commit. The new `public_post_id` is a platform id, length-capped, and `tests/integration/security/secret-scan.test.ts` is extended to cover it, the two reason columns and all three providers' snapshot payloads and error strings — **nothing exempted** (FR-013, FR-054) | PASS |

**No violations, so [Complexity Tracking](#complexity-tracking) stays empty.** The judgement call
worth stating up front is that the FR-050 honesty fix adds four columns the spec did not enumerate.
The alternative — inferring "unavailable" from a non-null `last_error` with zero failures — would
collide with the `unqueryable` freeze, which deliberately writes exactly that shape. Four nullable
columns in a migration this entry is already shipping is the cheaper and clearer option, and it is
recorded in `docs/decisions.md`.

## Project Structure

### Documentation (this feature)

```text
specs/082-insights-tiktok-pinterest-x/
├── plan.md                       # This file
├── research.md                   # Phase 0: FR-001-FR-003 answered, R1-R9 left open
├── data-model.md                 # Phase 1: the one column, the four columns, the backfill
├── quickstart.md                 # Phase 1: how to prove each story without credentials
├── contracts/
│   ├── provider-insights-082.md  # G35, G36, G37 and the run-time-unavailable persistence
│   ├── public-post-id.md         # The TikTok identifier repair, end to end
│   ├── platform-readers-082.md   # The three readers: request, response, error mapping
│   └── x-metered-reads.md        # The opt-in, the ceiling, the arithmetic, the words
├── checklists/                   # Pre-existing
├── spec.md
└── tasks.md                      # Phase 2 (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
src/
├── providers/
│   ├── types.ts                      # G35/G36/G37: InsightsDeclaration + StepResult "done"
│   ├── tiktok/
│   │   ├── insights.ts  (new)        # /v2/video/query/ + /v2/user/info/
│   │   ├── insights.test.ts (new)
│   │   ├── config.ts                 # TIKTOK_INSIGHTS_SCOPES
│   │   ├── connect-group.ts          # optionalScopes (G32) for video.list + user.info.stats
│   │   ├── publish.ts                # one line: publicPostId on the done result
│   │   ├── refresh.ts                # FR-056: forward the reply's scopes
│   │   └── index.ts                  # register insights
│   ├── pinterest/
│   │   ├── insights.ts  (new)        # /v5/pins/{id}/analytics + /v5/user_account
│   │   ├── window.ts    (new)        # the pure 90-day-clamped date window
│   │   ├── insights.test.ts, window.test.ts (new)
│   │   ├── config.ts                 # PINTEREST_INSIGHTS_SCOPES
│   │   ├── oauth.ts                  # PINTEREST_SCOPES untouched; optional scope added at the group
│   │   ├── connect-group.ts          # optionalScopes (G32) for pins:read
│   │   ├── refresh.ts                # FR-056
│   │   └── index.ts
│   ├── x/
│   │   ├── insights.ts  (new)        # GET /2/tweets?ids=…&tweet.fields=public_metrics
│   │   ├── insights.test.ts (new)
│   │   ├── config.ts                 # X_INSIGHTS_ENABLED, X_INSIGHTS_READ_CEILING
│   │   └── index.ts
│   └── mock/
│       ├── insights.ts, settings.ts  # FR-052: script every new shape
│       └── insights.test.ts
├── lib/insights/
│   ├── panel.ts                      # the run-time unavailable state, the carried reason
│   └── eligibility.ts                # unchanged signature, called once per surface
├── server/
│   ├── db/schema/{posts,insights}.ts # the five columns and their CHECKs
│   ├── dal/insights-claims.ts        # G35 + G37 in both claims and both companion counts
│   ├── scheduler/{insights-poll,record,publishing}.ts
│   └── services/{accounts,posts/view}.ts
└── components/targets/PerformancePanel.tsx

drizzle/0044_*.sql                    # the single migration, backfill included

tests/integration/
├── insights/                         # eligibility-matrix, panel, four-platform (all extended)
│   ├── public-post-id.test.ts (new)  # the column, the backfill, the frozen state
│   ├── batching.test.ts     (new)    # 25 TikTok targets -> 20 + 5
│   └── x-ceiling.test.ts    (new)    # deferral at the ceiling, publish unaffected
├── security/secret-scan.test.ts
├── docs/{tiktok,pinterest,x}-docs.test.ts, limits-inventory.test.ts
└── {tiktok,pinterest,x}/no-secrets.test.ts
# the pure parts are unit-tested beside their source: src/providers/<key>/*.test.ts, src/lib/insights/*.test.ts

docs/
├── tiktok-setup.md, pinterest-setup.md, x-setup.md
├── insights.md, limits.md, adding-a-provider.md, decisions.md, feature-map.md
└── research/{tiktok,pinterest,x}.md  # FR-001-FR-003
```

**Structure Decision**: unchanged from 080/081 — the existing single Next.js application. Every new
file sits in the provider folder that owns it (constitution V), the two generic files that must
change are `src/providers/types.ts` and `src/server/dal/insights-claims.ts`, and no new directory
is created.

## The four new environment variables

| Variable | Type / default | What it does |
|---|---|---|
| `TIKTOK_INSIGHTS_SCOPES` | `true`/`false`, **default false** | Adds `video.list` and `user.info.stats` to TikTok's authorization dialog (G32). Off: the dialog is byte-for-byte what it is today (FR-019) |
| `PINTEREST_INSIGHTS_SCOPES` | `true`/`false`, **default false** | Adds `pins:read` to Pinterest's dialog. Off: the dialog is unchanged, and account numbers still accrue because they need no new scope (FR-027, FR-028) |
| `X_INSIGHTS_ENABLED` | `true`/`false`, **default false** | The priced opt-in. Off: X's insights declaration is `unavailable`, no X account or target is claimed, nothing is spent (FR-036, FR-037). It gates a *reader*, not a scope request, because X needs no new scope |
| `X_INSIGHTS_READ_CEILING` | integer 100-1 000 000, **default 8000** | Nominal reads per account per 30-day window. The reserve keeps half for publishing, so the **realised** ceiling is 4,000 reads = **$4.00 per account per cycle** at $0.001 (research §4). Both figures go in `docs/x-setup.md` (FR-039, FR-041) |

Each is parsed in its own provider's `parse*Env` (pure, reads only `source`), surfaces as a
`ProviderEnvIssue` naming the variable and **never its value** (FR-062), and appears in
`.env.example` with its default and the same wording.

## Implementation order

The dependency order is forced: the identifier before the reader that needs it, the generic hook
before the provider that declares it.

| # | Phase | Why it is here | Gate |
|---|---|---|---|
| 1 | Research into `docs/research/{tiktok,pinterest,x}.md` | FR-001-FR-003 forbid a reader before its facts land in the research file, with source URLs and dates | The three files carry every row of [research.md](./research.md) §1-§3 |
| 2 | The migration and the generic plumbing: five columns, their CHECKs, the backfill, `pnpm db:check` | US1 and FR-050 both need it, and every later phase reads it | `pnpm db:check` green; backfill idempotent on a second run |
| 3 | G36 — `publicPostId` on `{ kind: "done" }`, persisted by `stepOutcome` | TikTok's write-forward, with no provider key in generic code | 080/081 publish tests untouched and green |
| 4 | G35 — `postIdSource` in the declaration, in both the claim's SQL and the lazy insert's freeze | A target with no public post id is never claimed (FR-015) | Eligibility matrix extended and green |
| 5 | G37 — `postScopes`/`accountScopes`, both claims, both companion counts, the accounts page line | Pinterest's split and TikTok's two scopes (FR-017) | Eligibility matrix covers the four quadrants |
| 6 | FR-050 — persist and render a run-time `unavailable` | Both X-off and Pinterest-403 depend on it | Panel decision table test |
| 7 | TikTok: `TIKTOK_INSIGHTS_SCOPES`, `optionalScopes`, reader, declaration, tests | US2 | 25 targets → calls of 20 and 5, one account per call |
| 8 | Pinterest: window function, `PINTEREST_INSIGHTS_SCOPES`, both readers, the 403 sentinel, tests | US3 | Account snapshot with no reconnect; pins gated |
| 9 | X: `X_INSIGHTS_ENABLED`, `X_INSIGHTS_READ_CEILING`, reader, the ceiling, tests | US4 | Off → zero calls; on → deferral at the ceiling |
| 10 | FR-056 — forward the refresh reply's scopes on both providers | US6; both replies already parse `scope` and discard it | Narrowed grant moves the surface to needs-a-reconnect |
| 11 | Counts, `mock` scripting, secret scan, `no-secrets` tests | FR-052-FR-054, SC-008 | Nothing exempted |
| 12 | Docs: three setup guides, `insights.md`, `limits.md`, `adding-a-provider.md`, `decisions.md`, `feature-map.md`, `.env.example` | US5, FR-058-FR-064 | Docs link check green in CI |
| 13 | Final pass: `pnpm lint && pnpm typecheck && pnpm test`, `pnpm db:check`, `pnpm build` | FR-065, SC-012 | All green |
| **14** | **The five parked human tasks, last** | Each needs a live consent screen, a real account or a funded key. A judgement task earlier starves the implement loop (roadmap rule; `speckit-human-task-deadlock`) | Recorded in `docs/research/*` when answered |

Phases 7, 8 and 9 are independent of each other and depend only on 2-6; 10 is independent of all of
them. Phase 14 blocks nothing: R1-R9 each ship with a declared fallback (research §7).

## Post-design re-check (after Phase 1)

Re-run against the finished [data-model.md](./data-model.md) and the four contracts.

| Principle | Did the design drift? | Status |
|---|---|---|
| I. Verified facts | No. Every declared key, cap, rate and window in the contracts traces to a CONFIRMED row in research §1-§3. The four Pinterest keys, the three TikTok account keys and the six X keys are exactly the CONFIRMED sets, with nothing added during design | PASS |
| II. Nothing works unless it ran | No. [quickstart.md](./quickstart.md) gives a runnable scenario per story, all with mocked HTTP or the `mock` provider, plus the explicit "verified with mocks only" wording for the three readers | PASS |
| III. Project isolation | No. The design added four columns on two already-scoped tables and nothing else; both claims stay `crossProject`-wrapped | PASS |
| IV. One service layer | Watch item, resolved: the per-surface split could have become *two* eligibility functions. It did not — `insightsPermissionFor` keeps one signature and is called twice with different scope sets, and the SQL mirrors it once per claim. The matrix test now covers 4 quadrants × 3 grant states | PASS |
| V. Providers are plug-ins | No. Design review found one near-miss: Pinterest's `PINNER_DATA_ACCESS_DENIED` sentinel is a **string** match, which the publishing path forbids ("status only, never a numeric code"). It lives in `src/providers/pinterest/insights.ts` only, matches a documented message token rather than a numeric code, and is recorded in `docs/decisions.md` — no generic layer ever sees it | PASS |
| VI. Boring | No. The X ceiling still has no ledger; the only storage added is five nullable columns | PASS |
| VII. Secrets | No. The contracts put every error string through the provider's scrubber *before* the generic `redact`, and the new columns are in the secret scan | PASS |

**Three recorded deviations from the spec, each with its reason:**

1. **A deleted TikTok video freezes `unqueryable`, not `gone`** (spec edge case 1). The response
   omits ids it will not answer for and sends no per-id error, so "deleted" and "not a video id"
   are indistinguishable without the target's capture history — a generic change this entry is not
   chartered to make. One reason names both possibilities; the panel shows it; the last snapshot is
   kept either way. Research §6.1.
2. **X declares `impression_count`** (spec FR-044 reads as if impressions require
   `non_public_metrics`). They do not: `impression_count` is a *public* metric. FR-044 is obeyed
   exactly as written — `non_public_metrics` is never requested. Research §3.
3. **X ships with `account: []`** rather than a reader (spec FR-043 permits this explicitly, and
   the research triggers it: `GET /2/users/me`'s price is UNVERIFIED).

## Complexity Tracking

> No Constitution Check violations, so this table is intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |

## Requirement coverage

Where each functional requirement is designed. Every row points at an artifact section, not at a
promise; `/speckit-tasks` turns these into tasks.

| FR | Designed in |
|---|---|
| FR-001 … FR-004 | [research.md](./research.md) §1-§3 (the facts) and §7 (R1-R9, each with its declared fallback) |
| FR-005, FR-006, FR-009 | [data-model.md](./data-model.md) §1 |
| FR-007, **FR-016** | [contracts/public-post-id.md](./contracts/public-post-id.md) §3 and [contracts/provider-insights-082.md](./contracts/provider-insights-082.md) §3 — **G36**, one line in `stepOutcome`, no provider key |
| FR-008, FR-063 | [data-model.md](./data-model.md) §3 (the statement, its five guards, `pnpm db:check`) |
| FR-010, FR-012, FR-014 | [contracts/public-post-id.md](./contracts/public-post-id.md) §2, §5 |
| FR-011 | [contracts/public-post-id.md](./contracts/public-post-id.md) §3 — no publish precondition |
| FR-013, FR-054 | [contracts/public-post-id.md](./contracts/public-post-id.md) §6; [quickstart](./quickstart.md) §8 — nothing exempted |
| FR-015 | [contracts/provider-insights-082.md](./contracts/provider-insights-082.md) §2 — **G35**, all three enforcement points |
| FR-017 | [contracts/provider-insights-082.md](./contracts/provider-insights-082.md) §4 — **G37** |
| **FR-018** | Unchanged guarantees, re-asserted by the **existing** tests: `src/providers/**` imports nothing from `src/server/**` (the provider-seam test, `tests/integration/insights/provider-seam.test.ts`), and no generic layer branches on a provider key — every platform specific in this entry is a declaration value (`postIdSource`, `postScopes`, `accountScopes`, `maxPostsPerRead`, `readBudget`, the key lists) or a provider-owned function. The migration names no provider either ([contracts/public-post-id.md](./contracts/public-post-id.md) §4) |
| FR-019 … FR-026 | [contracts/platform-readers-082.md](./contracts/platform-readers-082.md) §1; the flag in ["four new environment variables"](#the-four-new-environment-variables) |
| FR-027 … FR-035 | [contracts/platform-readers-082.md](./contracts/platform-readers-082.md) §2 |
| FR-036 … FR-046 | [contracts/x-metered-reads.md](./contracts/x-metered-reads.md) §1-§5; the reader in [platform-readers-082.md](./contracts/platform-readers-082.md) §3 |
| FR-047 | [data-model.md](./data-model.md) §8 — one block per platform, keys provider-local, no constant leaves a provider folder |
| **FR-048** | Unchanged from 080: every reading is an append-only `insertIfAbsent` into `post_metric_snapshots` / `account_metric_snapshots` through the scoped DAL, which exposes no update; every rendered number carries its `capturedAt` ([data-model.md](./data-model.md) §7, and the panel's `Rows` already prints "As of"). This entry adds rows, not a write path |
| FR-049 | [contracts/x-metered-reads.md](./contracts/x-metered-reads.md) §3 — the reserve, unchanged |
| FR-050 | [contracts/provider-insights-082.md](./contracts/provider-insights-082.md) §5; [data-model.md](./data-model.md) §2 |
| FR-051, FR-052 | [contracts/platform-readers-082.md](./contracts/platform-readers-082.md) §4; [contracts/provider-insights-082.md](./contracts/provider-insights-082.md) §6 |
| FR-053 | [data-model.md](./data-model.md) §4 "The companion counts" — `targetsSkippedNoPublicPostId` (new), `deferredForAllowance` (existing, now also the X ceiling), `accountsSkippedNoPermission` (now per-surface) |
| FR-055 | [contracts/platform-readers-082.md](./contracts/platform-readers-082.md) §2 (the single intended exception: Pinterest account snapshots); [quickstart](./quickstart.md) §2, §4 — assert zero calls, not merely zero rows |
| FR-056, **FR-057** | [quickstart](./quickstart.md) §6. Both providers' `tokensFrom` already parses `scope` (`src/providers/tiktok/oauth.ts:69`, `src/providers/pinterest/oauth.ts:91`); `refreshTikTok`/`refreshPinterest` just drop it. The fix is to forward it as `grantedScopes` on the `RefreshResult` **only when the reply carried one** — `scopes` is already `string[] \| null`, and `grantedScopes` being absent is already defined by G31 as "leave the stored grant unchanged", so FR-057 needs no new rule, only the test |
| FR-058, **FR-059**, **FR-060**, **FR-061**, FR-062, FR-064 | ["Implementation order"](#implementation-order) phase 12, with: `docs/x-setup.md`'s content enumerated in [contracts/x-metered-reads.md](./contracts/x-metered-reads.md) §4; **FR-059** `docs/insights.md` gaining TikTok/Pinterest/X rows in the supported-platforms table and R1-R9 plus the unrecoverable TikTok ids in the named-gaps section; **FR-060** `docs/adding-a-provider.md` gaining G35/G36/G37 in the hooks index and §21 prose, with one `docs/decisions.md` entry and reversal each (plus one for the FR-050 columns, the Pinterest message-token exception and the X ceiling default); **FR-061** `docs/limits.md` gaining the three read-budget rows of [research.md](./research.md) §5 and X's platform cap, with `tests/integration/docs/limits-inventory.test.ts` green |
| FR-065 | ["Implementation order"](#implementation-order) phase 13; [quickstart](./quickstart.md) §8 |
