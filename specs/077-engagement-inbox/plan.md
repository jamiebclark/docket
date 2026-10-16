# Implementation Plan: Comment and message engagement

**Branch**: `077-engagement-inbox` | **Date**: 2026-10-15 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/077-engagement-inbox/spec.md`

## Summary

Inbound replies, comments, mentions and DMs become first-class rows in a project-scoped **inbox**,
read by the existing `runTick()` with a per-account cursor and lease; a member asks for a **reply
draft** written from the project's voice profile, brand identity and the account's posting
instructions; the draft waits in the existing **Review** surface, where exactly one person approves
it through the same decision core that approves a post; the approved reply is sent by the tick
*after* publishing has taken what it needs of the account's write allowance, guarded by an
insert-only **claim ledger** keyed on the inbound item so an item can never be answered twice.

Bluesky is the only platform implemented here. Its reading surface is verified from the installed
`@atproto/api` (`app.bsky.notification.listNotifications`, which carries the author, the text, the
parent reference and a cursor); its write cost is verified in `docs/research/bluesky.md`. The Meta
surfaces (US4) and direct messages (US5) stay specified and **blocked**: both need facts that no
pipeline phase can obtain — a live Standard Access app, real accounts, a real commenter and a
browser. What this entry ships for them is the seam: a declared provider capability, so adding a
surface later touches that provider's folder and the research document and nothing else (SC-012).

### What this entry delivers, and what it cannot

| Story | In this entry | Why |
|---|---|---|
| US1, Bluesky half | **Yes** — desk research from the installed lexicons and `docs/research/bluesky.md` into `docs/research/engagement.md` | Verifiable without credentials; gates US2 |
| US1, Meta half | **Recorded as a human task, scheduled last** | Needs a live Meta app, real accounts, a second person and a browser (spec constraint 2). Constitution II forbids reporting it settled from mocks |
| US2 (inbox) | **Yes**, Bluesky | No app review, no LLM spend, no send path |
| US3 (draft, review, send) | **Yes**, Bluesky | The entry's point |
| US4 (Meta surfaces) | **No** — blocked on US1's Meta half; the capability seam and the `unavailable` declaration are built and tested through the mock provider | FR-055: no Meta behaviour may rest on an unverified verdict |
| US5 (direct messages) | **No** — modelled (`direct_message` is a declared inbound kind, distinct and visibly private) but unreadable and unsendable until a platform's DM facts are committed | FR-056, constitution I |

Scaling the entry down further is not this plan's call: US4 and US5 stay in `tasks.md` as blocked
tasks with their blocker named, and the four gaps of FR-069 are published.

## Technical Context

**Language/Version**: TypeScript strict, Node 24 LTS, pnpm (no change)

**Primary Dependencies**: Next.js 16.3.8 (App Router, standalone), Drizzle ORM 0.45.3
(`drizzle-orm/node-postgres`), Zod 4.6.5, Better Auth 1.7.7, `@atproto/api` ^0.22.0 (installed;
`app.bsky.notification.*` and `com.atproto.repo.createRecord` are already in the dependency),
Vitest. **No new runtime dependency and no new infrastructure.**

**Storage**: Postgres 17 via Drizzle; four new project-owned tables, five new enums, three new
`activity_event_kind` labels, one new `activity_outcome` label, one widened CHECK on
`notification_preferences`, one rebuilt partial index on `activity_events`

**Testing**: Vitest. Unit tests for the pure parts (paging policy, reserve arithmetic, prompt
assembly, eligibility); integration tests against real Postgres (`DATABASE_URL` on port 5555
locally) for ingest idempotency, concurrency, leases, kill-recovery, the shared decision core,
cross-project isolation, permissions, retention and the migration-upgrade guard; provider tests with
mocked HTTP only — **no live calls** (constitution II)

**Target Platform**: Self-hosted Docker Compose (web, worker, postgres) and Neon with only the
connection string changed; migrations on the direct URL; no session-level Postgres features

**Project Type**: Web application — Next.js App Router monolith with a worker running the same
`runTick()`

**Performance Goals**: `runTick()` stays well under 30 s with a backlog present (SC-007); an item is
in the inbox within five minutes of being said (SC-001) at the default one-minute tick; a reply is
live within a minute of approval (SC-002); the inbox page and the nav counts stay inside the
existing per-screen budgets (the unread count is capped at `UNREAD_CAP`)

**Constraints**: reads and sends are bounded per account per run; no provider call inside a held
transaction; publishing is served before replies within a run (FR-042); nothing sends without a
signed-in member's approval (FR-028); no API or MCP surface (FR-030); inbound text and author are
immutable once stored (FR-010); no secret on any engagement path (FR-062)

**Scale/Scope**: tens to low hundreds of inbound items per account per day (spec assumption); four
new tables; one new screen (`/p/[slug]/inbox`) plus a second section on `/review` and on
`/failures`; one new permission statement; 90-day default retention, operator-configurable

## Constitution Check

*GATE: passed before Phase 0; re-checked after Phase 1 design — see "Post-design re-check" below.*

| Principle | How this design satisfies it | Status |
|---|---|---|
| **I. Verified facts over memory** | Bluesky reading is taken from the installed package's generated lexicon types (`node_modules/@atproto/api/dist/client/types/app/bsky/notification/listNotifications.d.ts`) and its write cost from `docs/research/bluesky.md`; the Postgres enum/index behaviour this design depends on was **executed** against Postgres 17.11, not recalled (research.md §1, §2). Everything still unknown is marked `NEEDS RESEARCH` in research.md §7 and no behaviour depends on it | PASS |
| **II. Nothing is "working" unless it ran** | Provider reads and sends are covered by mocked-HTTP tests; the Meta spike is a human task and its result is never assumed; the migration-upgrade guard runs a real committed-then-upgraded database | PASS |
| **III. Project isolation in one place** | Every new table carries `project_id`; every read and write goes through new DAL repos registered in `ProjectScope` (UI) and `createSchedulingRepos` (tick); no route, action or job imports the raw client; the cross-project scope test is extended to the inbox (SC-008) | PASS |
| **IV. One service layer, many callers** | The approval decision is **extracted**, not copied: `services/review/decide.ts` owns the row lock, the same-process `serialized()` gate, the already-decided refusal and the reviewer record, and both posts and reply drafts go through it. Approval policy keeps exactly one implementation, with the policy input pinned to review-required for replies | PASS |
| **V. Providers are plug-ins** | Engagement is one optional member on `SocialProvider` (`engagement?`). The inbox, drafting, review, notifications and activity log never name a provider. A provider that declares nothing is absent from the inbox | PASS |
| **VI. Boring, few dependencies** | No new package, no queue, no Redis, no webhook endpoint, no `LISTEN`, no advisory lock. Reading and sending are sections of `runTick()`, claimed with `FOR UPDATE SKIP LOCKED` plus a lease column | PASS |
| **VII. Secrets never leak** | Credentials are decrypted only inside the tick's read/send step, exactly as publishing does; the item's `provider_data` is provider-owned, bounded and validated, and the secret scan is extended to the inbox, the review reply section and the draft prompt | PASS |
| **Engineering constraints** | UTC storage, Temporal for wall-time display, `docket-ui` skill for every screen, keyboard and empty/error states, server components by default | PASS |
| **Out-of-scope list** | This entry is the spec that changes it: `docs/build-prompt.md` and the constitution's Engineering Constraints are amended in a `docs(constitution):` commit with a version bump (FR-065) | PASS (by amendment) |

No violation needs justifying, so Complexity Tracking stays empty. Three design choices that *look*
like new mechanism are argued in research.md rather than waved through: the insert-only claim ledger
with a release generation (§3), the batch-level notification event (§4) and the separate reply
prompt beside the post generator (§5).

## Architecture

### Where the work runs

```text
runTick()
├── publishing            (unchanged)                 ─┐ concurrent, as today
├── token refresh, generation, housekeeping, …         │
├── engagement reads      NEW, concurrent              ─┘
└── engagement sends      NEW, awaited after publishing resolves  ← FR-042
```

Reading is independent of publishing and runs concurrently with every existing section. **Sending is
sequenced after the publishing section resolves inside the same tick**, because FR-042 requires
publishing to be served first, and `runTick()` currently starts all sections with one `Promise.all`.
`src/server/scheduler/index.ts` therefore starts publishing and the other sections, awaits the
publishing promise, then runs the engagement-send section with the remaining time budget. Nothing
else about the tick changes; the summary gains two `SectionResult` entries.

Both sections claim per account with `FOR UPDATE SKIP LOCKED` plus a lease column on
`engagement_account_states`, exactly as publishing claims targets and token refresh claims accounts.
No provider call happens inside a held transaction. A tick killed mid-read loses the lease and the
next tick resumes from the last committed cursor.

### The approval seam

`src/server/services/review.ts` keeps its public functions (`listReviewQueue`, `countReviewQueue`,
`approvePost`, `rejectPost`, `bulkApprove`) and their behaviour. What moves out is the generic part:

```text
services/review/decide.ts        serialized(key, run), lock-and-decide, alreadyDecided refusal,
                                 reviewer record (reviewState / reviewedAt / reviewedByUserId)
