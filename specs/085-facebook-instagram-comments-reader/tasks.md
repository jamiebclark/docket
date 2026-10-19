---

description: "Task list for Facebook Page and Instagram comment reading"
---

# Tasks: Facebook Page and Instagram comment reading

**Input**: Design documents from `/specs/085-facebook-instagram-comments-reader/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md — all present

**Tests**: Requested by the spec itself (FR-044, FR-045) — every behaviour here is covered by a
mocked test, no live platform call anywhere.

**Organization**: Tasks are grouped by user story. Two orderings are load-bearing and fixed by
plan.md: (1) the §2 research edit (Phase 2) precedes the first reader code (FR-001); (2) FR-033's
scheduler fix (Phase 2) precedes every sweep integration test, because without it the catch-up
cannot advance.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US6)

## Path Conventions

Single Next.js project at the repository root — `src/`, `tests/`, `docs/`.

---

## Phase 1: Setup

No new dependency, no new infrastructure, no migration (plan.md Technical Context). The worktree's
own `pnpm install` and local Postgres on port 5555 are the only prerequisites, and both are
developer-machine setup rather than tasks that change the repo.

- [X] T001 Confirm the worktree's `pnpm install` is current and `docker compose up -d postgres`
      answers on port 5555, per quickstart.md Prerequisites (no file changes; this gates nothing
      else and is not re-verified per task)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Settle the facts (constitution I) and fix the scheduler defect the whole sweep depends
on. **Nothing in Phase 3 onward may start until this phase is complete** — FR-001 requires the facts
before any reading code, and the sweep cannot advance its catch-up without FR-033.

- [X] T002 Apply contracts/research-section-2-additions.md §2–§6 to `docs/research/engagement.md`
      §2: replace the six cells (Facebook Q3/Q4/Q8, Instagram Q3/Q4/Q8), correct Facebook Q2 to
      `pages_read_engagement` **and** `pages_read_user_content`, flip both surfaces' `Consequence`
      paragraphs from "must ship declared-but-unavailable" to "readable" with the FR-006 table
      reproduced, add question 10 (own-posts listing) for all four surfaces, add the field-expansion
      note under the two Meta surfaces' tables, and narrow the Phase 9 closing note per §6 — transcribed
      from research.md §1, not re-derived (FR-001 to FR-007)
- [X] T003 [P] Fix the provider-state discard defect in
      `src/server/scheduler/engagement-read.ts`: on the `kind: "page"` branch, assign
      `providerState = result.providerState ?? providerState` immediately after the
      `result.kind !== "page"` guard, so a successful page's returned state is what gets committed
      instead of the state parsed on entry; every other outcome (the `stop` branch and the loop's
      early breaks) must continue to leave `providerState` exactly as parsed (FR-033, FR-022)
- [X] T004 [P] Add `tests/integration/engagement/provider-state.test.ts`: a test provider (via
      `registerTestProvider`) whose `read()` returns a changed `providerState` on a `page` result has
      that state handed to its *next* `read()` call; a second test provider whose `read()` returns a
      non-page outcome after inserting items leaves `provider_state` byte-for-byte unchanged while the
      inserted items remain committed (FR-033, FR-022, SC-006) — depends on T003

**Checkpoint**: §2 now backs every fact the surfaces below will declare, and the scheduler honours
the state field the sweep's position lives in. User story work can begin.

---

## Phase 3: User Story 1 - A comment on our Facebook Page reaches the inbox (Priority: P1) 🎯 MVP

**Goal**: One Facebook Page comment, read through the shared sweep, becomes one inbox item
attributed to the right post.

**Independent Test**: Mocked Page-posts and Page-comments responses; running the engagement-read
section stores the comment once, as kind `comment`, with the platform's comment id, the post id as
parent, and the parent resolved to the Docket post.

### Shared Meta layer (built here, reused by US2)

- [X] T005 [P] [US1] Create `src/providers/meta/engagement-state.ts`: the `metaEngagementStateSchema`
      (contracts/meta-engagement-sweep.md §2, `v: 1`, `.strict()`, `pending` capped at 3), a
      `parseEngagementState` helper that returns `{}` on any parse failure or `v` mismatch (never
      throws), and a `shrinkEngagementState` guard that serialises the state and, while it exceeds
      1,500 bytes, drops `pending` entries oldest-first then `catchUp.postsAfter`
- [X] T006 [P] [US1] Create `src/providers/meta/engagement-state.test.ts`: the schema accepts a
      maximal state and rejects an extra field (`.strict()`); a state with an unknown `v` parses to
      `{}`; a state built to exceed 1,500 bytes shrinks by dropping `pending` first and then
      `catchUp.postsAfter`, ending under the limit; a unit test builds the largest value the schema
      allows and asserts its serialised size stays under the database's 2,000-byte check (contracts
      §2 rule 1, data-model.md §3, FR-013)
- [X] T007 [P] [US1] Create `src/providers/meta/engagement-errors.ts`: one function mapping a
      `GraphOutcome` (and the two special-cased Graph code 100 cases: on a request carrying a stored
      cursor vs. on a single post's comments edge) to one of the engagement seam's six non-`page`
      `EngagementReadResult` members, through `classifyGraphError` and `scrub`, with every `summary`
      built from the existing `graphSummary` helper (contracts/meta-engagement-sweep.md §6, FR-019,
      FR-020, FR-023, FR-034)
- [X] T008 [P] [US1] Create `src/providers/meta/engagement-errors.test.ts`: every `GraphReply` shape
      `tests/helpers/fake-graph.ts` offers (`graph_error` at each classified code, `http` 4xx/5xx,
      `unparseable`, `reset_mid_body`, `pre_send_failure`, `hang`) maps to exactly one of the six
      non-`page` outcomes with no fall-through; a Graph code 100 on a cursor-bearing request maps to
      `cursor_lost`; no mapped message or summary contains a planted access token (FR-019, FR-020,
      FR-023, SC-005, SC-007)
- [X] T009 [US1] Create `src/providers/meta/engagement-map.ts` exporting the `MetaCommentSurface`
      interface and `MetaSelfIdentity` type (contracts/meta-comment-surface.md §1) plus the shared
      emit step: given a surface, a raw comment object and a post id, produce one `InboundItemDraft`
      per contracts/meta-engagement-sweep.md §5 — trimmed `externalId` (skip if unusable), `text` from
      `surface.commentTextField` or `""`, truncation at 10,000 chars with `textTruncated`, `author`
      from `surface.mapAuthor(comment)` untouched, `saidAt` parsed from `surface.commentTimeField`
      (skip the comment if unparseable, never default to `now`), `parentExternalId` the post id,
      `data: {}`, `upstream` never set (FR-024 to FR-031, FR-032)
- [X] T010 [US1] Create `src/providers/meta/engagement-map.test.ts`: the emit step against recorded
      Facebook and Instagram comment fragments produces the exact drafts contracts/meta-comment-surface.md
      §3–§4 table, including the "self" cases (a Facebook comment whose `from.id` equals the Page id,
      an Instagram comment whose `username` or `user.id` equals the account's own identity) producing
      no draft; a comment with no usable id is skipped; a comment with unparseable time is skipped,
      never dated `now`; truncation at 10,000 characters sets `textTruncated` (US1 scenarios 3–4, US2
      scenario 3, FR-016, FR-028, SC-008) — depends on T009
- [X] T011 [US1] Create `src/providers/meta/engagement-sweep.ts` exporting `metaEngagementRead`
      (contracts/meta-engagement-sweep.md §1, §3, §4): the pre-step checks (usage back-off,
      `readPageToken`, `prefetchSelf` when the surface declares one and `state.selfUsername` is
      absent), the step chooser (§4.2: drain pending → catch-up on `direction === "older"` → catch-up
      on `lastStep === "fresh"` → fresh), the fresh step (§4.3: one call, per-comment self/`freshSince`
      filter, queue busy posts into `pending`, advance `freshSince`, `lastStep: "fresh"`,
      `exhausted: false` always), the drain step (§4.4: one call per pending post, no `freshSince`
      filter, advance or remove the pending entry, code 100 removes the entry without failing),
      the catch-up step (§4.5: one call at `catchUp.postsAfter`, no `freshSince` filter, `exhausted`
      and `done` true only when both the listing and `pending` are exhausted) — depends on T005, T007,
      T009
- [X] T012 [P] [US1] Create `src/providers/meta/engagement-sweep.test.ts` (fresh/self/freshSince
      sections only here; drain, catch-up, usage and bound sections land in US3/US4): mocked `fetch`
      via `tests/helpers/fake-graph.ts`; a fresh step against one page of posts with inline comments
      emits the expected drafts; a comment at or below `freshSince` is skipped on a second read; a
      busy post whose inline block came back full is queued into `pending` (US1 scenarios 1–2, FR-010)
      — depends on T011

### Facebook provider declaration

- [X] T013 [US1] Create `src/providers/facebook/engagement.ts`: the `facebookEngagement` object —
      `declaration` exactly as contracts/meta-comment-surface.md §3 (`reads: ["comment"]`,
      `canReply: false`, `readScopes: ["pages_read_engagement", "pages_read_user_content"]`,
      `missingReadScopes.reason` naming `pages_read_user_content` and the reconnect action,
      `docsPath: "meta-setup#engagement"`), and a `MetaCommentSurface` for the Page: `ownPostsPath`
      → `` `/${id}/posts` `` (never `/feed`), `postTimeField: "created_time"`,
      `commentFields: ["id", "message", "created_time", "from{name,id}"]`,
      `commentTextField: "message"`, `commentTimeField: "created_time"`,
      `drainParams: { order: "reverse_chronological", filter: "toplevel" }`, `prefetchSelf: null`,
      `mapAuthor` and `isSelf` exactly per contracts §3, `read` delegating to `metaEngagementRead`
      (FR-008, FR-024 to FR-031, FR-035, FR-037, FR-038)
- [X] T014 [P] [US1] Create `src/providers/facebook/engagement.test.ts`: `mapAuthor` against a
      `from: {name, id}` fragment and against a `from`-absent fragment; `isSelf` true when `from.id`
      equals the Page's `externalId`; the declaration's `readScopes`, `missingReadScopes` and
      `docsPath` match contracts §3 verbatim (US1 scenario 4, FR-027 to FR-029)
- [X] T015 [US1] Wire `engagement: facebookEngagement` onto the exported provider object in
      `src/providers/facebook/index.ts` — depends on T013

### Registry and scope wiring

- [X] T016 [US1] Add `pages_read_user_content` to `ENGAGEMENT_SCOPES_DECLARED` in
      `src/providers/meta/connect-group.ts` and name it in `cannotWiden`'s engagement message, so the
      opt-in flag can request what facebookEngagement's declaration needs (contracts/meta-comment-surface.md
      §3, "a registry assertion should catch, not a reviewer") — depends on T013
- [X] T017 [US1] Extend `assertEngagementDeclaration` in `src/providers/registry.ts` with the two
      checks contracts/meta-comment-surface.md §6 requires: (1) every scope in a non-unavailable
      provider's `declaration.readScopes` must appear in that provider's connect group's `baseScopes`
      or `optionalScopes.declared`, so a declared-but-unrequestable scope fails at load; (2)
      `declaration.canReply === false` forbids a `writeBudget` on the same declaration — depends on
      T013, T016
- [X] T018 [P] [US1] Extend `src/providers/registry.test.ts` (or create it beside the existing
      registry tests if none covers `assertEngagementDeclaration` yet) with cases for both new
      checks: a provider declaring a `readScope` absent from its connect group's requestable scopes
      throws; a provider with `canReply: false` and a `writeBudget` set throws — depends on T017

### End-to-end for Facebook

- [X] T019 [US1] Create `tests/integration/engagement/meta-read.test.ts` (Facebook half, shared file
      with US2/US3/US4): with mocked Page-posts and Page-comments responses, run the engagement-read
      section for a connected Facebook Page holding both declared scopes and assert one
      `engagement_items` row with kind `comment`, the platform's comment id as `external_id`, the post
      id as `parent_external_id`, `parent_post_id`/`parent_post_target_id` resolved; a second run over
      the same scripted response inserts nothing (US1 scenarios 1–2, FR-025, FR-026, SC-002) — depends
      on T011, T013, T015, T016, T017, T003

**Checkpoint**: User Story 1 is independently functional — a Facebook comment reaches the inbox once,
attributed to its post, with no self-notification and no synthesised author field.

---

## Phase 4: User Story 2 - A comment on our Instagram post reaches the inbox (Priority: P1)

**Goal**: The same journey on Instagram, proving the shared sweep generalises to a second surface.

**Independent Test**: Mocked account-media and media-comments responses; running the section stores
the comment once with its parent media id resolved to the Docket post.

### Instagram provider declaration

- [X] T020 [US2] Create `src/providers/instagram/engagement.ts`: the `instagramEngagement` object —
      `declaration` exactly as contracts/meta-comment-surface.md §4 (`reads: ["comment"]`,
      `canReply: false`,
      `readScopes: ["instagram_basic", "instagram_manage_comments", "pages_read_engagement"]`,
      `missingReadScopes.reason` naming `instagram_manage_comments`, `docsPath: "meta-setup#engagement"`),
      and a `MetaCommentSurface` for the account: `ownPostsPath` → `` `/${id}/media` ``,
      `postTimeField: "timestamp"`,
      `commentFields: ["id", "text", "timestamp", "username", "user{id}"]`,
      `commentTextField: "text"`, `commentTimeField: "timestamp"`, `drainParams: {}`,
      `prefetchSelf`: `GET /{ig-user-id}?fields=username` returning `{ kind: "ok", selfUsername }` or
      the mapped `GraphOutcome` on failure, `mapAuthor` and `isSelf` exactly per contracts §4, `read`
      delegating to `metaEngagementRead` (FR-008, FR-016, FR-024 to FR-031, FR-035, FR-037, FR-038)
      — depends on T009, T011 (US1)
- [X] T021 [P] [US2] Create `src/providers/instagram/engagement.test.ts`: `mapAuthor` against a
      `username`-only fragment and a `username` + `user.id` fragment (owned-comment case); `isSelf`
      true on a matching `username` and, separately, on a matching `user.id`; `prefetchSelf` against a
      scripted `GET /{ig-user-id}?fields=username` success and failure (failure maps through
      engagement-errors, never a partial read); the declaration's `readScopes`, `missingReadScopes`
      and `docsPath` match contracts §4 verbatim (US2 scenarios 1, 3; FR-016, FR-027 to FR-029)
- [X] T022 [US2] Wire `engagement: instagramEngagement` onto the exported provider object in
      `src/providers/instagram/index.ts` — depends on T020

### Sweep behaviour specific to Instagram's "refuse without identity" rule

- [X] T023 [US2] Extend `src/providers/meta/engagement-sweep.ts`'s pre-step checks (if not already
      general enough from T011) so that a surface with a non-null `prefetchSelf` and no cached
      `selfUsername` always runs it before any comment is read, and a `prefetchSelf` failure returns
      the mapped outcome with **no** comments read that run — FR-016 has no degraded mode — depends on
      T011, T020
- [X] T024 [P] [US2] Extend `src/providers/meta/engagement-sweep.test.ts` with Instagram-specific
      cases: `prefetchSelf` runs first and once, its result lands in the returned `providerState`;
      a failing `prefetchSelf` returns `retryable_error` (or the outcome `engagement-errors.ts` maps
      its failure to) with zero comments emitted that run; nested replies present under a scripted
      `replies` key are absent from the emitted drafts — Docket stores only what the top level returns
      (US2 scenario 2, FR-016) — depends on T023

### End-to-end for Instagram

- [X] T025 [US2] Extend `tests/integration/engagement/meta-read.test.ts` with the Instagram half:
      mocked account-media and comments responses store one comment with `parent_post_id` /
      `parent_post_target_id` resolved to the Docket post; `author_handle` is `username`,
      `author_identity_stable` is `false` (US2 scenario 1, FR-026, FR-029) — depends on T020, T022,
      T023

**Checkpoint**: User Stories 1 and 2 both work independently; the shared sweep has proven itself
against two surfaces with genuinely different identity shapes.

---

## Phase 5: User Story 3 - Older comments are caught up, and the catch-up ends (Priority: P2)

**Goal**: The catch-up walks backward across successive runs, resumes after a kill, and stops for
good once the platform has nothing older.

**Independent Test**: Mocked responses spanning several pages of the brand's own posts; successive
`read()` calls each reach further back, a killed run resumes from the last committed position, and
exhaustion is reported once and never revisited.

- [X] T026 [US3] Extend `src/providers/meta/engagement-sweep.ts`'s step chooser and catch-up step (if
      not already complete from T011) to satisfy contracts/meta-engagement-sweep.md §4.2 and §4.5 in
      full: `state.lastStep === "fresh"` triggers a catch-up step on the *next* read even when
      `direction` is `"newest"`; the catch-up advances `catchUp.postsAfter` from the response's own
      cursor; `exhausted: true` and `done: true` are written **only** when the listing has no further
      page **and** `pending` is empty after the step; a step that stopped at `POSTS_PER_PAGE` with a
      cursor in hand returns `exhausted: false` even though it examined its full bound (FR-011,
      FR-015) — depends on T011
- [X] T027 [US3] Extend `src/providers/meta/engagement-sweep.test.ts` with the catch-up suite: three
      successive `read()` calls against a scripted three-page listing each send the previous response's
      `after` cursor rather than restarting; a `read()` given the provider state from a killed run
      (mid-catch-up) resumes from that state rather than from the newest post; the final page (no
      further `after`, no `pending`) returns `exhausted: true` with `done: true`, and a subsequent
      `read()` issues no further catch-up call; a step that hits its bound with a cursor still in hand
      explicitly asserts `exhausted: false` (US3 scenarios 1–3, FR-011, FR-015, SC-004) — depends on
      T026
- [X] T028 [P] [US3] Extend `src/providers/meta/engagement-sweep.test.ts` (or
      `engagement-errors.test.ts`, whichever holds the cursor_lost mapping) with the rejected-position
      case: a Graph error code 100 on a request carrying `catchUp.postsAfter` or a `pending[].after`
      maps to `cursor_lost`; a scheduler-level test (extend
      `tests/integration/engagement/meta-read.test.ts`) asserts the scheduler's existing `cursor_lost`
      handler resets `provider_state` to `{}` with a `gap_at` and the next read restarts from the
      newest post, losing no already-stored item and re-notifying nothing (US3 scenario 4, FR-020) —
      depends on T007, T019
- [X] T029 [P] [US3] Extend `tests/integration/engagement/meta-read.test.ts` with a retention case: a
      scripted catch-up comment older than `ENGAGEMENT_RETENTION_DAYS` is read by the sweep (the
      provider does not filter it) but is not stored by the existing scheduler retention check, so a
      later restart cannot resurrect it (US3 scenario 5, spec Edge Cases) — depends on T019; this
      exercises generic scheduler behaviour already shipped, not new provider code

**Checkpoint**: All three P1/P2 "reading" stories work together; an account with months of history
is caught up progressively and the catch-up provably ends.

---

## Phase 6: User Story 4 - Reading never costs the brand its ability to publish (Priority: P2)

**Goal**: The sweep stays inside a stated, bounded number of calls per run and backs off on the
platform's own usage signal, sharing the budget with publishing rather than spending it.

**Independent Test**: A mocked usage signal at and below the configured ceiling; a run at the
ceiling records a back-off and the next run declines with `rate_limited`, while a run below proceeds.

- [X] T030 [US4] Confirm (and adjust if needed) that `src/providers/meta/engagement-sweep.ts`'s
      pre-step check calls `activeUsageBackoff(account.id, now)` before any Graph request and, when
      active, returns `rate_limited` with that `retryAt` and issues no call; and that every Graph
      response passes through `applyUsageSignal`/`recordUsageBackoff` so a response at or above
      `metaUsageCeiling()` with `estimated_time_to_regain_access` records a back-off for the
      **next** read without aborting the read already in progress (FR-018) — depends on T011
- [X] T031 [P] [US4] Extend `src/providers/meta/engagement-sweep.test.ts` with the usage suite: a
      scripted response carrying `x-business-use-case-usage` at or above the ceiling records a
      back-off; the next `read()` for that account returns `rate_limited` with the recorded `retryAt`
      and `graph.requests` gains no new entry (US4 scenario 1, FR-018) — depends on T030
- [X] T032 [P] [US4] Extend `src/providers/meta/engagement-sweep.test.ts` with the call-bound suite:
      against a scripted account with at least 50 posts (ten times `POSTS_PER_PAGE`), one `read()`
      issues exactly one Graph request; a scheduler-level assertion (extend
      `tests/integration/engagement/meta-read.test.ts`) confirms a full run issues at most
      `ENGAGEMENT_READ_PAGES_PER_RUN` calls regardless of account size — asserted on
      `graph.requests.length`, never on a timer (US4 scenario 2, FR-014, SC-003) — depends on T011,
      T019
- [X] T033 [P] [US4] Extend `src/providers/meta/engagement-errors.test.ts` to enumerate every
      `GraphOutcome` shape the fake graph offers end-to-end for both surfaces and assert each maps to
      one of the seam's six non-`page` outcomes with no unclassified case (US4 scenario 3, FR-019,
      SC-005) — depends on T008; largely a coverage extension of T008 rather than new behaviour
- [X] T034 [P] [US4] Extend `tests/integration/engagement/meta-read.test.ts` with a failure-leaves-
      state-alone case: after a failing read (any non-page outcome) mid-run, `provider_state` and
      `backfilling` are byte-for-byte what they were before the run, while any item inserted earlier
      in the same run is still present; and a secret-scan assertion that no access token appears in
      the stored error message, attempt summary, activity entry or snapshot for this run (US4 scenario
      4, FR-022, FR-023, SC-006) — depends on T019, T003

**Checkpoint**: Reading is provably bounded and provably backs off; publishing's share of the
business-use-case budget is never at risk from the inbox.

---

## Phase 7: User Story 5 - A member understands that a Meta comment cannot be answered here (Priority: P3)

**Goal**: The existing not-repliable sentence reads as a deliberate platform limit, not a fault, for
both new surfaces; everything else on the item still works.

**Independent Test**: Open the inbox detail view for a stored Facebook comment and a stored
Instagram comment; confirm no reply composer, the stated reason, and that dismiss/mark-handled/post
link still work.

- [X] T035 [US5] Edit `src/app/p/[projectSlug]/inbox/[itemId]/page.tsx:79-83`: replace the
      `Can't reply: {item.replyable.reason}` wording with a plain sentence that does not carry a
      "fault report" prefix, keeping `role="status"` and the existing `replyableVerdict` logic
      (`canReply: false` → "This platform cannot be replied to through Docket.") untouched — only the
      surrounding sentence changes (FR-041, data-model.md §4)
