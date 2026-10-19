# Implementation Plan: Confirm the Meta comment facts, and gate the inbox on the permission they need

**Branch**: `084-meta-engagement-facts-and-scope-gate` | **Date**: 2026-10-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/084-meta-engagement-facts-and-scope-gate/spec.md`

## Summary

Two halves, one merge, no comment read anywhere.

**Half one is a documentation pass with an evidence grade.** `docs/research/engagement.md` §2 is a 7×3
grid of `unverified` closed by a note saying the live task it waited on (077 T083/T084) is
unachievable headless. It is replaced by 9 questions × 4 surfaces — Facebook Page comments, Instagram
comments, Threads replies, Threads **mentions** — each cell carrying an answer, an official-domain
source URL, a check date and **how it was checked**. The last of those is this plan's one addition to
the spec's shape, and it exists because of a fact established while planning: **this harness has
`WebSearch` but no `WebFetch`** (verified — see [research.md](./research.md) §1). A search result
quoting `developers.facebook.com` is better evidence than memory and worse evidence than the page
itself, and constitution I does not let that difference go unrecorded. So every §2 cell states
`evidence: page | search-summary`, and [contracts/research-section-2.md](./contracts/research-section-2.md)
makes `search-summary` admissible only when the quoted text names the endpoint, permission or field
verbatim. Anything weaker stays `unverified` with what was tried (FR-005) — an outcome the entry
ships in.

**Half two is G40, which is one hook asked from two sides.** `EngagementDeclaration` gains
`readScopes`/`missingReadScopes` (G37's shape in engagement's vocabulary), and
`optionalScopes.cannotWiden` gains a surface argument. They ship as one numbered change because an
install that opts into engagement alone must be told about the login-configuration trap, and today
`cannotWiden` can only answer for insights (spec Constraint 6).

### The three things this plan decides that the spec left to design

1. **The pure decision moves; it is not copied.** 081's `insightsPermissionFor` already encodes the
   whole truth table (required vs granted, `NULL` vs empty, requested vs not, `cannotWiden` vs
   reconnectable). It becomes `scopePermissionFor` in `src/lib/scope-permission.ts`, with
   `src/lib/insights/eligibility.ts` re-exporting `insightsPermissionFor` and `InsightsPermission` as
   aliases. Its one production caller and both integration tests that import it keep compiling with
   their imports untouched, and FR-023's "exactly one pure implementation" is true by there being
   nothing else to call (constitution IV). Zero behaviour change is asserted by those tests passing
   unedited; only the unit test moves, carrying its assertions verbatim.
2. **The SQL predicate moves too, for the same reason.** `eligible()` inside
   `src/server/dal/insights-claims.ts` is the only SQL in the repo that says "this account holds every
   declared scope". Its two halves — holds-all and missing-any — are extracted to
   `src/server/dal/scope-predicates.ts` and called by both claims. FR-023 asks for a test that fails
   if the pure decision and the claim's query disagree; with one SQL builder and one pure function
   that test pins two functions rather than four, and a drift between insights and engagement becomes
   impossible rather than merely tested for.
3. **The surface argument is a generic word, not a platform one.** `cannotWiden(source, surface)`
   takes `ScopeSurface = "insights" | "engagement"` — the names of Docket's own read surfaces, which
   every connect group already knows about through `optionalScopes`. `requested(source)` stays a
   **union** and gains no argument: `insightsPermissionForAccount` deliberately passes everything the
   dialog will carry (`src/server/services/accounts.ts:66-69`), and narrowing it per surface would
   reintroduce the "not requested" bug that comment records. The enlargement is harmless because the
   scope sets are disjoint — asserted, not assumed, by FR-033's matrix.

### What this entry delivers, and what it does not

Delivers: §2 rewritten with four surfaces and an evidence grade; the Phase 9 note rewritten rather
than deleted; G40's two halves; one shared pure decision and one shared SQL predicate; the claim
gated in **both** its lazy insert and its select; `accountsSkippedNoPermission` on the engagement-read
counts; `META_ENGAGEMENT_SCOPES` and `THREADS_ENGAGEMENT_SCOPES`, both default off; the inbox notice
and filter; the accounts-page line; mock scripting; six documentation files and one `docs/decisions.md`
entry.

Does not: add an `engagement` member to Facebook, Instagram or Threads; read a comment; declare or
request a reply scope; touch the schema, any migration, any publishing path, any retention path, or
the insights permission state of any account. **No migration is added** — `drizzle/0047_salty_owl.sql`
stays the latest file.

## Technical Context

**Language/Version**: TypeScript strict, Node 24 LTS, pnpm (no change)

**Primary Dependencies**: Next.js 16 (App Router, standalone), Drizzle ORM (`drizzle-orm/node-postgres`),
Zod 4, Better Auth, Vitest. **No new runtime dependency and no `pnpm install`** — nothing here needs
one, and pipeline phases cannot reach the registry (constitution VI). Reuses, unchanged in behaviour:
`insightsPermissionFor` (becoming `scopePermissionFor`), `eligible()`'s SQL (becoming
`scope-predicates.ts`), `claimDueEngagementReads`, `runEngagementRead`, `listEngagementAccounts`,
`providerEnvIssues`, `GRANTED_SCOPE_PATTERN`, `registerTestProvider`, `ReconnectGroupButton`.

**Storage**: Postgres via Drizzle. **No migration, no new table, no new column, no new index.**
Eligibility is derived from `social_accounts.granted_scopes` (added by 081; `text[]`, `NULL` = "not
recorded") and the provider declaration. The only SQL added is two reusable `WHERE` fragments and one
`count(*)`.

**Testing**: Vitest. Unit tests beside the source for the pure parts — `scope-permission.ts`, the two
env parsers, both connect groups' `requested`/`cannotWiden`, the registry assertions. Integration
tests against real Postgres (**port 5555** locally, not the 5432 in `.env.example`) for the claim's
exclusion, the lazy-insert exclusion, the companion count, the inbox page and the accounts page. Every
test is offline: no provider HTTP is added, and the gate is driven through `mock` plus
`registerTestProvider` (the pattern `tests/integration/insights/no-reconnect-safety.test.ts:24-37`
established). 077's and 081's engagement and insights suites must pass with **two expected edits and
no others**: `src/lib/insights/eligibility.test.ts` moves to `src/lib/scope-permission.test.ts`
(assertions verbatim, import re-pointed) and `tests/integration/insights/eligibility-matrix.test.ts`
gains the engagement claim as a third subject. A third edit means something generic broke — which is
this entry's load-bearing promise (US2) stated as a test condition.

**Target Platform**: Self-hosted Docker Compose (web, worker, postgres) and Neon with only the
connection string changed. The claim keeps `FOR UPDATE SKIP LOCKED` inside an ordinary transaction —
no advisory lock, so it still works under Neon's transaction-mode pooler.

**Performance Goals**: `runTick()` unchanged — no new section, no new time share, no new budget, same
`ACCOUNTS_PER_RUN = 20`. The engagement-read section gains **at most one** extra query per run (the
companion count), issued only when some provider declares a non-empty `readScopes`; with no such
provider it is skipped entirely and the count is zero (FR-038). The gate makes the claim's own queries
strictly more selective, never less.

**Constraints**: no provider call anywhere in this entry, so none inside a transaction;
`src/providers/**` imports nothing from `src/server/**`; the DAL imports nothing from the provider
registry — the scheduler builds the rules and passes them down, as `runInsightsPoll` already does; no
generic layer branches on a provider key or a platform name; every UI read goes through the scoped
DAL; no scope name, reason, count or account identifier may reach a log, an error, a response or a
snapshot carrying a credential (FR-039); both env flags default off so an untouched install is
byte-identical (FR-029).

**Scale/Scope**: one generic hook (G40) with two halves; two declaration fields plus one registry
assertion block; two extracted shared functions (one pure, one SQL); one claim signature change
applied in two places inside it; one companion count; two env flags; two UI surfaces; one mock setting
plus one test helper; six documentation files; one `docs/decisions.md` entry; **zero** migrations,
**zero** new dependencies, **zero** platform calls.

## Constitution Check

*GATE: passed before Phase 0; re-checked after Phase 1 — see [Post-design re-check](#post-design-re-check-after-phase-1).*

| Principle | How this design satisfies it | Status |
|---|---|---|
| **I. Verified facts over memory (NON-NEGOTIABLE)** | This entry is principle I as a deliverable. No scope string, endpoint, identity field, pagination shape or rate limit is named in this plan, in any contract, or in any code it schedules — the two `*_ENGAGEMENT_SCOPES` flags read from a `const` list that T004 fills **from §2 and nothing else**, and that list is empty until §2 confirms a permission with a source URL (FR-031). The plan goes one step further than the spec because of what planning found: there is no `WebFetch` in this harness, so [contracts/research-section-2.md](./contracts/research-section-2.md) adds an `evidence` grade per cell and makes a search summary admissible only when it quotes the official page verbatim. A fact neither grade can reach stays `unverified` with what was tried, and the entry ships | PASS |
| **II. Nothing is "working" unless it ran** | Nothing here needs a credential, so "verified with mocks only" is not a caveat — it is the whole of what verification means for this entry (SC-009). [quickstart.md](./quickstart.md) gives the exact command per user story, each offline. FR-019's guarantee is asserted the hard way: the absence of a lease, of a decrypt and of a provider call, read from the claim's own records, not a refusal inside a reader. The three things a human must do live — approving the permission on a real Meta and a real Threads consent screen, and a browser pass over the accounts-page line — are parked last (FR-005, spec "Task ordering note") | PASS |
| **III. Project isolation is enforced in one place** | No new table, so no new `project_id` to carry. Both cross-project passes (the claim, the companion count) stay wrapped in `crossProject(reason, …)` exactly as they are today. Every UI read goes through the scoped DAL: the inbox notice is computed inside `listEngagementAccounts`, which already calls `requirePermission(scope, { engagement: ["view"] })`, and the accounts-page line inside `listAccounts`. FR-037 is therefore satisfied by the existing permission gate rather than a new one — asserted by extending `tests/integration/engagement/permissions.test.tsx` | PASS |
| **IV. One service layer, many callers** | The reason the pure decision and the SQL predicate **move** rather than being copied. After this entry there is exactly one `scopePermissionFor` (reached through `insightsPermissionForAccount`'s five call sites and `engagementPermissionForAccount`'s two) and exactly one pair of scope SQL fragments (two claims plus two companion counts). The eligibility matrix test is extended rather than duplicated, so a future surface asking the same question inherits the pins | PASS |
| **V. Providers are plug-ins** | G40 is two declaration values and one argument, all owned by the provider or its connect group. No generic code learns a platform's name: the scheduler maps declarations to rules and the DAL receives scope lists, never keys it interprets. The `ScopeSurface` argument names Docket's own read surfaces, not platforms. A later entry adding `engagement` to Instagram changes one folder and zero generic files — which is exactly what this entry exists to make true | PASS |
| **VI. Boring, few dependencies** | No new runtime dependency, no new infrastructure, no migration, no new tick section. Two new environment variables, both optional, both defaulting off, both parsed by the connect group that owns them through the `parse*Env` function that already parses their insights twins — no new validation mechanism. Justification for the two variables is the same one 081 recorded and `docs/decisions.md` carries: the permission must also be added to the Meta app itself, which no member can do from a web form, so a per-connect checkbox would offer a choice that cannot work alone | PASS |
| **VII. Secrets never leak** | No credential is read on any path this entry adds, because an ineligible account is excluded before the decrypt and an eligible one takes the path 077 already built. Every string introduced — scope names, purposes, reasons, docs paths — is a static non-secret literal, as `INSIGHTS_SCOPES_DECLARED`'s already are. The env parsers report an invalid flag by name with **no value echoed**, mirroring `META_INSIGHTS_SCOPES` (FR-026). `tests/integration/security/secret-scan.test.ts` is extended to cover the new notice, the new count and the new reason — never narrowed | PASS |

**No violations, so [Complexity Tracking](#complexity-tracking) stays empty.** Three judgement calls
are stated up front rather than buried, each to be recorded in `docs/decisions.md` (FR-017):

1. **G40 is one change, not two.** The declaration's read scopes and `cannotWiden`'s surface argument
   ship under one number because they answer one question from two sides. Reversal note:
   [contracts/engagement-read-scopes.md](./contracts/engagement-read-scopes.md) §6.
2. **The pure decision and the SQL predicate were generalised in place**, so 081's names survive as
   aliases. The alternative — a second engagement-shaped copy of each — is what constitution IV
   forbids; see [research.md](./research.md) §2.
3. **§2 cells carry an evidence grade**, because no phase of this pipeline can fetch a page. This is
   an addition to the spec's shape, not a departure from it; see [research.md](./research.md) §1.

## Project Structure

### Documentation (this feature)

```text
specs/084-meta-engagement-facts-and-scope-gate/
├── plan.md                              # This file
├── research.md                          # Phase 0: the no-WebFetch finding, the generalisation, the ordering
├── data-model.md                        # Phase 1: no schema change; the derived shapes and read models
├── quickstart.md                        # Phase 1: how to prove each story, offline
├── contracts/
│   ├── research-section-2.md            # The required shape of §2: 4 surfaces × 9 questions + evidence grade
│   ├── engagement-read-scopes.md        # G40a: declaration fields, registry assertions, claim rule, counts
│   ├── optional-scopes-per-surface.md   # G40b: cannotWiden(source, surface), the two flags, the dialogs
│   └── scope-permission.md              # The one pure decision, its truth table, and the aliases kept
├── checklists/
│   └── requirements.md                  # Pre-existing
├── spec.md
└── tasks.md                             # Phase 2 (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
docs/
├── research/engagement.md               # §2 replaced (4 surfaces × 9 questions); Phase 9 note rewritten
├── research/meta.md                     # One cross-reference to §2; "Checked" date touched
├── engagement.md                        # Supported-platforms table; "Platform permissions" gains Meta/Threads
├── meta-setup.md                        # New §11b beside 11a + an `## Engagement` heading (the #engagement anchor)
├── adding-a-provider.md                 # §20 gains the new fields; "G55" mis-annotation fixed; index gains G40
└── decisions.md                         # G40's rationale and reversal; the two flags; the generalisation

.env.example                             # META_ENGAGEMENT_SCOPES, THREADS_ENGAGEMENT_SCOPES (both commented, false)

src/
├── lib/
│   ├── scope-permission.ts              # NEW: scopePermissionFor + ScopePermission (moved from insights/eligibility)
│   ├── scope-permission.test.ts         # NEW: the truth table, re-pointed from the insights test
│   └── insights/eligibility.ts          # Now a two-line alias module — same exported names, same behaviour
├── providers/
│   ├── types.ts                         # EngagementDeclaration.readScopes/missingReadScopes; ScopeSurface; cannotWiden(source, surface)
│   ├── registry.ts                      # NEW assertEngagementDeclaration, run over every provider at load
│   ├── meta/config.ts                   # engagementScopes parsed from META_ENGAGEMENT_SCOPES
│   ├── meta/oauth.ts                    # optionalFor(cfg) unions insights + engagement opt-ins
│   ├── meta/connect-group.ts            # ENGAGEMENT_SCOPES_DECLARED (from §2), env var listed, cannotWiden per surface
│   ├── threads/config.ts                # engagementScopes parsed from THREADS_ENGAGEMENT_SCOPES
│   ├── threads/connect-group.ts         # declared + requested + authorizationUrl scope list
│   ├── mock/settings.ts                 # engagementReadScopes: string[] (default [])
│   └── mock/engagement.ts               # mockEngagementRuleFor(settings) test helper
├── server/
│   ├── dal/scope-predicates.ts          # NEW: accountHoldsScopes / accountMissingScopes (shared SQL)
│   ├── dal/insights-claims.ts           # eligible() now calls the shared fragments; behaviour identical
│   ├── dal/engagement-read-claims.ts    # Takes EngagementProviderRule[]; predicate in lazy insert AND select
│   ├── scheduler/engagement-read.ts     # Builds the rules; accountsSkippedNoPermission on the counts
│   ├── services/accounts.ts             # engagementPermissionForAccount; engagementReadPermission on AccountRecord
│   └── services/engagement/inbox.ts     # EngagementAccountView.readPermission; ineligible dropped from the filter
└── app/p/[projectSlug]/
    ├── inbox/page.tsx                   # Second notice line; filter excludes ineligible accounts
    └── accounts/page.tsx                # "Inbox needs a reconnect" line, reconnect only when it can help

tests/
├── integration/engagement/scope-gate.test.ts        # NEW: claim exclusion, lazy insert, count, no decrypt
├── integration/engagement/permissions.test.tsx      # Extended: FR-037 — nothing disclosed without inbox view
├── integration/insights/eligibility-matrix.test.ts  # Extended: the engagement claim pinned to the same decision
└── integration/security/secret-scan.test.ts         # Extended: the new notice, reason and count
```

**Structure Decision**: single Next.js project, the layout the repo already has. Every path above is
an existing directory except the four new files named `NEW`; nothing moves between layers, and no new
layer is introduced.

## Complexity Tracking

> No Constitution Check violations, so this table is intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |

## Post-design re-check (after Phase 1)

Re-run against the finished [data-model.md](./data-model.md), the four contracts and
[quickstart.md](./quickstart.md).

- **I. Verified facts over memory** — PASS, and tightened. Phase 1 produced no scope string, no
  endpoint and no identity field anywhere; `ENGAGEMENT_SCOPES_DECLARED` is specified as "whatever §2
  confirms, empty otherwise" in [contracts/optional-scopes-per-surface.md](./contracts/optional-scopes-per-surface.md)
  §2, and [contracts/research-section-2.md](./contracts/research-section-2.md) §4 makes the
  empty-and-documented outcome a first-class shippable state with its own test.
- **II. Nothing is working unless it ran** — PASS. Every one of the six user stories has an offline
  command in [quickstart.md](./quickstart.md); the three live acts are listed there as parked, with
  the instruction to mark them unachievable with a reason rather than leave them open.
- **III. Project isolation** — PASS. [data-model.md](./data-model.md) §1 confirms no persisted shape
  changes, so there is no table to register in `project-owned.ts` and no unscoped query to introduce.
- **IV. One service layer** — PASS, and this is where design strengthened the plan: Phase 1 found the
  SQL predicate as well as the pure decision was duplicable, and
  [contracts/scope-permission.md](./contracts/scope-permission.md) §3 now pins both with one test.
- **V. Providers are plug-ins** — PASS. The claim receives scope lists; the scheduler owns the
  declaration-to-rule mapping; `ScopeSurface` names Docket's surfaces, not platforms.
- **VI. Boring, few dependencies** — PASS. Two optional env vars, no dependency, no migration, no
  infrastructure, no new tick section.
- **VII. Secrets never leak** — PASS. No decrypt on any added path (that absence is the assertion
  FR-019 asks for), every new string a static literal, no flag value echoed in an env issue.