services/review.ts               the post adapter (validation gate, variant prepare, queueing)
services/engagement/review.ts    the reply adapter (ledger check, send enqueue, no bulk approve)
```

Both adapters call one `decide()`. A test asserts there is exactly one place that writes an
approval, by searching for writers of `review_state = 'approved'` outside `decide.ts`.

## Project Structure

### Documentation (this feature)

```text
specs/077-engagement-inbox/
├── spec.md
├── plan.md                 # this file
├── research.md             # Phase 0
├── data-model.md           # Phase 1
├── quickstart.md           # Phase 1
├── contracts/              # Phase 1
│   ├── provider-engagement.md
│   ├── services.md
│   └── vocabulary.md
├── checklists/requirements.md
└── tasks.md                # Phase 2, written by /speckit-tasks — NOT by this phase
```

### Source Code (repository root) — new and touched

```text
src/
├── lib/
│   ├── activity/outcomes.ts            + engagement kinds and the `engagement` outcome
│   ├── activity/details.ts             + strict `details` shapes for the three new kinds
│   ├── notifications/attention.ts      + `engagement` in the member attention set
│   ├── notifications/eligibility.ts    + `engagement` in ATTENTION_KINDS
│   └── engagement/                     NEW pure helpers: paging policy, reserve arithmetic,
│                                       item presentation, identity rules (FR-016 … FR-018)
├── providers/
│   ├── types.ts                        + `engagement?: EngagementSupport` (contracts/provider-engagement.md)
│   ├── bluesky/engagement.ts           NEW read + send (listNotifications, createRecord reply)
│   ├── bluesky/engagement-map.ts       NEW notification → inbound item (pure)
│   └── mock/                           + engagement declaration for tests, incl. `unavailable`
├── server/
│   ├── db/schema/engagement.ts         NEW four tables + five enums
│   ├── db/schema/activity.ts           kind/outcome CHECK regenerated with `::text` (research §1)
│   ├── db/schema/notifications.ts      widened `notification_preferences_kind_key`
│   ├── dal/engagement.ts               NEW repos: items, drafts, claims, account states
│   ├── dal/engagement-claims.ts        NEW cross-account claim loop for the tick
│   ├── dal/scope.ts                    + repos on ProjectScope and createSchedulingRepos
│   ├── auth/access.ts                  + `engagement: ["view", "reply"]`
│   ├── scheduler/index.ts              + two sections, sends after publishing
│   ├── scheduler/engagement-read.ts    NEW claim → read → ingest → cursor
│   ├── scheduler/engagement-send.ts    NEW claim → reserve → ledger claim → send → record
│   ├── scheduler/engagement-budget.ts  NEW pure per-account reserve (FR-042)
│   ├── scheduler/housekeeping.ts       + retention pass (FR-060, FR-061)
│   ├── services/review/decide.ts       NEW extracted decision core
│   ├── services/engagement/            NEW inbox.ts, draft.ts, prompt.ts, review.ts, send.ts,
│   │                                   dismiss.ts, retention.ts
│   └── services/failures.ts            + replies needing a decision (FR-040)
└── app/p/[projectSlug]/
    ├── inbox/                          NEW page, list, item view, actions
    ├── review/                         + the replies section
    └── failures/                       + the replies-needing-a-decision section