- [X] T036 [P] [US5] Create `tests/integration/engagement/meta-not-repliable.test.tsx`: the inbox
      detail view for a stored Facebook comment and for a stored Instagram comment each render no
      reply composer and no disabled control, showing the corrected sentence naming the platform
      limit; dismissing, marking handled, the link to the parent post and the account filter all still
      work on both items (US5 scenarios 1, 2, 4; FR-041, FR-042) — depends on T035, T013, T020
- [X] T037 [P] [US5] Extend `tests/integration/engagement/send.test.ts` with a case per new surface: a
      send attempted for a stored Facebook or Instagram comment through any path fails permanently
      with a clear reason and is never retried, because `engagement-send.ts` already refuses a
      provider whose declaration says `canReply: false` — this pins existing generic behaviour for the
      two new surfaces, no new code (US5 scenario 3, FR-036) — depends on T013, T020

**Checkpoint**: A member meeting a Meta comment with no reply box reads it as a deliberate limit.

---

## Phase 8: User Story 6 - An unconfirmed surface says so instead of guessing (Priority: P3)

**Goal**: The `unavailable` path stays built, tested and independently reversible per surface — the
safety valve the whole feature leans on, even though both surfaces ship readable on the evidence in
hand.

**Independent Test**: Declare a surface unavailable through `registerTestProvider` and assert no
account on it is ever claimed, the inbox's unavailable notice names the missing fact, and the other
surface still reads in the same run.

