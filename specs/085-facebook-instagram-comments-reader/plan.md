# Implementation Plan: Facebook Page and Instagram comment reading

**Branch**: `085-facebook-instagram-comments-reader` | **Date**: 2026-10-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/085-facebook-instagram-comments-reader/spec.md`

## Summary

One sweep in the shared Meta layer, two thin provider declarations, and a one-expression defect fix
in the scheduler.

**The research step came first, and it changed the answer.** The spec was written against a §2 that
said both surfaces "must ship declared-but-`unavailable`", and FR-001 to FR-006 made closing that gap
a prerequisite rather than an assumption. Phase 0 closed it: official Meta documentation confirms a
commenter identity shape for both surfaces (**G1**), identifier stability for Facebook and its
genuine absence for Instagram (**G2**), that absence from a re-read is *not* a delete signal on either
(**G3**), and an own-posts listing edge for each (**G4** — the question §2 never asked). So by FR-006,
computed rather than asserted, **both surfaces ship readable**. [research.md](./research.md) §1 is the
evidence, graded cell by cell, and
[contracts/research-section-2-additions.md](./contracts/research-section-2-additions.md) is the exact
edit §2 must receive before a line of reading code is written.

**The research also found a permission the spec did not expect.** `pages_read_engagement` is
necessary and not sufficient for Facebook: reading *other people's* comments needs
`pages_read_user_content` as well (research.md §1.1). No existing account holds it, so every
connected Facebook Page is skipped by 084's claim gate — counted, surfaced in the inbox notice, and
reconnectable — until its owner opts in. That is the gate doing its job, and it is the difference
between this entry shipping a reader and shipping a reader that silently returns nothing.

**The sweep costs one Graph call per `read()`.** Field expansion with `.limit()` and per-edge nested
cursors (research.md §1.3) means a single request returns five of the brand's own posts *with* their
comments *with* a cursor per post:

```
GET /{page-id}/posts?fields=id,created_time,comments.limit(10){id,message,created_time,from{name,id}}&limit=5
GET /{ig-user-id}/media?fields=id,timestamp,comments.limit(10){id,text,timestamp,username,user{id}}&limit=5
```

The per-post fan-out the spec worried about does not exist, and FR-014's bound becomes a constant —
**at most `ENGAGEMENT_READ_PAGES_PER_RUN` calls per account per run, 3 by default**, whatever the
account holds.

**What ships**: `src/providers/meta/engagement-{sweep,map,state,errors}.ts`; an `engagement` member on
each of the Facebook and Instagram providers, each a declaration plus a `MetaCommentSurface` object
naming only what differs between a Page and an Instagram account; `pages_read_user_content` added to
`ENGAGEMENT_SCOPES_DECLARED` and to `cannotWiden`'s engagement message; two registry assertions;
FR-033's fix in `src/server/scheduler/engagement-read.ts`; FR-041's wording; §2's edit and four
documentation files.

**What does not ship**: no Threads, no reply path, no moderation, no DMs, no inbox redesign, no new
scheduler section or setting, no change to the engagement seam, and **no migration** —
`drizzle/0047_salty_owl.sql` stays the latest file.

### The four things this plan decides that the spec left to design

1. **The sweep runs its own catch-up, because the scheduler's backfill flag will never fire for a
   Meta account.** Found by reading `src/lib/engagement/paging.ts` rather than by assuming it:
   `nextBackfillState` enters the `older` direction only when a page comes back **full** with nothing
   already stored. Bluesky's notification feed does that on day one; a Meta account with months of
   posts and four comments never will, so US3's catch-up would never start. The seam cannot change
   and the provider cannot set the flag, so the walk lives entirely in `provider_state` and advances
   on a step the sweep chooses for itself — `direction` is still honoured when the scheduler does ask
   for older items, it is just not the only way progress happens. [research.md](./research.md) §2.1.

2. **One `read()` is one step and one Graph call.** Three requirements pointed the same way: FR-014
   wanted a bound stated as a number rather than a formula over an account's size, US4 wanted that
   number small enough that the inbox cannot spend the Page's hourly budget, and FR-012 wanted the
   position in provider-owned state. A pacing gate ("one real read per account per 15 minutes") was
   designed and then **rejected** — the interval would have been a number from nowhere, which
   principle I does not permit, and FR-018's usage-signal back-off is the governor the research
   actually confirms exists. [contracts/meta-engagement-sweep.md](./contracts/meta-engagement-sweep.md) §3,
   [research.md](./research.md) §2.

3. **"Already have it" is one number, not a set.** FR-009 forbids the provider from reading Docket's
   database, so the fresh pass cannot ask whether a comment is stored. Remembering the newest comment
   per post would be unbounded and break FR-013 for a large account. So the fresh pass keeps a single
   high-water comment timestamp and emits only what is newer; the catch-up applies no such filter,
   because its whole purpose is what the high-water mark hides; and the database's unique index makes
   an exact repeat free. [research.md](./research.md) §3.

4. **Instagram's self-comment check costs one call, once, and the read refuses to proceed without
   it.** FR-016 is correctness, not polish — a member notified about their own reply stops trusting
   the inbox. Facebook is easy (a Page comments as its own id, which Docket holds). Instagram returns
   only a `username` for someone else's comment, and Docket stores the account's *display* name, not
   its username. So the first Instagram read fetches `GET /{ig-user-id}?fields=username`, caches it
   in provider state for the life of the account, and a failure to fetch it returns `retryable_error`
   rather than reading comments it cannot screen. Deriving the username from the display name was
   rejected outright: FR-028 forbids deriving one identity field from another.
   [research.md](./research.md) §4.

### The defect this feature cannot ship without

`src/server/scheduler/engagement-read.ts` parses `providerState` on entry and then re-commits **that
same value** on a successful page (`:124-125`, `:245`), discarding `result.providerState`. Bluesky
returns no state, so the discard has never shown. The sweep's entire position lives in that field: on
every run it would re-read the same five posts and never catch up.

FR-033 fixes it in one expression on the `page` branch — commit the returned state when there is one,
the entry state otherwise. No interface change, no column change, Bluesky byte-identical, and on
every non-page outcome the position stays untouched exactly as FR-022 requires. This is honouring a
field the seam already declares, not adding a hook; the spec records the disagreement with the
roadmap entry's "no scheduler change" framing, and this plan agrees with the spec.

## Technical Context

**Language/Version**: TypeScript strict, Node 24 LTS, pnpm (no change).

**Primary Dependencies**: Next.js 16 (App Router, standalone), Drizzle ORM
(`drizzle-orm/node-postgres`), Zod 4, Better Auth, Vitest. **No new runtime dependency and no
`pnpm install` beyond the worktree's own** — nothing here needs one, and pipeline phases cannot reach
the registry (constitution VI). Reused unchanged: `graphRequest` and `GraphOutcome`
(`src/providers/meta/graph.ts` — its `validPath` already admits every path this feature sends,
including `{page-id}_{post-id}`), `classifyGraphError` and `scrub` (`meta/errors.ts`),
`parseUsageHeader` / `activeUsageBackoff` / `recordUsageBackoff` (`meta/usage.ts`), `readPageToken`
(`meta/credentials.ts`), `graphVersion` and `metaUsageCeiling` (`meta/config.ts`), the whole
engagement seam and scheduler section, 084's claim gate and inbox notice, and
`tests/helpers/fake-graph.ts`.

**Storage**: Postgres via Drizzle. **No migration, no new table, no new column, no new index, no new
enum value.** One comment is one `engagement_items` row with the columns 077 built; the walk lives in
`engagement_account_states.provider_state`, an existing `jsonb` column with an existing 2,000-byte
check constraint that the sweep's shrink guard keeps unreachable. `drizzle/0047_salty_owl.sql` stays
the latest file and `pnpm db:check` is not required. See [data-model.md](./data-model.md).

**Testing**: Vitest. Unit tests beside the source and needing no HTTP at all for the pure parts —
`mapAuthor` and `isSelf` per surface, the state schema and its shrink guard, the step chooser, the
outcome mapping. Provider tests with the Graph API stubbed through `createFakeGraph`, whose
`requests` log is what SC-003's call bound and SC-009's zero-calls promise are asserted against.
Integration tests against real Postgres (**port 5555** locally, not the 5432 in `.env.example`) for
the provider-state round trip, the ten-run idempotency of SC-002, the permission gate, the
unavailable path and the inbox view. **Every 077 and 084 engagement test must pass with no edits** —
an edit means something generic changed that this feature promised not to change. No test makes a
live platform call (FR-044).

**Target Platform**: Self-hosted Docker Compose (web, worker, postgres) and Neon with only the
connection string changed. No session-level Postgres feature is used; the engagement claim keeps
`FOR UPDATE SKIP LOCKED` inside an ordinary transaction, untouched.

**Performance Goals**: `runTick()` gains no section, no time share and no setting. Two more providers
appear in the engagement-read claim's rules, which makes its existing queries more selective, never
less. Per account per run: **at most 3 Graph calls** (`ENGAGEMENT_READ_PAGES_PER_RUN`), plus one
once-ever Instagram username fetch; at most 5 posts examined and 1 comments page per post per call;
at most `ENGAGEMENT_READ_PAGE_SIZE` items emitted per call. No provider call happens inside a held
transaction — the sweep is called from `processAccount` outside one, as it already is.

**Constraints**: `src/providers/**` imports nothing from `src/server/**`; the sweep reads no
project-scoped data and has no means to (FR-009); no generic layer branches on a provider key; every
message is `scrub`bed and every summary built from `graphSummary`, so no token reaches a stored
message, an activity entry or a snapshot (FR-023, FR-034); `provider_data` is `{}` with a strict empty
schema, which makes a leaked credential a type error; `upstream` is never set, so nothing is ever
flagged withdrawn or edited (FR-032); both surfaces' reads are gated on declared scopes no existing
account holds, so an untouched install reads nothing until someone opts in and reconnects.

**Scale/Scope**: four new files in `src/providers/meta/` plus their tests; one new file per provider
plus tests; one scope string added in two places; two registry assertions; one expression in the
scheduler; one sentence in the inbox; one §2 edit (six cells replaced, one corrected, one question
added across four surfaces); four documentation files; one `docs/decisions.md` entry. **Zero**
migrations, **zero** new dependencies, **zero** new settings, **zero** live platform calls.

## Constitution Check

*GATE: passed before Phase 0; re-checked after Phase 1 — see [Post-design re-check](#post-design-re-check-after-phase-1).*

| Principle | How this design satisfies it | Status |
|---|---|---|
| **I. Verified facts over memory (NON-NEGOTIABLE)** | The feature's first phase *is* principle I, and it ran during planning rather than being deferred: [research.md](./research.md) §1 closes G1 to G4 against official Meta domains, grades every answer `page` or `search-summary` by 084's rule, and records what a grade cannot reach. Every endpoint, field, permission, pagination key and limit in both contracts carries a trace, and [contracts/meta-comment-surface.md](./contracts/meta-comment-surface.md) §3–§4 is a table of values beside the §2 row each comes from — so SC-008 is checkable by reading, not by trusting. Three documented facts are deliberately **not** depended on (ordering, `total_count`, nested-cursor specifics: research.md §1.2), and FR-048's assumption list is pre-populated with them. `pages_read_user_content` is the proof the method works: a permission this plan would have got wrong from memory | PASS |
| **II. Nothing is "working" unless it ran** | Nothing here can be verified live — no Meta app, no Page, no Instagram account, no second person to comment — so FR-045's "verified with mocks only" is the honest whole of verification, and [quickstart.md](./quickstart.md) ends by naming the three things the mocks *cannot* prove. Every provider test stubs `fetch` through `createFakeGraph`; the call bound and the zero-calls promise are asserted against its request log rather than a timer or an absence of output. No task may report a behaviour working without a test that ran (FR-044) | PASS |
| **III. Project isolation is enforced in one place** | No new table, so no new `project_id`. The sweep is a provider: it receives one account and a token and has no access to the DAL, the database client or a project scope — FR-009 is satisfied by there being nothing to call, not by a rule to follow. Every write goes through the scheduler's existing `forSchedulerProject(account.projectId)` repos inside one transaction per account; every UI read goes through `listEngagementAccounts`, which already calls `requirePermission(scope, { engagement: ["view"] })` | PASS |
| **IV. One service layer, many callers** | The reason FR-008 is the spec's structural requirement and this plan's structure. The sweep, the comment mapping, the state handling, the usage back-off and the `GraphOutcome` → outcome mapping each exist **once**, in `src/providers/meta/`, with two callers. The negative precedent is in the same two folders: `facebook/insights.ts` and `instagram/insights.ts` each carry their own copy of the Graph error mapping, and that duplication is exactly what the spec's "two sets of off-by-one bugs" names. Each provider's engagement module is a declaration plus one object of differing facts | PASS |
| **V. Providers are plug-ins** | Adding these two surfaces touches `src/providers/facebook/`, `src/providers/instagram/` and `src/providers/meta/` and changes **no** generic file except the one defect fix. The scheduler, the composer, the claim, the inbox service and the schema are untouched; Facebook and Instagram appear in the inbox's account list, filter and notices because `listEngagementAccounts` already reads the declaration. The one scheduler edit honours a field the seam already declares and is Bluesky-byte-identical — plug-in behaviour restored, not bypassed | PASS |
| **VI. Boring, few dependencies** | No new runtime dependency, no new infrastructure, no migration, no new tick section, and — the decision this plan is proudest of — **no new setting**. A per-account pacing gate was designed and rejected because its interval would have been invented; `ENGAGEMENT_READ_MIN_INTERVAL_SECONDS` already exists for an operator who needs to slow reads down, and `docs/engagement.md` will say so. The only configuration change is one scope string in an existing `const` list | PASS |
| **VII. Secrets never leak** | The token is read once per `read()` through `readPageToken`, passed to `graphRequest` (which puts it in the query or the form body and never in a returned value), and listed in `scrub`'s secrets on every message built. Summaries come from `graphSummary`, which emits only status, Graph code, type, trace id and usage percent. `provider_data` is `{}` under a strict empty schema. `tests/integration/security/secret-scan.test.ts` is extended — never narrowed — to cover the two surfaces' messages, summaries, activity entries and stored data (SC-007) | PASS |

**No violations, so [Complexity Tracking](#complexity-tracking) stays empty.** Four judgement calls
are stated up front rather than buried, each to be recorded in `docs/decisions.md`:

1. **§2's "must ship declared-but-`unavailable`" verdict is overturned by research, not by
   assumption.** Both surfaces ship readable because FR-001 to FR-005 closed the gaps that caused the
   verdict and FR-006 then computed it. The `unavailable` path stays built and tested, and flipping
   either surface back is one declaration field
   ([contracts/meta-comment-surface.md](./contracts/meta-comment-surface.md) §5).
2. **`pages_read_user_content` is declared, which skips every existing Facebook Page until it
   reconnects.** The alternative — declaring only `pages_read_engagement` and hoping — ships a reader
   that returns nothing with no explanation. The gate's reconnect notice is the better failure.
3. **The sweep advances its own catch-up rather than waiting for the scheduler's backfill flag**,
   because that flag demonstrably never fires for a Meta account. Reversal: delete the step-3 branch
   in the step chooser and the catch-up becomes `direction`-driven only, which is correct but slow.
4. **No pacing setting was added.** FR-018's usage-signal back-off plus the existing minimum interval
   are the budget controls; an invented interval would have been a fact from nowhere.

## Project Structure

### Documentation (this feature)

```text
specs/085-facebook-instagram-comments-reader/
├── plan.md                                   # This file
├── research.md                               # Phase 0: G1–G4 answered; the design decisions and what was rejected
├── data-model.md                             # Phase 1: no schema change; which column holds what, and which check guards it
├── quickstart.md                             # Phase 1: how to prove each story, offline, and what mocks cannot prove
├── contracts/
│   ├── meta-comment-surface.md               # The per-surface facts: the only things a Page and an IG account disagree about
│   ├── meta-engagement-sweep.md              # The shared walk: state, call bound, step order, outcomes
│   └── research-section-2-additions.md       # The exact edit §2 must receive before any reading code
├── checklists/
│   └── requirements.md                       # Pre-existing
├── spec.md
└── tasks.md                                  # Phase 2 (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
docs/
├── research/engagement.md                    # §2: 6 cells replaced, 1 corrected, Q10 added for 4 surfaces, Phase 9 note narrowed
├── engagement.md                             # Supported-platforms table (FR-046); Platform permissions (FR-047); the interval note
├── meta-setup.md                             # The #engagement section names pages_read_user_content and what a reconnect grants
└── decisions.md                              # The four judgement calls above, each with its reversal

src/
├── providers/
│   ├── meta/
│   │   ├── engagement-sweep.ts               # NEW: metaEngagementRead — step chooser, fresh, drain, catch-up
│   │   ├── engagement-sweep.test.ts          # NEW
│   │   ├── engagement-map.ts                 # NEW: comment → InboundItemDraft; MetaCommentSurface type
│   │   ├── engagement-map.test.ts            # NEW
│   │   ├── engagement-state.ts               # NEW: the state schema, the caps, the shrink guard
│   │   ├── engagement-state.test.ts          # NEW
│   │   ├── engagement-errors.ts              # NEW: GraphOutcome → EngagementReadResult, once
│   │   ├── engagement-errors.test.ts         # NEW
│   │   └── connect-group.ts                  # pages_read_user_content in ENGAGEMENT_SCOPES_DECLARED and cannotWiden
│   ├── facebook/
│   │   ├── engagement.ts                     # NEW: declaration + the Page's MetaCommentSurface
│   │   ├── engagement.test.ts                # NEW
│   │   └── index.ts                          # engagement: facebookEngagement
│   ├── instagram/
│   │   ├── engagement.ts                     # NEW: declaration + the IG account's MetaCommentSurface (incl. prefetchSelf)
│   │   ├── engagement.test.ts                # NEW
│   │   └── index.ts                          # engagement: instagramEngagement
│   └── registry.ts                           # Two assertions: readScopes must be requestable; canReply:false forbids writeBudget
├── server/scheduler/engagement-read.ts       # FR-033: commit result.providerState on a page
└── app/p/[projectSlug]/inbox/[itemId]/page.tsx  # FR-041: the sentence reads as a platform limit, not a fault

tests/
├── helpers/fake-graph.ts                     # Unchanged — used as it is
└── integration/
    ├── engagement/meta-read.test.ts          # NEW: store once, parent resolved, retention, failure leaves state alone
    ├── engagement/meta-unavailable.test.ts   # NEW: unavailable never claimed; the other surface still reads
    ├── engagement/meta-not-repliable.test.tsx# NEW: no composer, one sentence, everything else still works
    ├── engagement/provider-state.test.ts     # NEW: FR-033 both halves (persisted on page, untouched on failure)
    ├── engagement/scope-gate.test.ts         # Extended: the un-reconnected Facebook Page, zero calls, counted
    └── security/secret-scan.test.ts          # Extended: the new messages, summaries, activity and provider_data
```

**Structure Decision**: the single Next.js project the repo already has. Every directory above
exists; the files marked `NEW` are new files inside them. Nothing moves between layers and no layer
is introduced — which is the point: a new reading surface should be a provider folder and nothing
else, and the one generic file in the list is there to repair that promise rather than to extend it.

## Complexity Tracking

> No Constitution Check violations, so this table is intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |

## Risks, stated rather than discovered later

| Risk | Why it is acceptable | What would catch it |
|---|---|---|
| Most §1 answers are graded `search-summary`, not `page` — this harness has no `WebFetch` (084's finding) | 084 established the grade and the admissibility rule, and every graded cell quotes the official page's own words. A rejected grade flips one surface to `unavailable` by one field, not by a redesign | A reviewer reading §2 against [contracts/meta-comment-surface.md](./contracts/meta-comment-surface.md) §3–§4 |
| Neither listing documents its default order, and Instagram's comments edge documents no `order` parameter | The sweep filters by each comment's own timestamp and never assumes arrival order; the drain step asks Facebook for `reverse_chronological` where it *is* documented and follows Instagram's nested cursor where it is not | Recorded as an assumption under FR-048; a mocked test fixing an order the platform has not promised |
| `pages_read_user_content` could prove unnecessary, making every Facebook Page reconnect for nothing | A reconnect that grants an unused read permission costs one dialog; the opposite error costs a reader that silently returns nothing. Both are reversible; only one is visible | The §2 cell and its source; a live check, if anyone ever runs one |
| The catch-up walks past the retention horizon and stores nothing on a very old account | The seam does not pass retention to a provider and inventing a horizon would be a number from nowhere. Bounded per run, correct, and it ends | Noted in [contracts/meta-engagement-sweep.md](./contracts/meta-engagement-sweep.md) §4.5 as a known inefficiency, for the hardening entry |
| `provider_state` hits its 2,000-byte check and fails the transaction that carries the items | The shrink guard drops `pending` then the catch-up cursor at 1,500 bytes, so the cap is unreachable; worst case is ≈ 900 bytes | A unit test that builds a maximal state and asserts the encoded size |
| A busy post's newest comments sit outside the inline block and the drain queue is full | At most 3 busy posts are remembered per read and the queue drains on later reads; the catch-up reaches the post regardless | The drain-step test's cursor advance, and the three-read catch-up test |

## Phase ordering this plan requires of `tasks.md`

Not a task list — the two orderings that are load-bearing, so Phase 2 does not have to rediscover
them:

1. **§2's edit comes before the first line of reading code.** FR-001 says so, and
   [contracts/research-section-2-additions.md](./contracts/research-section-2-additions.md) §8
   repeats it: a reviewer must be able to see that the facts came first.
2. **FR-033's fix comes before the sweep's integration tests**, because without it the walk cannot
   advance and every catch-up test would fail for the wrong reason.

And one warning from the pipeline's own history: **park any task needing a browser, a live Meta app
or a second person last, or do not write it at all.** This feature needs none — FR-045 states plainly
that no live account is read — and a human-judgement task placed early starves the implement loop
until it times out.

## Post-design re-check (after Phase 1)

Re-run against the finished [research.md](./research.md), [data-model.md](./data-model.md), the three
contracts and [quickstart.md](./quickstart.md).

- **I. Verified facts** — PASS, and stronger after Phase 1 than before it. Every value in the two
  code contracts carries a trace to a §2 row or a research.md §1 answer; the facts the design refuses
  to depend on are listed (research.md §1.2); FR-048's assumption list is written in advance
  (contracts/research-section-2-additions.md §7). No endpoint, field, permission or limit appears
  anywhere in these artifacts without a source.
- **II. Nothing works unless it ran** — PASS. quickstart.md gives a command per user story, every one
  offline, and closes with what the mocks cannot prove. No design element needs a live credential,
  and none is scheduled.
- **III. Project isolation** — PASS. Unchanged by the design: the sweep has no path to project-owned
  data, every write goes through the scheduler's existing scoped repos, and data-model.md adds no
  table to carry `project_id`.
- **IV. One service layer** — PASS, and the design's organising principle. Four shared modules, two
  callers, zero duplicated mapping.
- **V. Providers are plug-ins** — PASS. The file list has exactly one generic file in it, and that
  one is a defect fix which restores the plug-in promise rather than qualifying it.
- **VI. Boring** — PASS. No dependency, no infrastructure, no migration, no setting. The pacing gate
  that would have added one was rejected on principle-I grounds and the rejection is recorded.
- **VII. Secrets** — PASS, and tightened by Phase 1: `data: {}` under `z.object({}).strict()` makes a
  credential in `provider_data` a compile error, and the secret scan is extended rather than
  narrowed.

No violation appeared during design, so Complexity Tracking remains empty.
