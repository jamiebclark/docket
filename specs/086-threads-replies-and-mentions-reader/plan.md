# Implementation Plan: Threads replies and mentions land in the inbox

**Branch**: `086-threads-replies-and-mentions-reader` | **Date**: 2026-10-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/086-threads-replies-and-mentions-reader/spec.md`

## Summary

One honest declaration, one presentation change, five proofs of behaviour that was never tested, and
the documentation this roadmap ends with.

**Phase 0 re-ran the question the whole entry turns on, and the answer held.** 085's Phase 0 changed
its own spec's verdict by re-checking the research, so this one re-checked too: two searches of
official Meta documentation for each Threads surface's read endpoint path, object field list and
pagination shape. Both came back the same way the previous three passes did — the capability is
named, the permission is named, no endpoint is quoted ([research.md](./research.md) §1). So the
feature description's rule ("declare an unverified surface `unavailable` with its reason and ship the
other") applied to two unverified surfaces yields **no reader on either**, and this entry ships the
declaration that a future reader drops in behind.

**The declaration's honesty is machine-enforced, which is the part worth knowing.**
`assertEngagementDeclaration` runs at registry import and refuses a declaration carrying both
`unavailable` and `readScopes` — the two make mutually exclusive claims ("not readable here at all"
versus "this account has not granted it yet"). Threads is the first provider to be the former, so
its declaration names **no read permissions at all**, even though both permission names are
confirmed and the connect dialog already requests them behind the operator opt-in. That is FR-005,
and it is also why FR-015 is true by construction: with no `readScopes`,
`engagementPermissionForAccount` returns null, so no member is ever asked to reconnect an account
that reconnecting cannot help.

**The scheduler needs no change to make no call.** `runEngagementRead` already filters unavailable
providers out of its rule list before `claimDueEngagementReads` sees it, and that same
`eligible(rules)` predicate guards both the lazy `engagement_account_states` insert and the claim
select. A Threads account therefore gets no state row, is never claimed, never leased, never
decrypted and never passed to `read()`. There is no code path from a tick to a Threads engagement
call ([research.md](./research.md) §3, D2).

**The parentless-item half is live behaviour on a shipped surface, and it is correct.** Bluesky emits
`kind: "mention"` with a null parent today. Phase 0 read every link in the chain — ingest, the
first-engagement query, the same-post count, the context resolver — and all four hold by
construction ([research.md](./research.md) §2). What is missing is proof, which is the gap this
closes, plus one presentation change: the item page renders the parent block only when there *is*
one, so a mention shows silence, and it labels an unresolved reference identically to the brand's own
post, so two of the three contexts look like one. The service already computes which of the three it
is; the view discards it.

**What ships**: `src/providers/threads/engagement.ts` (a declaration, two empty strict schemas and
two functions that touch nothing); one line on `threadsProvider`; `docsHref` in `src/lib/docs.ts`
with its six call sites; `countAccountsOnUnavailableEngagement` feeding `counts.unavailable`;
`engagementUnavailable` on `AccountView` and its accounts-page block; a three-arm parent block on the
inbox item page; two precedence guards; and four documentation files.

**What does not ship**: no reader, no Threads HTTP call, no Threads client import, no dual cursor, no
page-budget splitter, no reply path, no moderation, no DMs, no new item kind or filter value, no
scheduler section, no setting, no environment variable, and **no migration** —
`drizzle/0047_salty_owl.sql` stays the latest file.

### The four things this plan decides that the spec left to design

1. **The provider file imports nothing from Threads.** `src/providers/threads/engagement.ts` imports
   `zod`, `../types` and `./settings` — not `./requests`, `./credentials`, `./config` or
   `../meta/*`. FR-009 forbids depending on an unconfirmed endpoint path, field name or pagination
   shape, and importing the Threads Graph client would be a dependency on an endpoint-shaped caller
   with nothing confirmed to call. It also makes the file's honesty checkable by reading its import
   list rather than by auditing its branches. Wiring the client in now "so the future reader is a
   smaller diff" was rejected: it is dead code whose only purpose is to look ready
   ([research.md](./research.md) §4).

2. **FR-003's link does not currently reach the documentation, and that is a shipped defect.** Every
   provider declares `docsPath` as `page#anchor`. Four render sites use the raw value as an `href`
   (resolving to `/p/<slug>/meta-setup#engagement`, a 404) and two cast it to `DocPage` and call
   `docsUrl` with the anchor still attached (producing `…/meta-setup#engagement/`, a fragment that
   matches no anchor). Threads would be the first *shipped* provider to set `unavailable.docsPath`,
   so FR-003 and FR-012 cannot be delivered without fixing it — and two of the six are already live
   via 085's Meta `missingReadScopes.docsPath`. One helper, `docsHref`, splits the value and calls
   `docsUrl(page, anchor)`; all six sites use it and the `as DocPage` casts go
   ([contracts/threads-engagement.md](./contracts/threads-engagement.md) §4).

3. **FR-016 needs a count query, because counting in the obvious place would break FR-010.** The
   tick increments `counts.unavailable` only inside `processAccount`, which an unavailable provider's
   accounts never enter — so an install with Threads connected reports `claimed: 0, unavailable: 0`:
   truthful about what it did, silent about what it declined. Counting it inside `processAccount`
   would mean claiming, leasing and decrypting the account first, which FR-010 forbids outright. So
   it mirrors 084's permission gate exactly: `countAccountsOnUnavailableEngagement(providerKeys)`
   beside `countAccountsMissingEngagementScopes`, called unconditionally, added to the existing
   count. No new heartbeat key — `unavailable` is already in the payload and is already the right
   word.

4. **The three parent contexts become three in the view, not just in the service.**
   `resolveParent` already returns `docket_post` / `external_reference` / `null`, and the item page
   collapses the last two into "nothing" and the first two into one `On` block. FR-022 and FR-023
   are satisfied by a three-arm render that uses the `kind` the service already computed: the
   brand's own post named as such, a reference named as *not* one of the brand's posts, and the
   parentless case stated plainly instead of omitted
   ([contracts/parent-context.md](./contracts/parent-context.md) §5). The data-correctness
   guarantees underneath (FR-017 to FR-021) need no code at all — they need the tests the spec says
   do not exist.

### Where this plan disagrees with the roadmap entry

The roadmap entry asked for a reader and named its hard part ("two surfaces, one cursor": dividing a
run's page budget between replies and mentions, holding a position for each, `exhausted` only when
both are). Neither can be built: a budget splitter divides between two pagination shapes, and
neither shape is confirmed. The spec records this in Out of Scope and this plan agrees — the dual
cursor is **deferred with the reader, whole**, and `stateSchema` stays an empty strict object so
nothing guesses at it. The entry's second named problem, the null `parentExternalId`, is not blocked
by anything and ships in full.

## Technical Context

**Language/Version**: TypeScript strict, Node 24 LTS, pnpm (no change).

**Primary Dependencies**: Next.js 16.3.8 (App Router, standalone output), Drizzle ORM
(`drizzle-orm/node-postgres`), Zod 4.6.5, Better Auth, Vitest 5. **No new runtime dependency and no
`pnpm install`** — nothing here needs one, and pipeline phases cannot reach the registry
(constitution VI). Reused unchanged: `EngagementDeclaration`, `EngagementSupport`,
`EngagementReadResult` and `EngagementSendResult` (`src/providers/types.ts`);
`assertEngagementDeclaration` (`src/providers/registry.ts:121`); the whole engagement-read scheduler
section and its claim gate; `resolveParent`, `listEngagementAccounts` and `countNewerOnSameParent`;
`earliestInboxSaidAt` and `recordFirstEngagement`; `docsUrl` and `DocPage` (`src/lib/docs.ts`); the
mock provider's engagement variants; `tests/helpers/*`.

**Storage**: Postgres via Drizzle. **No migration, no new table, column, index or enum value.** The
three parent columns already exist and already allow null, and
`engagement_items_project_parent_idx` is already partial on `parent_external_id IS NOT NULL` — the
storage-level reason no query can group parentless items as a shared parent. No
`engagement_account_states` row is ever created for a Threads account. See
[data-model.md](./data-model.md).

**Testing**: Vitest against a real Postgres (port 5555 locally, the CI service in CI). **Mocks only,
no live platform call anywhere** (constitution II, FR-033, SC-008) — trivially satisfied for the
Threads member, which makes no call at all; the parentless-item proofs run through the mock provider
and the Bluesky mapping. The three UI states are rendered through the existing `*.test.tsx` pattern.

**Target Platform**: Linux server (Docker Compose: web, worker, postgres) and Neon with only the
connection string changed. Unaffected by this entry.

**Project Type**: Next.js web application with a scheduler worker in the same tree.

**Performance Goals**: no change. The one query added to the tick is a single `count(*)` over
`social_accounts` with the same predicate shape as the one beside it; `runEngagementRead`'s time
budget is untouched and nothing new runs per account.

**Constraints**: `read()` and `send()` make **zero** outbound requests and read **zero** credentials
(FR-009, FR-010, SC-002). The declaration carries no `readScopes` (FR-005, enforced at import). No
value in the declaration traces to an `unverified` cell of `docs/research/engagement.md` §2
(FR-011). Accessibility: the new parent statements are static text — no new control, no new focus
stop, no `role="alert"` on a normal mention (`docket-ui`).

**Scale/Scope**: 1 new provider file (~40 lines), 1 new pure helper, 1 new DAL count, 1 new
`AccountView` field, ~6 edited files in `src/`, 4 documentation files, and the test files that prove
all of it. No new screen.

## Constitution Check

*GATE: must pass before Phase 0 research. Re-checked after Phase 1 design — see §Re-check.*

| Principle | Verdict | How |
|---|---|---|
| **I. Verified facts over memory** (non-negotiable) | **PASS** | The only facts the code uses are confirmed §2 cells: two permission names and their access levels (left in the connect group, untouched), and the fact that both read endpoints are unconfirmed. Everything `unverified` is *not used* — that is the design, not a limitation. Phase 0 re-checked both surfaces against official domains and recorded the outcome and its date ([research.md](./research.md) §1), which also discharges FR-031. The one adjacent fact that surfaced (Keyword Search's reply-shaped fields) is recorded as **found and rejected**: inferring one surface's shape from another's is the exact move this principle forbids. No `NEEDS RESEARCH` marker: no fact this entry's code needs is missing. |
| **II. Nothing is "working" unless it ran** | **PASS** | Every behaviour is executed by a test: the declaration through registry import and direct assertion, the no-call guarantee through a real `runEngagementRead` with a connected Threads account and a fake transport that fails the test if touched, the parentless guarantees against **stored rows** and the real housekeeping pass (FR-034), the three contexts through rendered output. Reported as **verified with mocks only** (SC-008). No live call exists to make. |
| **III. Project isolation in one place** | **PASS** | No new project-owned table and no new query on one. The two reads added are: a cross-project `count(*)` over `social_accounts` inside `crossProject()` in the DAL, exactly as its neighbour `countAccountsMissingEngagementScopes` does — scheduler-owned, never reachable from a route; and `engagementUnavailable`, which is computed from the provider registry with no query at all. Every UI read stays behind `forProject` / `requirePermission`. |
| **IV. One service layer, many callers** | **PASS** | No logic duplicated. `docsHref` *removes* two divergent, both-wrong implementations of "render a declared docs pointer" and leaves one. The parent context stays resolved in exactly one place (`resolveParent`); the view consumes its answer instead of recomputing it. |
| **V. Providers are plug-ins** | **PASS** | One new file in `src/providers/threads/`, one line on the provider object, nothing else in the provider seam. No scheduler change, no composer change, no schema change. The scheduler, services and UI treat Threads exactly as they already treat an unavailable surface — which is the seam working as designed. |
| **VI. Boring, few dependencies** | **PASS** | No new dependency, no new infrastructure, no `pnpm install`. One pure function added to an existing lib file. |
| **VII. Secrets never leak** | **PASS** | Nothing new is encrypted, decrypted or logged. `read()` and `send()` never touch `ctx.account.credentials` (their parameter is `_ctx`), and both schemas are `.strict()` so a stray token is a parse failure rather than a stored extra key. The `unavailable` reason and the `send()` error are fixed strings with no interpolation, so neither can carry a credential. |

**Engineering constraints**: `runTick()` stays well under 30 s (one `count(*)` added); no session-level
Postgres features; no time-zone maths; all times already UTC. Accessibility per `docket-ui` — the
three parent states are static text in one block position, so the page's shape does not jump between
items.

**Development workflow**: Conventional Commits with the `Co-Authored-By` trailer, explicit paths on
every `git add`. Checks in proportion (constitution): per task only the affected `pnpm vitest run
<files>` plus `pnpm typecheck` when types change; **one** final pass of
`pnpm lint && pnpm typecheck && pnpm test` at the end of implement, plus `pnpm build` because
`src/app/**` route files change. **No `pnpm db:check`** is needed — the schema is untouched — but it
runs in CI regardless and must stay green, which it will because no migration is added.

### Re-check after Phase 1 design

No gate moved. Three things the design settled are worth naming against the gates:

- **Principle I held under pressure.** The temptation Phase 0 found was real: Keyword Search gives a
  reply-shaped field list that *would* have let a reader be written. Rejecting it is recorded in
  both [research.md](./research.md) §1 (R3) and the research-file edit, so the next person does not
  find it and assume it was missed.
- **Principle V stayed intact without special-casing.** Nothing in the scheduler, DAL, services or
  UI learns the word "threads". The one new count takes provider *keys* computed from the registry,
  so a second unavailable surface needs no further change.
- **Principle IV gained from the `docsHref` fix** rather than paying for it: six sites, two wrong
  implementations, now one correct one. Fixing a shipped broken link beside the feature that needs
  it is cheaper than the alternative and is recorded as a judgement call in `docs/decisions.md`.

## Project Structure

### Documentation (this feature)

```text
specs/086-threads-replies-and-mentions-reader/
├── plan.md                           # this file
├── research.md                       # Phase 0: the re-check, the chain read end to end, the defect
├── data-model.md                     # Phase 1: no migration; the parent triple's three states
├── quickstart.md                     # Phase 1: how to run and see each claim
├── contracts/
│   ├── threads-engagement.md         # the declaration, the two no-op functions, docsHref, the tick count
│   ├── parent-context.md             # the three contexts, the five proofs, the notice and the filter
│   └── documentation.md              # the four doc files and the test that pins them
├── checklists/                       # pre-existing
├── spec.md
└── tasks.md                          # Phase 2 — NOT created by /speckit-plan
```

### Source code (repository root)

```text
src/
├── providers/
│   ├── threads/
│   │   ├── engagement.ts             # NEW — declaration + two empty strict schemas + two no-op fns
│   │   ├── engagement.test.ts        # NEW — declaration values, FR-004 wording, no-call, FR-035 refusals
│   │   ├── index.ts                  # EDIT — one line: `engagement: threadsEngagement`
│   │   └── connect-group.ts          # UNCHANGED (FR-006) — the opt-in stays exactly as shipped
│   └── registry.ts                   # UNCHANGED — assertEngagementDeclaration already refuses the bad pair
├── lib/
│   ├── docs.ts                       # EDIT — NEW `docsHref(docsPath)`
│   └── docs.test.ts                  # NEW — colocated, the `src/lib/*.test.ts` convention
├── server/
│   ├── dal/
│   │   └── engagement-read-claims.ts # EDIT — NEW countAccountsOnUnavailableEngagement()
│   ├── scheduler/
│   │   └── engagement-read.ts        # EDIT — feed counts.unavailable from it (FR-016)
│   └── services/
│       └── accounts.ts               # EDIT — NEW AccountView.engagementUnavailable (FR-014)
├── app/p/[projectSlug]/
│   ├── inbox/page.tsx                # EDIT — docsHref; permission notice only when not unavailable
│   ├── inbox/[itemId]/page.tsx       # EDIT — three-arm parent block (FR-022, FR-023)
│   └── accounts/page.tsx             # EDIT — unavailable block; docsHref; precedence guard
└── components/
    ├── insights/TargetMetrics.tsx    # EDIT — docsHref, drop the `as DocPage` cast
    └── targets/PerformancePanel.tsx  # EDIT — same, three sites

tests/
├── integration/
│   ├── engagement/
│   │   ├── threads-unavailable.test.ts     # NEW — US1: notice, filter, zero claims/decrypts, tick count
│   │   ├── parentless-ingest.test.ts       # NEW — US2: stored rows, mixed page (FR-017, FR-024)
│   │   ├── parent-context.test.tsx         # NEW — US3: the three rendered states (FR-020, FR-022, FR-023)
│   │   └── same-post-count.test.ts         # NEW — FR-019 with several parentless items
│   ├── insights/
│   │   └── first-engagement.test.ts        # EDIT — FR-018, SC-003: mention excluded, reply included
│   ├── accounts/
│   │   └── accounts-page-engagement.test.ts # NEW — FR-014 block, FR-015 precedence, no Reconnect
    └── docs/
        ├── engagement-roadmap-docs.test.ts # NEW — FR-025..FR-032, SC-005..SC-007
        └── engagement-research.test.ts     # UNCHANGED — constrains how §2 may be edited

docs/
├── engagement.md            # EDIT — table split per surface; the endpoint reason; the opt-in sentence
├── meta-setup.md            # EDIT — the now-false "nothing is read on any Meta surface"
├── adding-a-provider.md     # EDIT — §20: the two reader shapes; "has not published" vs "has not granted"
├── research/engagement.md   # EDIT — the 2026-10-19 re-check and the per-surface missing-facts list
└── decisions.md             # EDIT — one `## 086` section, three judgement calls
```

**Structure decision**: the existing layout, unchanged. A provider is one folder
(`src/providers/threads/`) with one new file registered by one line — constitution V's shape, and
the reason this entry needs no scheduler or schema work. The shared behaviour this entry proves
(ingest, first-engagement, inbox) stays where it already is, because FR-024 makes it a property of
those files rather than of a provider.

## Complexity Tracking

No constitution violation to justify. Two additions worth recording because each could look like
scope the spec did not ask for:

| Addition | Why needed | Simpler alternative rejected because |
|---|---|---|
| `docsHref` + six call-site edits | FR-003 requires the reason to carry a link to the setup documentation and FR-012 requires the inbox to show it. Rendered as the code stands, that link 404s. Threads is the first shipped provider to set `unavailable.docsPath`, so the requirement cannot be met without this. | Hard-coding the full published URL in the Threads declaration: it would diverge from every other provider's `page#anchor` convention, leave the four other sites broken (two of them live since 085), and move a documentation URL into a provider file. |
| `countAccountsOnUnavailableEngagement` | FR-016 requires the tick to account for an unavailable account as unavailable. The existing counter only increments for accounts that enter `processAccount`, which these never do, so the tick reports zero. | Letting the account through the claim so `processAccount` can count it: that means claiming, leasing and decrypting it, which FR-010 forbids in as many words. Leaving the count at zero: FR-016 is explicit, and a section that declines work silently is a known failure mode in this scheduler. |