- [X] T038 [US6] Create `tests/integration/engagement/meta-unavailable.test.ts`: with one surface's
      test declaration carrying `unavailable: { reason, docsPath }` (contracts/meta-comment-surface.md
      §5), run the engagement-read section and assert zero Graph calls and zero claimed accounts for
      that surface; assert the inbox's unavailable notice (via `listEngagementAccounts`) names the
      stated reason and `docsPath`; assert the *other* surface still reads to completion in the same
      run (US6 scenarios 1–2, FR-006, FR-039) — depends on T013, T020, T017
- [X] T039 [P] [US6] Extend `tests/integration/engagement/scope-gate.test.ts`: a connected Facebook
      Page that has not reconnected (and so lacks `pages_read_user_content`) is not claimed by
      084's claim gate, causes zero Graph calls and zero credential decrypts, and is counted in
      `accountsSkippedNoPermission` rather than dropped silently; repeat for an Instagram account
      lacking `instagram_manage_comments` (US6 scenario 3, SC-009, FR-037) — depends on T013, T020,
      T016
- [X] T040 [P] [US6] Verify (no code change expected; file a follow-up task only if a gap is found)
      that `docs/engagement.md`'s unavailable-notice copy already surfaces a non-technical reason and
      documentation link for any `unavailable` declaration — this is existing 084 behaviour being
      exercised by a new provider, not new code (US6 scenario 4, part of FR-039)

