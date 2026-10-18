# Implementation Plan: Persist what a platform granted, then read Instagram, Facebook Page and Threads numbers

**Branch**: `081-insights-reconnect-and-meta` | **Date**: 2026-10-17 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/081-insights-reconnect-and-meta/spec.md`

## Summary

080 built the whole insights spine and proved it on the one platform that needs no permission. Every
other platform needs one, and Docket cannot currently answer the question that decides whether a
reader may run: **what did this account actually grant?** So this entry is two halves, strictly in
order.

**First, persist the grant.** A nullable `granted_scopes` text array on `social_accounts`, written at
connect and at every refresh that reports one, from **what the platform said** and never from what
Docket asked for (**G31**). An `optionalScopes` declaration on the connect group, requested only under
a per-group operator flag that defaults to **off** (**G32**). A `requiredScopes` declaration on the
provider's insights declaration, turned into a per-account SQL predicate inside the claim queries, so
an unpermissioned account is never claimed, never leased, never decrypted and never called (**G33**).
And an honest account state — *"Insights need a reconnect"* — carrying the per-provider reason and a
docs link, through the same `{ reason, docsPath }` convention 077 and 080 already use.

**Then the three readers**, on the Graph transport the publish path already uses: Instagram under
`instagram_manage_insights`, Facebook Pages under `read_insights`, Threads under
`threads_manage_insights`. Plus the two platform specifics the generic schedule gets wrong — a
provider declares which post types **expire** and how long they live, and the pure schedule freezes at
that boundary with a new terminal reason (**G34**); and Meta's call limit is **impressions-based**, so
the budget reads Meta's own `X-Business-Use-Case-Usage` header rather than a number Docket invented.

The safety property that governs everything: **an install that never reconnects keeps working exactly
as it does today.** No new scope requested, no call attempted, no account state that blocks
publishing, no error anywhere. Insights are simply absent, with a reason a person can act on.

### The research changed the Facebook half, and that is the headline

The roadmap ordered the research first, and it was right to. Done ([research.md](./research.md)):

- **Instagram is CONFIRMED** — endpoint, the exact seven post metrics the roadmap listed, three
  account metrics, the 48-hour processing delay, the 24-hour story window, and (with an official
  citation and a date) that `impressions` now **errors** rather than being merely absent.
- **Facebook's metric names in the roadmap and in FR-030 are deprecated.** `post_impressions`,
  `page_impressions` and `page_fans` were removed on **2025-11-15** — eleven months ago — and now
  return an invalid-metric error, which fails **the whole call**, not just that metric. Their
  documented replacements (`post_media_view` / `page_media_view`) are themselves flagged for
  deprecation in v25.0 with a viewer metric planned for June 2026, and which one answers on the v26.0
  Docket runs could not be confirmed. So Facebook ships with the two metrics on **no** deprecation
  list — reactions broken out by type, and clicks — plus Page engagements and `page_follows`, and the
  whole views family is a parked, one-minute live check. Constitution I and FR-005 say the research
  wins; this is the entry's recorded disagreement with the brief.
- **Threads' permission and endpoints are confirmed; its metric enum is not.** Five metric names are
  corroborated by independent third-party integration guides but not captured from the official page,
  so under FR-003 they are not declared yet. Threads is the entry's clean test of FR-003: if the
  official enum cannot be read, its module ships **declared `unavailable`** with a reason naming the
  gap — a working, honest outcome, at the cost of one small file.

One consequence worth stating before anyone writes a chart: after this entry **three platforms label
a metric "Views" and mean three different events.** The roadmap's "never sum across platforms" rule
stops being a principle and becomes the thing standing between the panel and three incomparable
numbers with the same name. 080 already made it structural (no metric-key constant outside a provider
folder); this entry only has to not break it — and to fix FR-034's test, which should assert the
*keys* are provider-local, not that the *labels* are unique, because they no longer are.

### What this entry delivers, and what it does not

| Story | In this entry | Why |
|---|---|---|
| US1 (an install that does nothing is unchanged) | **Yes** | The safety property; provable with no credentials |
| US2 (the grant is recorded, reconnect loses nothing) | **Yes** | Mostly an existing property of `upsertConnected` to pin with tests |
| US3 (opt in, reconnect, numbers arrive) | **Yes**, with mocked HTTP | Only the live consent screen is parked (§"Task ordering") |
| US4 (three vocabularies, never added) | **Yes** | Instagram fully; Facebook reduced to its non-deprecated metrics; Threads per FR-003 |
| US5 (a story is read, then frozen) | **Yes** | Pure schedule + the `mock` fixture; no Instagram needed |
| US6 (Meta's own limit, publishing first) | **Yes** | Needs one real change to the shared Graph transport |
| US7 (the operator can see what happened) | **Yes** | Four new counts, one new companion query |
| Facebook's views/impressions/reach family | **No** — parked as R2 | Deprecated names error; the live replacement is unconfirmable from here |
| Threads account metrics | **No** — `account: []` | The `user_insights` enum is not the profile fields; R4 |
| TikTok, Pinterest, X insights | **No** | Entry 3 — though their granted scopes **are** recorded here |
| Any chart, trend, comparison, API or MCP surface | **No** | Entry 4; `OPERATIONS` untouched |

The asymmetry to state plainly: **this entry opens the permission machinery for three platforms and
delivers a full metric vocabulary for one of them.** That is what the research permits today, it is
what FR-003 demands, and the machinery is the part entries 3 and 4 need. A Facebook reader built on
`post_impressions` would have shipped broken, silently, on every install.

## Technical Context

**Language/Version**: TypeScript strict, Node 24 LTS, pnpm (no change)

**Primary Dependencies**: Next.js 16 (App Router, standalone), Drizzle ORM
(`drizzle-orm/node-postgres`), Zod 4, Better Auth, Vitest. **No new runtime dependency and no new
infrastructure.** Everything reuses `graphRequest`/`graphList` (`src/providers/meta/graph.ts`), the
Graph error table and `scrub` (`src/providers/meta/errors.ts`), the existing Threads request layer,
`ReconnectGroupButton`, `redact`, `nextRetryAt`, `writeHeartbeat`, `markInvalidEmitting`,
`stricterBudget`/`reserveFloor`/`windowStart`, and 080's whole insights spine.

**Storage**: Postgres via Drizzle. **One** migration: a nullable `granted_scopes text[]` on
`social_accounts` with a per-element CHECK and a GIN index, plus a widened
`post_metric_poll_states_frozen_reason_enum` CHECK (`settled`, `gone`, **`expired`**,
**`unqueryable`**). **No new table, no new enum type, no change to any snapshot table, no back-fill.**

**Testing**: Vitest. Unit tests for the pure parts (`normalizeGrantedScopes`,
`insightsPermissionFor`, `postPollDecision`, `parseUsageHeader`, the panel decision table);
integration tests against real Postgres (port **5555** locally) for the eligibility matrix, reconnect
preservation, the claim's exclusion, the ephemeral freeze, the counts and the rendered panel; provider
tests with **mocked HTTP only** (constitution II). 080's existing insights suite must pass
**untouched** — if it needs an edit, something here is wrong.

**Target Platform**: Self-hosted Docker Compose (web, worker, postgres) and Neon with only the
connection string changed; migrations on the direct URL; no session-level Postgres features.

**Project Type**: Web application — Next.js App Router monolith with a worker running the same
`runTick()`.

**Performance Goals**: `runTick()` unchanged — insights keeps its 0.3 time share and its per-run
caps. The claim gains one `OR`-of-`AND`s predicate over an indexed column and one companion `COUNT`.
The post detail page gains **no** query: one more column on a row already read, plus one pure call
per target. An Instagram story costs at most **23** reads over its 24 hours (15-minute floor) instead
of 080's 32 over 28 days.

**Constraints**: no provider call inside a held transaction; `FOR UPDATE SKIP LOCKED` on the
poll-state rows only; a publish is never deferred by a poll (FR-047); `src/providers/**` imports
nothing from `src/server/**`; the DAL imports nothing from the provider registry (the scheduler
passes provider rules down); no secret on any insights path (FR-015); no API, MCP or OpenAPI surface,
so `OPERATIONS` is untouched and the enumerated-surface tests need no edit.

**Scale/Scope**: one column, one widened CHECK, one migration; four generic hooks (G31–G34); four new
env variables, all per-group/per-provider and all defaulting to off or conservative; three provider
insights modules; four new tick counts and one companion query; four new panel states and one new
accounts-page line; two new pure library functions and one new pure module.

## Constitution Check

*GATE: passed before Phase 0; re-checked after Phase 1 — see "Post-design re-check".*

| Principle | How this design satisfies it | Status |
|---|---|---|
| **I. Verified facts over memory (NON-NEGOTIABLE)** | The roadmap ordered the research first and it was done before any design: [research.md](./research.md) §1–§3 carries a source URL and a check date per surface and a confidence word per row. **FR-003 is applied strictly** — only a CONFIRMED row is declared or requested — which is why Facebook's deprecated names are refused (§2) and Threads' uncorroborated enum is not declared (§3). Six `NEEDS RESEARCH` rows stay open, each published as unverified with a stated fallback, and **no requirement, default or test depends on an unanswered one** (§7). The method's own limit (search summaries, not page text) is recorded, as `docs/research/meta.md` already does for its 2026-10-07 section | PASS |
| **II. Nothing is "working" unless it ran** | Every behaviour is provable with mocked HTTP and the `mock` fixture; all three readers are reported **"verified with mocks only"** until the parked live checks run (quickstart §11). No provider test makes a live call | PASS |
| **III. Project isolation in one place** | No new table, so no new `project_id` to get wrong. `granted_scopes` lives on an already-scoped table. The two claims and the one new companion count are cross-project by nature and each is wrapped in `crossProject(reason, …)` exactly as their siblings are. Every UI read goes through the scoped DAL | PASS |
| **IV. One service layer, many callers** | **One** permission decision (`insightsPermissionFor`) for the panel and the accounts page, mirrored in SQL for the claim and **pinned to it by an integration matrix test** (research §6) — the SQL cannot call the function, so a test is the only available guarantee, and it is the most valuable test in the entry. **One** write boundary (`normalizeGrantedScopes`) with exactly two callers, asserted. `checkInsightsAllowance`, `nextRetryAt`, `redact`, `writeHeartbeat`, `markInvalidEmitting` and `ReconnectGroupButton` are reused, not reimplemented | PASS |
| **V. Providers are plug-ins** | Everything platform-specific is **declared**, not coded into a generic layer: `requiredScopes` and `missingScopes` (G33), `ephemeralPostTypes` (G34), `optionalScopes` on the group (G32). The scheduler learns nothing about Instagram — a later platform with a 7-day ephemeral type needs no scheduler change. The DAL receives provider *rules* as data and never imports the registry. Facebook's video-id rule lives in Facebook's folder, which is why `targetsUnqueryable` is counted from a read result and not from SQL | PASS |
| **VI. Boring, few dependencies** | No package, no queue, no Redis, no advisory lock, no `LISTEN`, no second deployable, no new table, no new enum type, no new tick section, no cross-tick usage store. The `frozen_reason` text CHECK widens with one `DROP`/`ADD` — which is exactly why 080 chose a CHECK over a pg enum | PASS |
| **VII. Secrets never leak** | `granted_scopes` is guarded in three independent places: whole-list rejection at the write boundary (a reply containing one token-shaped string stores **nothing**, not a filtered list), a database CHECK whose character class and 64-character cap reject every credential shape Docket's providers produce, and the secret scan — which already serialises every `social_accounts` row minus its ciphertext, so the column is covered by construction. The usage header is reduced to **two clamped integers** at the parse boundary, so FR-048 holds by construction rather than by remembering to scrub | PASS |
| **Engineering constraints** | `runTick()` bounded, concurrent-safe, kill-safe, unchanged in shape; UTC storage with "as of" rendered in the project's zone; `docket-ui` skill for the panel and the accounts line; server components; keyboard reachable; labelled controls | PASS |
| **Out-of-scope list** | The constitution's scope sentence names 080 for metric capture; FR-055 extends it to name this entry in a `docs(constitution):` commit with a version bump, rather than letting it be silently contradicted. Charts, trends and comparisons stay out | PASS (by amendment) |

No violation needs justifying, so Complexity Tracking stays empty. Six choices that *look* like new
mechanism are argued rather than waved through: the joined-string CHECK (data-model §1), whole-list
rejection over per-element filtering (data-model §2), provider rules passed into the DAL (research
§6), a new `postPollDecision` beside an unchanged `nextPostPollAt` (provider-insights §4), two
integers out of the usage header (meta-usage §1), and `targetsUnqueryable` counted from a read rather
than from SQL (scheduler-insights §2).

## Architecture

### The one question, answered in two places that must agree

```text
  CONNECT / REFRESH                        the platform's own answer
        │
        ▼  normalizeGrantedScopes()        whole-list rejection; one boundary, two callers
        ▼
  social_accounts.granted_scopes           NULL = unknown · {} = granted nothing · text[]
        │
        ├──────────────────────────► SQL, inside the claim (G33)
        │                              granted_scopes @> requiredScopes
        │                              ⇒ never claimed, leased, decrypted or called
        │
        └──────────────────────────► insightsPermissionFor() (pure)
                                       ⇒ the panel's state and the accounts-page line
                                           ▲
      pinned together by tests/integration/insights/eligibility-matrix.test.ts
```

The two expressions cannot share code — SQL cannot call a TypeScript function — so **the matrix test
is the contract between them**. If they drift, Docket shows "numbers are coming" for an account it
never calls, which is precisely the invisible failure 080's visibility work exists to prevent.

### Three layers of budget, and which one actually bites

```text
1. per-account reserve      checkInsightsAllowance, UNCHANGED      ← bites when an operator set a
                                                                     per-account publish limit
2. declared readBudget      48 000 / 24 h                          ← binds NOTHING on its own
                                                                     (research §4 — written down,
                                                                      not discovered in review)
3. X-Business-Use-Case-Usage on every response                     ← the real protection against an
   ≥ ceiling ⇒ rate_limited, retryAt from Meta's own estimate        impressions-based limit
```

Layer 3 needs the entry's only change to shared publishing code: `send()` in
`src/providers/meta/graph.ts` discards `res.headers` today, so `GraphOutcome` gains an optional
`usage?: UsageSignal` carrying **two clamped integers and nothing else**. Optional on every arm, so
every existing caller and every existing Graph test is unaffected, and the publish path gets the
field for free and ignores it — changing what publishing does with a throttle signal is explicitly
out of this entry's scope.

### The freeze gains two reasons, and both clear the failure counters

```text
frozen_reason ∈ ('settled', 'gone', 'expired', 'unqueryable')
                              └─ 080 ─┘   └──── this entry ────┘
```

Both new reasons are **terminal and not failures**. The existing
`post_metric_poll_states_frozen_has_no_next` CHECK forces `next_poll_at IS NULL` alongside
`frozen_at`, and the claim requires `next_poll_at IS NOT NULL`, so a target frozen either way is
invisible to the claim whatever a later caller forgets — 080's "freeze in two expressions at once",
inherited free. The subtlety worth stating: the panel's decision table tests
`consecutiveFailures > 0` **before** the freeze reasons, so freezing must also clear
`consecutive_failures`, `failing_since` and `last_error`. Without that, a target that failed once
before being recognised as expired or unqueryable renders as a permanent failure that nothing will
ever retry.

### Where the work runs

`runTick()` is unchanged in shape. The insights section keeps its place, its 0.3 time share, its
locking and its heartbeat; it gains an eligibility argument, four counts and one companion query.

## Project Structure

### Documentation (this feature)

```text
specs/081-insights-reconnect-and-meta/
├── spec.md
├── plan.md                                  # this file
├── research.md                              # Phase 0 — §1…§8, with sources and six open rows
├── data-model.md                            # Phase 1 — the column, the CHECKs, the claim, config
├── quickstart.md                            # Phase 1 — how to prove each requirement, §1…§11
├── contracts/                               # Phase 1
│   ├── granted-scopes.md                    #   G31, G32, and insightsPermissionFor
│   ├── provider-insights-081.md             #   the three readers, G34, the ephemeral schedule
│   ├── meta-usage.md                        #   X-Business-Use-Case-Usage, end to end
│   ├── scheduler-insights-081.md            #   what changes in runInsightsPoll
│   └── panel-and-accounts.md                #   four new panel states, one accounts-page line
├── checklists/
└── tasks.md                                 # Phase 2, by /speckit-tasks — NOT by this phase
```

### Source Code (repository root) — new and touched

```text
src/
├── lib/
│   ├── granted-scopes.ts                    NEW normalizeGrantedScopes + pattern/bounds (FR-009)
│   └── insights/
│       ├── eligibility.ts                   NEW insightsPermissionFor — the one decision (G33)
│       ├── schedule.ts                      + postPollDecision; nextPostPollAt UNCHANGED (G34)
│       └── panel.ts                         + four states, two insertion points (FR-025, FR-042)
├── providers/
│   ├── types.ts                             + grantedScopes on ConnectCandidate and RefreshResult
│   │                                          (G31); optionalScopes on OAuthConnectGroup (G32);
│   │                                          requiredScopes/missingScopes/ephemeralPostTypes on
│   │                                          InsightsDeclaration (G33, G34); `unqueryable` entry
│   ├── registry.ts                          + five assertInsightsDeclaration rules (data-model §6)
│   ├── meta/
│   │   ├── graph.ts                         + usage?: UsageSignal on every response arm
│   │   ├── usage.ts                         NEW parseUsageHeader — two clamped integers
│   │   ├── config.ts                        + insightsScopes, usage ceiling
│   │   ├── oauth.ts                         + optional scopes in dialogUrl (non-config-id path only)
│   │   ├── connect-group.ts                 + optionalScopes with requested() and cannotWiden()
│   │   └── candidates.ts                    + the flat scopes list from the existing /debug_token
│   ├── instagram/insights.ts                NEW 7 post keys, 3 account keys, story 24 h, prohibitions
│   ├── facebook/insights.ts                 NEW reactions-by-type + clicks; video-id → unqueryable
│   ├── threads/
│   │   ├── insights.ts                      NEW per FR-003: the five keys, or declared unavailable
│   │   ├── config.ts                        + insightsScopes, usage ceiling
│   │   ├── connect-group.ts                 + optionalScopes; + threads_manage_insights when on
│   │   └── oauth.ts                         + grantedScopes from the already-parsed grantedList
│   ├── x/connect-group.ts                   + grantedScopes from the already-parsed scopes
│   ├── tiktok/connect-group.ts              + grantedScopes from the already-parsed scopes
│   ├── pinterest/…                          + grantedScopes if the token reply carries one (R6)
│   ├── {facebook,instagram,threads}/index.ts  + insights: …
│   └── mock/{insights.ts,settings.ts}       + four scripting fields (provider-insights §6)
├── server/
│   ├── db/schema/accounts.ts                + grantedScopes, its CHECK, its GIN index
│   ├── db/schema/insights.ts                frozen_reason CHECK widened to four values
│   ├── dal/accounts.ts                      upsertConnected + recordRefresh write the column
│   ├── dal/insights-claims.ts               InsightsProviderRule; the eligibility predicate;
│   │                                          the lazy insert can be born frozen;
│   │                                          + countAccountsMissingInsightsScopes
│   ├── scheduler/credentials.ts             applyRefreshResult writes it only when reported (FR-011)
│   ├── scheduler/insights-poll.ts           + rules, four counts, the unqueryable arm,
│   │                                          the expired freeze, the `unavailable` loop fix
│   ├── services/accounts.ts                 + insightsPermission on AccountView
│   └── services/posts/view.ts               + grantedScopes on the target read, + one pure call
├── components/targets/PerformancePanel.tsx  + four states (panel-and-accounts §2)
└── app/p/[projectSlug]/accounts/page.tsx    + the "Insights need a reconnect" line (FR-026)

drizzle/00XX_*.sql                           ONE migration, by pnpm db:generate (FR-006, FR-040)
tests/                                       see quickstart.md §2–§10
docs/
├── research/meta.md                         + six metric tables with sources; §Q6 CORRECTED (§5.1)
├── insights.md                              + platforms, permissions, reconnect, story expiry, gaps
├── adding-a-provider.md                     + G31…G34 in the Generic hooks index
├── decisions.md                             + every decision in spec.md and plan.md, each reversible
├── meta-setup.md                            + the permissions, the flag, Login for Business
├── limits.md                                + three insights read budget rows, each with its note
└── feature-map.md                           + what shipped and what no entry owns
.specify/memory/constitution.md              scope sentence extended to name 081 (FR-055)
.env.example                                 + four variables with ranges and defaults
```

**Structure Decision**: the existing single-app layout is kept. This entry adds **no** top-level
directory, **no** route, **no** deployable and **no** table — one column, two pure modules, one
parser, three provider insights modules, and additions to files that already exist.

## Phase 0 — research

See [research.md](./research.md). It closes the spec's `NEEDS RESEARCH` #1, #2 and #3 with official
sources (§1–§3), overturns the roadmap's Facebook metric names (§2), records how little the declared
budget floor contributes (§4), corrects three statements the spec makes about code — including that
**FR-046's Graph codes 80001/80002 are already landed and tested** (§5) — designs the eligibility
predicate and names its drift risk (§6), lists the six still-open rows with their fallbacks (§7), and
resolves every unknown the Technical Context could have marked (§8).

Every `NEEDS CLARIFICATION` is resolved. Six `NEEDS RESEARCH` rows remain open; each is published as
unverified, each has a stated fallback, and none is depended upon.

## Phase 1 — design

- [data-model.md](./data-model.md) — the column with its joined-string CHECK and GIN index; the write
  boundary and its two callers; the widened `frozen_reason`; the claim's new signature and
  eligibility predicate; the lazy insert that can be born frozen; the companion count; all four
  config variables; and every type change in one place.
- [contracts/granted-scopes.md](./contracts/granted-scopes.md) — G31 per provider (four of six
  already parse the list and discard it); the `/debug_token` decision for Meta; G32 with
  `requested()` and `cannotWiden()`; and `insightsPermissionFor`'s five-row ordered table, including
  why row 3 must precede row 4.
- [contracts/provider-insights-081.md](./contracts/provider-insights-081.md) — the three readers'
  declarations and prohibition lists; Facebook's unqueryable-id rule; Threads' two possible shapes
  under FR-003; G34 and `postPollDecision`; the shared result mapping; and `mock`'s new scripting.
- [contracts/meta-usage.md](./contracts/meta-usage.md) — the parser, the transport change, how a
  reader uses the signal (including why a capped-out 200's numbers are still committed), and what is
  deliberately not built.
- [contracts/scheduler-insights-081.md](./contracts/scheduler-insights-081.md) — the four section
  changes, the counts and why two of them need their own query or their own read; the freeze arms;
  and the latent `unavailable` loop this entry makes reachable and fixes.
- [contracts/panel-and-accounts.md](./contracts/panel-and-accounts.md) — four new panel states with
  their insertion points and ordering reasons; what each renders; the accounts-page line's three
  rules; and where the panel's permission comes from without a new query.
- [quickstart.md](./quickstart.md) — how to prove each requirement, ending with the parked human
  checks.

## Post-design re-check

The design adds no dependency, no infrastructure, no table, no enum type, no tick section and no
second implementation of budget maths, backoff, redaction or the heartbeat. Seven points were
re-examined after it settled; each is a judgement call for `docs/decisions.md` with its reversal.

1. **Facebook ships a smaller vocabulary than the roadmap asked for.** Its two headline metrics are
   deprecated names that now error, and the replacement cannot be confirmed from here (research §2).
   Declaring one anyway would have lost `post_clicks` too, because an invalid metric fails the whole
   call. Reversal: answer R2 in Graph API Explorer and add one line to `facebook/insights.ts`.
2. **`optionalScopes` is on the group and `requiredScopes` on the provider** — the spec's recorded
   divergence from the roadmap, confirmed by the code: `authorizationUrl` is built by the group, and
   the Meta group backs two providers with different needs from a single consent.
3. **Whole-list rejection, not per-element filtering.** Filtering would keep the good entries from a
   reply Docket evidently misunderstood, and could leave an account *eligible* on the strength of a
   list that also contained a secret. Rejecting leaves `NULL`, which reads as "needs a reconnect" —
   honest and recoverable. The connect still succeeds: a grant Docket cannot record is not a reason
   to refuse a working connection.
4. **A new `postPollDecision` beside an unchanged `nextPostPollAt`.** FR-043 requires 080's schedule
   tests to pass untouched, and the cheapest guarantee is not to edit the function they test. The
   caller needs a *reason*, not only a date, so the wrapper returns a discriminated result.
5. **`targetsUnqueryable` is counted from a read result, not from SQL.** Telling a Page post id from
   a Reel's video id is Facebook's knowledge; a `LIKE` in the generic claim would teach the DAL one
   platform's id format, which constitution V forbids. The cost is one claim per such target, once,
   before it is frozen terminally.
6. **The declared Meta read budget binds nothing on its own, and this is written down** (research
   §4). 48 000 calls in 24 hours is three orders of magnitude above anything the section does; the
   protection is the account's own publish limit via `stricterBudget`, plus the live header. A
   smaller invented number would be a fiction with the same shape, so the honest move is the note in
   `docs/limits.md` and here.
7. **Two pre-existing defects are fixed in passing, both made reachable by this entry.** The
   per-read `unavailable` arm never advances `next_poll_at`, so it would re-claim every tick forever
   (scheduler-insights §4); and a target frozen after an earlier failure would render as a permanent
   failure, because the panel checks `consecutiveFailures` before the freeze reasons. Both were
   unreachable in 080 and both become live here, so both belong to this entry rather than a later
   one.

Three things the design deliberately does **not** fix, recorded so review does not re-open them:
`fatal_error` retries for 28 days rather than stopping (research §5.3 — visible and actionable, and a
fifth result kind is entry 4's business); the Facebook `ANALYZE`-task precondition is invisible to
`granted_scopes`, so eligibility answers "may Docket call?" and never "will Docket get numbers?"
(research §2 — an empty answer correctly renders as 080's `nothing_reported`); and repairing
Facebook's stored external id for Reel targets, which no entry owns.

## Task ordering note for Phase 2

The roadmap's rule — park every task needing a live consent screen, a real platform account or a
browser at the **very end** — bites harder here than in any previous entry, because the headline user
journey *is* a consent screen. The parked list is quickstart §11; **nothing above it depends on
anything in it.**

The one exception runs the other way: **FR-001's research must come before the readers**, and it is
already done. Phase 0 did it, so the implement phase's first task is transcribing
[research.md](./research.md) §1–§3 into `docs/research/meta.md` with its confidence words — and
nothing else in the entry needs the web.

A reasonable phase order for `/speckit-tasks`:

1. **`docs/research/meta.md`** — the six metric tables from research §1–§3 with sources and check
   dates, plus the §Q6 correction (research §5.1). First, because FR-001 gates every reader and
   because SC-009 is verified by inspecting declarations against these tables.
2. **The pure library** — `lib/granted-scopes.ts`, `lib/insights/eligibility.ts`,
   `postPollDecision`, `meta/usage.ts`, with their unit tests. No database, no provider, nothing to
   mock.
3. **The contract** — `providers/types.ts` (G31–G34), the registry assertions, and `mock`'s four
   scripting fields, so everything downstream has a fixture.
4. **The schema and the migration** — the column, its CHECK, its GIN index, the widened
   `frozen_reason`; `pnpm db:generate`, `pnpm db:check`.
5. **The write boundary** — `upsertConnected`, `applyRefreshResult`, and each OAuth provider's
   contribution; the reconnect-preservation and per-provider tests (quickstart §3, §4).
6. **Eligibility** — the claim's new signature and predicate, the born-frozen lazy insert, the
   companion count, and **the matrix test** (quickstart §5).
7. **The section** — the four counts, the unqueryable and expired arms, the `unavailable` loop fix,
   with the tick, concurrency, allowance and counts tests.
8. **The three readers**, mocked HTTP only, in the order Instagram → Facebook → Threads: Instagram is
   the one with a confirmed vocabulary, so it proves the shape the other two reuse.
9. **The transport** — `graph.ts`'s usage field and the ceiling path, with the budget tests.
10. **The UI** — the panel's four states, `getPostView`, the accounts-page line, the four-platform
    rendering test, and the extended secret scan.
11. **Every doc**, the `.env.example` block, and the constitution amendment with its version bump.
12. **Last**: the parked live checks of quickstart §11 — the two consent screens, R1–R4, the real
    accounts, and the browser walk-through.

Steps 1–11 are reachable with no platform credentials and no browser.

## Complexity Tracking

*No constitution violation requires justification.*