drizzle/0036_*.sql                      one migration: enums, tables, CHECK regen, index rebuild
tests/                                  see quickstart.md for the full list
docs/                                   engagement.md (new page + nav), research/engagement.md,
                                        privacy.md, security.md, adding-a-provider.md,
                                        build-prompt.md, feature-map.md, decisions.md
.specify/memory/constitution.md         out-of-scope amendment + version bump (FR-065)
```

**Structure Decision**: the existing single-app layout is kept. Engagement adds one DAL module, one
service folder, two scheduler sections, one provider member and one screen; it introduces no new
top-level directory and no second deployable.

## Phase 0 — research

See [research.md](./research.md). It records: the executed Postgres findings that decide the
migration shape (§1–§2), the claim-ledger semantics (§3), the notification granularity (§4), the
drafting seam (§5), the Bluesky facts taken from the installed package (§6), and the open
`NEEDS RESEARCH` items that gate US4 and US5 (§7). Every `NEEDS CLARIFICATION` in the Technical
Context above is resolved there or is explicitly out of this entry's scope.

## Phase 1 — design

- [data-model.md](./data-model.md) — the four tables, five enums, every constraint and index, the
  two state machines, the vocabulary added to activity and notifications, and the retention rules.
- [contracts/provider-engagement.md](./contracts/provider-engagement.md) — the provider contract: the
  declaration, `read()`, `send()`, every result shape and the rules a provider must obey.
- [contracts/services.md](./contracts/services.md) — every service function, its permission, its
  refusals and its transaction boundaries, plus the scheduler sections.
- [contracts/vocabulary.md](./contracts/vocabulary.md) — the permission statement, the activity kinds
  and outcomes, the notification switch, the env vars and the exact migration statement order.
- [quickstart.md](./quickstart.md) — how to run and prove it, requirement by requirement.

## Post-design re-check

The design adds no infrastructure, no dependency and no second implementation of approval,
publishing or slot allocation. Three points were re-examined after the design settled and are
recorded as judgement calls for `docs/decisions.md`:

1. **Sending happens in the tick, not in the HTTP request.** FR-028 forbids a send that no person
   approved; it does not require the send to be inside the approving request, and FR-043 explicitly
   anticipates "waiting for a later run". Sending in the tick is what gives the send a lease, a
   claim ledger and the publishing-first reserve. The approving member is recorded on the draft and
   on the activity event.
2. **One new `activity_outcome` label forces the attention index to be rebuilt without naming it.**
   Executed against Postgres 17.11: a partial index predicate cannot cast an enum to text (`42P17`,
   the cast is not `IMMUTABLE`) and cannot name a label added in the same transaction (`55P04`).
   The predicate is therefore inverted to name only pre-existing labels, and the planner still
   chooses the index for the count query (research.md §2).
3. **The inbox is its own screen; only the decision lives in Review.** Straight from the spec's
   assumptions, and it keeps the Review queue good at the job it already does.

## Complexity Tracking

*No constitution violation requires justification.*