**Checkpoint**: The safety valve is proven in both directions — both surfaces read today, and either
could flip to unavailable by one declaration field without the other noticing.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, the secret scan, the full regression proof, and recording what the
implementation learned beyond what documentation gave (FR-048).

- [ ] T041 [P] Update `docs/engagement.md`'s supported-platforms table (FR-046): per surface, what is
      read (comments only), that replying is not offered, and — only if either surface ends up
      shipping unavailable after T002's research edit — why
- [ ] T042 [P] Update `docs/engagement.md`'s platform-permissions section (FR-047): the permissions
      Facebook and Instagram now actually require (`pages_read_user_content`,
      `instagram_manage_comments`), what happens to an account that has not reconnected, and that the
      opt-in flag alone cannot widen a login configuration
- [ ] T043 [P] Update `docs/meta-setup.md`'s `#engagement` section: name `pages_read_user_content`
      and `instagram_manage_comments`, and what a reconnect grants, matching the `docsPath` both
      declarations point at (FR-038)
- [ ] T044 [P] Add the four judgement-call entries from plan.md ("Four judgement calls") to
      `docs/decisions.md`, each with its stated reversal, if not already recorded there by an earlier
      phase of this feature
- [ ] T045 Update `docs/research/engagement.md` with anything T009–T034 learned that documentation
      alone did not give, recorded as an assumption rather than a confirmed fact — at minimum the
      three plan.md and contracts/research-section-2-additions.md §7 already name (undocumented
      default ordering of both listings and of Instagram's comments edge; the ambiguity in
      Instagram's "owns" rule; nested paging cursors being documented in general terms, not for the
      comments edge specifically) plus any other gap the implementation met (FR-048)
- [ ] T046 [P] Extend `tests/integration/security/secret-scan.test.ts` to cover the two new surfaces'
      error messages, attempt summaries, activity entries and stored `provider_data` — never narrowed
      (FR-023, FR-034, SC-007) — depends on T013, T020
- [ ] T047 [P] Run `src/providers/bluesky/engagement.test.ts` and every existing file under
      `tests/integration/engagement/` and confirm every 077 and 084 engagement test passes with **no
      edits** to those files — an edit needed here means something generic changed that this feature
      promised not to change (spec Out of Scope: "Changing the engagement seam") — depends on T003
- [ ] T048 Run the final pass once, per quickstart.md: `pnpm lint && pnpm typecheck && pnpm test`
      (synchronously, to completion; the local suite runs over an hour and local green is weaker than
      CI green, so this gates the implement phase's own completion, not every individual task) —
      depends on all preceding tasks

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Setup. **Blocks every user story** — T002 (the §2 edit)
  must land before any task in Phase 3 onward touches reading code (FR-001); T003/T004 (the
  scheduler fix) must land before any sweep integration test, because the catch-up cannot advance
  without it.
- **User Story 1 (Phase 3)**: Depends on Foundational. Builds the shared Meta layer
  (`engagement-state.ts`, `engagement-errors.ts`, `engagement-map.ts`, `engagement-sweep.ts`) that
  every later story extends rather than duplicates.
- **User Story 2 (Phase 4)**: Depends on Foundational and on US1's shared-layer files existing
  (T009, T011) — it adds the Instagram declaration and the `prefetchSelf` behaviour, not a second
  sweep.
- **User Story 3 (Phase 5)**: Depends on Foundational and on US1's sweep (T011) and end-to-end test
  (T019) existing to extend.
- **User Story 4 (Phase 6)**: Depends on Foundational and on US1's sweep (T011), error mapping
  (T008) and end-to-end test (T019).
- **User Story 5 (Phase 7)**: Depends on US1 and US2's provider declarations existing (T013, T020)
  so there is a stored comment to open; otherwise independent of US3/US4.
- **User Story 6 (Phase 8)**: Depends on US1 and US2's declarations (T013, T020) and the registry
  assertions (T017).
- **Polish (Phase 9)**: Depends on all desired user stories being complete.

### Within Each User Story

- Shared Meta layer before provider declarations before registry wiring before end-to-end tests.
- Unit tests (no HTTP) before or alongside the module they cover; mocked-HTTP provider tests after
  the sweep exists; integration tests last within a story.

### Parallel Opportunities

- T005–T008 (state schema, error mapping, and their tests) can run in parallel — different files,
  no dependency between them.
- T014, T018 can run in parallel with each other once their prerequisites land.
- T021, T024 (Instagram-specific tests) can run in parallel with each other.
- T031–T034 (US4's four test extensions) can run in parallel with each other once T030 lands.
- T041–T044, T046 (documentation and secret-scan) can run in parallel with each other and with
  US5/US6 work, since none shares a file.

---

## Parallel Example: Phase 2 (Foundational)

```bash
# T002 (research edit) has no code dependency and can run alongside T003:
Task: "Apply the §2 edit to docs/research/engagement.md per research-section-2-additions.md"
Task: "Fix the provider-state discard in src/server/scheduler/engagement-read.ts"
```

## Parallel Example: User Story 1's shared layer

```bash
Task: "Create src/providers/meta/engagement-state.ts"
Task: "Create src/providers/meta/engagement-errors.ts"
# Both land before engagement-map.ts and engagement-sweep.ts, which depend on them.
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational — the §2 edit and the scheduler fix. **Do not skip either**: FR-001
   forbids code before the facts, and FR-033 is why the catch-up (US3) can work at all, even though
   US1 alone does not exercise catch-up.
3. Complete Phase 3: User Story 1 — the shared Meta layer plus Facebook's declaration.
4. **STOP and VALIDATE**: `pnpm vitest run src/providers/facebook/engagement.test.ts
   src/providers/meta/engagement-map.test.ts tests/integration/engagement/meta-read.test.ts` per
   quickstart.md US1.
5. This is a shippable increment: one Facebook comment reaches the inbox, once, attributed correctly.

### Incremental Delivery

1. Setup + Foundational → facts settled, scheduler defect fixed.
2. Add US1 → Facebook reads comments → validate → that alone is already most of the shared layer.
3. Add US2 → Instagram reads comments, proving the shared layer generalises → validate.
4. Add US3 → catch-up reaches history and stops → validate.
5. Add US4 → the budget and back-off are proven → validate.
6. Add US5 → the not-repliable wording reads as a limit, not a fault → validate.
7. Add US6 → the unavailable safety valve is proven in both directions → validate.
8. Phase 9 → documentation, the extended secret scan, the full regression pass, and FR-048's
   assumption log.

### No task here needs a browser, a live Meta app or a second person

Every task in this list runs headless against mocked HTTP or local Postgres (FR-044, FR-045,
quickstart.md). There is deliberately no human-owned verification task to park: the feature's own
spec requires mocks-only verification, and the quickstart names in its closing section exactly what
the mocks cannot prove (default listing order; whether `pages_read_user_content` is in fact what the
comments edge demands) — both are recorded as assumptions in T045, not deferred as open tasks.
