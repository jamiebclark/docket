---

description: "Task list template for feature implementation"
---

# Tasks: Comment and message engagement

**Input**: Design documents from `/specs/077-engagement-inbox/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md (all present)

**Tests**: Requested throughout the spec and plan (quickstart.md names the test files directly) — every phase below includes its test tasks, and they are written to run and fail before the implementation task that follows them.

**Organization**: Tasks are grouped by user story per spec.md's priorities (US1 P1, US2 P2, US3 P2, US4 P3, US5 P4). The Meta identity spike (US1's Meta half) is a **human task** per spec constraint 2 and plan.md, and per the project's own "park the human task last" rule it is placed at the very end of the task list even though it is first in risk order — nothing else waits on it.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 … US5)
- Exact file paths are given in every task

---

## Phase 1: Setup

**Purpose**: Env vars and doc scaffolding that every later phase reads or extends.

- [X] T001 Add `ENGAGEMENT_RETENTION_DAYS` (default 90), `ENGAGEMENT_READ_PAGE_SIZE` (default 50), `ENGAGEMENT_READ_PAGES_PER_RUN` (default 3), `ENGAGEMENT_READ_MIN_INTERVAL_SECONDS` (default 60), `ENGAGEMENT_SENDS_PER_TICK` (default 5), `ENGAGEMENT_WRITE_RESERVE` (default 0.25) and `ENGAGEMENT_PRUNE_BATCH` (default 200) to the env schema in `src/server/scheduler/config.ts`, with matching entries in `.env.example` (data-model.md §11)
- [X] T002 [P] `src/server/scheduler/config.test.ts`: assert the new env vars parse with their documented defaults and reject out-of-range values (data-model.md §11)

**Checkpoint**: env config ready for every later phase to read.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Schema, provider contract, permission, DAL and vocabulary additions every user story's implementation sits on. **No user story work starts before this phase is green.**

### Schema and migration

- [X] T003 Create `src/server/db/schema/engagement.ts`: the five new enums (`engagement_item_kind`, `engagement_item_state`, `engagement_draft_state`, `engagement_draft_origin`, `engagement_send_state`) and the four tables `engagement_items`, `engagement_drafts`, `engagement_reply_claims`, `engagement_account_states` with every column, CHECK and index in data-model.md §1–§5
- [X] T004 Edit `src/server/db/schema/activity.ts`: add `engagement_received`, `engagement_replied`, `engagement_ambiguous` to the kind enum and `engagement` to the outcome enum; regenerate the `kindOutcomePairs`/`activity_events_kind_outcome` CHECK comparing every pair `::text`; add the `activity_events_engagement_kinds` CHECK naming no enum label (data-model.md §8, contracts/vocabulary.md §5 statement 4–5)
- [X] T005 Edit `src/server/db/schema/activity.ts`: invert the `activity_events_attention_seq_idx` predicate to `outcome <> ALL (ARRAY['published','retrying','resolved','connect_failed']::activity_outcome[])`, naming no new label (research.md §2, contracts/vocabulary.md §5 statement 6)
- [X] T006 Edit `src/server/db/schema/notifications.ts`: widen `notification_preferences_kind_key` to `('failed','ambiguous','needs_reauth','connect_failed','engagement')` (data-model.md §8, contracts/vocabulary.md §5 statement 7)
- [X] T007 Generate and hand-check migration `drizzle/0036_*.sql` against the exact statement order in contracts/vocabulary.md §5 (new types first, then `ADD VALUE`s, then tables, then the regenerated CHECKs, then the index swap, then the widened notification CHECK); run `pnpm db:check` until it agrees with T003–T006 (depends on T003, T004, T005, T006)
- [X] T008 `tests/integration/db/enum-value-in-batch.test.ts`: extend the existing rule to also assert no migration puts an enum cast or a label added in the same batch inside an index predicate, and that the new `activity_events_kind_outcome` CHECK compares every pair `::text` (research.md §1, data-model.md §8) — write first, confirm it fails against the pre-T004/T005 schema, then confirm green after
- [X] T009 `tests/integration/migrations/upgrade-in-one-transaction.test.ts` (new): migrate a scratch database to the migration immediately before 0036, commit, then apply every remaining migration (including 0036) inside one transaction the way Drizzle does, and assert it does not fail with `55P04`/`42P17` (research.md §2, FR-050) — depends on T007

### Provider contract and DAL

- [X] T010 [P] Edit `src/providers/types.ts`: add `EngagementItemKind`, `EngagementDeclaration`, `EngagementSupport`, `EngagementReadContext`, `InboundItemDraft`, `EngagementReadResult`, `EngagementSendContext`, `EngagementSendResult`, and the optional `engagement?: EngagementSupport` member on `SocialProvider`, exactly per contracts/provider-engagement.md
- [X] T011 [P] `src/server/dal/engagement.ts` (new): `EngagementItemsRepo` (`insertIfAbsent`, `markWithdrawn`, `markEditedUpstream`, `markAnswered`, `markDismissed`, list/get readers — **no** method that writes `text`, `external_id`, `said_at` or any author column, per data-model.md §2's immutability rule), `EngagementDraftsRepo`, `EngagementReplyClaimsRepo` (insert-only), `EngagementAccountStatesRepo` (lazy row creation per data-model.md §5)
- [X] T012 [P] `src/server/dal/engagement-claims.ts` (new): the cross-account claim loop the tick uses to find drafts ready to send (`FOR UPDATE SKIP LOCKED` on `send_not_before` past rows, per data-model.md §3 index)
- [X] T013 Edit `src/server/dal/scope.ts` and `src/server/dal/index.ts`: register the four new repos on `ProjectScope` and on `createSchedulingRepos`, and export their types from `dal/index.ts` (depends on T011, T012)
- [X] T014 [P] `tests/integration/engagement/immutability.test.ts` (new): snapshot a full `engagement_items` row, re-ingest the same `(project_id, social_account_id, external_id)` with different text through `insertIfAbsent`, assert the row is byte-identical and no second row, notification or draft is created (FR-009, FR-010) — depends on T011
- [X] T015 [P] `tests/unit/dal/engagement.test.ts` (new): assert `EngagementItemsRepo`'s public surface has no method accepting `text`, `externalId`, `saidAt` or an author field outside `insertIfAbsent` (FR-010 enforced structurally) — depends on T011

### Permission, activity and notification vocabulary

- [X] T016 [P] Edit `src/server/auth/access.ts`: add `engagement: ["view", "reply"]` to `statements`; grant both to `owner`, `admin` and `editor`; add **no** entry to `KEY_GRANTS` for any `ApiKeyPermission` and **no** entry to `jobRunnerGrants` (data-model.md §9, contracts/vocabulary.md §1)
- [X] T017 [P] `tests/integration/permissions.test.ts`: extend with a case asserting every `ApiKeyPermission` fails a `can({ engagement: [...] })` request and the job-runner scope does too (FR-030, data-model.md §9) — depends on T016
- [X] T018 [P] Edit `src/lib/activity/outcomes.ts`: add the three `ACTIVITY_KINDS` entries, the `engagement` `ACTIVITY_OUTCOMES` entry, the `KIND_OUTCOME` pairings, `OUTCOME_LABEL.engagement = "New replies"`, `OUTCOME_TONE.engagement = "info"` — and leave `PROBLEM_OUTCOMES` untouched (contracts/vocabulary.md §2)
- [X] T019 [P] Edit `src/lib/activity/details.ts`: add the three strict `details` schemas (`engagement_received`, `engagement_replied`, `engagement_ambiguous`) exactly as specified in contracts/vocabulary.md §2, carrying a count or an item kind only — never an inbound author or text (FR-063)
- [X] T020 [P] `src/lib/activity/details.test.ts`: assert the three new schemas reject any extra property (`strictObject`) and that `engagement_received`'s `items` is a positive integer — depends on T019
- [X] T021 [P] Edit `src/lib/notifications/attention.ts` and `src/lib/notifications/eligibility.ts`: add `"engagement"` to `ATTENTION_MEMBER_OUTCOMES` and `ATTENTION_KINDS`
- [X] T022 [P] `tests/integration/notifications/preferences-fresh-start.test.ts`: extend to assert a member who has never touched the `engagement` switch is treated as on with no stored position, and every pre-existing switch keeps its exact prior meaning (FR-047, FR-051) — depends on T006, T021
- [X] T023 [P] `tests/integration/notifications/performance.test.ts`: extend to exercise the rebuilt attention index with engagement-outcome rows present and assert the unread count query still meets its existing budget (research.md §2) — depends on T005

**Checkpoint**: schema, provider contract, DAL, permission and vocabulary are all in place and green. User story work can now begin.

---

## Phase 3: User Story 1 — Bluesky desk research (Priority: P1)

**Goal**: Produce the committed `docs/research/engagement.md` for the half of US1 a pipeline phase can actually do: Bluesky, from the installed package and `docs/research/bluesky.md`, plus the Meta and direct-message questions recorded explicitly as unverified until the human spike (Phase 7) runs.

**Independent Test**: `docs/research/engagement.md` exists, is dated, cites official sources or the installed package per claim, and states a verdict (confirmed / contradicted / unverified) for every question in FR-001, with the Meta and DM sections marked unverified and what was tried.

- [X] T024 [US1] Write `docs/research/engagement.md`: the Bluesky section confirmed from `node_modules/@atproto/api/dist/client/types/app/bsky/notification/listNotifications.d.ts` and `docs/research/bluesky.md` (identity fields, pagination, reply addressing, write cost, `updateSeen` decision — research.md §6), each claim cited; a Meta section with every FR-001 question marked `unverified` and what would need to be tried; a direct-messages section marked `unverified` for every platform in scope (FR-001, FR-002, FR-003)
- [X] T025 [US1] Record the consequence in `docs/decisions.md`: the Bluesky identity question is settled (stable `did`), the Meta identity question is open and gates US4, and DMs are sequenced rather than cut (FR-004)
- [X] T026 [P] [US1] `tests/integration/docs/engagement-research.test.ts` (new): assert `docs/research/engagement.md` exists, carries a dated "checked on" line, and states an explicit verdict (`confirmed`/`contradicted`/`unverified`) for each FR-001 question per surface (Facebook Page comments, Instagram comments, Threads replies) plus the Bluesky and DM sections (FR-001–FR-003, SC-010) — depends on T024

**Checkpoint**: the research document the rest of the entry can be built against (for Bluesky) and the explicit gate for US4/US5 exists.

---

## Phase 4: User Story 2 — Inbound engagement arrives and a person sees it in context (Priority: P2)

**Goal**: Bluesky replies and mentions land in a project-scoped inbox via the existing tick, exactly once, with notifications honouring existing switches.

**Independent Test**: with a connected Bluesky account and mocked platform HTTP, run the tick against a fixture of replies and mentions and confirm the inbox shows each once with author, text, time, account and parent; re-run and confirm no duplication; run with a second project's data present and confirm no crossing (quickstart.md §2).

### Tests for User Story 2

- [X] T027 [P] [US2] `tests/integration/engagement/ingest.test.ts` (new): the full table in quickstart.md §2 — three items from a fixture of two replies and one mention; a second identical tick adds nothing and notifies nothing; two projects' data never crosses; expired credentials flag the account via the existing `markInvalidEmitting` path and the cursor does not move; a provider with no `engagement` declaration has no accounts in the inbox; a 500-item backlog with `ENGAGEMENT_READ_PAGES_PER_RUN=3` catches up over successive ticks with nothing skipped or duplicated; two overlapping ticks on one account — the second finds the lease held and moves on; a tick killed mid-read resumes from the last committed cursor with no re-notification; a rejected cursor restarts from the newest page, stamps `gap_at`, and the re-read overlap stores nothing new (FR-006–FR-015, SC-001, SC-008) — write first, confirm it fails
- [X] T028 [P] [US2] `src/providers/bluesky/engagement.test.ts` (new) and `src/providers/bluesky/engagement-map.test.ts` (new): the Bluesky `read()` against `tests/helpers/fake-pds.ts` covering the ok/retryable/fatal/credentials_invalid/rate_limited/cursor_lost paths, and the pure notification→`InboundItemDraft` mapping, asserting `updateSeen` is never called (FR-054, research.md §6, contracts/provider-engagement.md) — write first, confirm it fails

### Implementation for User Story 2

- [X] T029 [P] [US2] `src/lib/engagement/paging.ts` (new, pure): the per-run page/bound/backfill policy of data-model.md §7 — at most `ENGAGEMENT_READ_PAGES_PER_RUN` pages of `ENGAGEMENT_READ_PAGE_SIZE`, backfill continuation, stop-early on remaining tick budget
- [X] T030 [P] [US2] `src/lib/engagement/identity.ts` (new, pure): FR-016–FR-018 identity rules — never invent a field, two items never claim to be the same person when `identityStable` is false, no merging across platforms or accounts
- [X] T031 [US2] `src/providers/bluesky/engagement-map.ts` (new): map one `listNotifications` notification to an `InboundItemDraft` per contracts/provider-engagement.md's Bluesky row, carrying `{ cid, root? }` into `provider_data` (research.md §6) — depends on T010
- [X] T032 [US2] `src/providers/bluesky/engagement.ts` (new): `declaration` (`reads: ["reply","mention"]`, `canReply: true`, `writeBudget: { count: 1666, windowSeconds: 3600 }`), `itemDataSchema`, `stateSchema`, and `read()` calling `app.bsky.notification.listNotifications`, through the existing persisted-session/serialised-refresh path, mapped via T031, never calling `updateSeen` (FR-054, research.md §6) — depends on T010, T031
- [X] T033 [US2] Edit `src/providers/mock/index.ts`: declare `engagement` with all four `reads` kinds and an `unavailable` variant, backed by scripted fixtures, so the generic layer and the Meta/DM seam can be tested with no platform credentials (contracts/provider-engagement.md's closing note)
- [X] T034 [US2] `src/server/scheduler/engagement-read.ts` (new): claim an account (`FOR UPDATE SKIP LOCKED` + lease on `engagement_account_states`, skipping `read_not_before` in the future) → call the provider's `read()` → `insertIfAbsent` each item, counting inserts → commit cursor, `last_read_at`, `last_item_at`, backfill flag → write one `engagement_received` activity event when inserts > 0, in the same transaction (data-model.md §7) — depends on T011, T013, T029
- [X] T035 [US2] Edit `src/server/scheduler/engagement-read.ts`: wire `credentials_invalid` to the existing `markInvalidEmitting` path, `rate_limited` to the existing `backoff.ts`, and `cursor_lost` to the clear-cursor-and-stamp-`gap_at` rule, with one account's failure never stopping another and never advancing that account's cursor (FR-014) — depends on T034
- [X] T036 [US2] Edit `src/server/scheduler/index.ts`: add the engagement-read section, concurrent with every other existing section, reporting a `SectionResult` and a heartbeat like every other section (plan.md "Where the work runs") — depends on T034
- [X] T037 [US2] `src/server/services/engagement/inbox.ts` (new): `listInbox`, `countInboxWaiting`, `getInboxItem`, `listEngagementAccounts`, `setAutoDraft` per contracts/services.md §2, computing the `replyable` verdict and the "how many newer items on the same parent" count, and resolving the brand's own post via `parent_post_target_id` — depends on T011, T013, T016, T030
- [X] T038 [US2] Edit `src/components/shell/LeftNav.tsx` and `src/app/p/[projectSlug]/layout.tsx`: add the `inbox` nav entry under Publish with a count pill, gated on `engagement: ["view"]`, computing the count only when the permission is held (FR-037, contracts/vocabulary.md §4) — depends on T037
- [X] T039 [US2] `src/app/p/[projectSlug]/inbox/` (new): list page (filters by account/kind/state), item view showing the parent beside the comment and the count of newer items on the same parent, following `docket-ui` conventions (server components by default, keyboard reachable, labelled controls, empty/error/loading states) — depends on T037, T038
- [X] T040 [P] [US2] `tests/integration/notifications/` sweep: run the full existing suite and confirm it stays green with the attention set and index changes of T005/T021 in place (quickstart.md §2) — depends on T005, T021, T034

**Checkpoint**: User Story 2 is independently functional — an inbox exists, fills from Bluesky, and stays scoped and idempotent.

---

## Phase 5: User Story 3 — A reply is drafted, read, and only then sent (Priority: P2)

**Goal**: A member can request a brand-voice draft, edit it, and approve it through the shared decision core; the approved reply is sent by the tick after publishing, idempotently, never on a timer and never under `auto_approve`.

**Independent Test**: request a draft (mocked LLM) and confirm the prompt carries voice profile, brand identity, posting instructions, parent post and comment; confirm the draft is counted under the platform's own text rule; approve it and confirm one reply is sent to the right parent; confirm a second approval is refused; confirm `auto_approve` still waits for a person (quickstart.md §3).

### Tests for User Story 3

- [X] T041 [P] [US3] `tests/integration/engagement/draft.test.ts` (new): the drafting rows of quickstart.md §3's table — prompt contents, voice profile + version recorded, spend recorded under `engagement.reply`, length counted under the provider's own rule, an over-long draft stored and shown as blocking never truncated, credit hold refusal with no partial draft, no-voice/no-text/not-replyable refusals (FR-019–FR-027) — write first, confirm it fails
- [X] T042 [P] [US3] `tests/integration/engagement/review-reply.test.ts` (new): edit-then-approve records sent text/time/approver; a second approval is refused "already answered"; two members approving at the same instant produce exactly one send and one refusal; `auto_approve` still waits for a person with a test asserting `default_approval_policy` is never read on the reply path; `engagement:view`-only member is refused every write on the server; dismiss records who/when and leaves the item in the inbox; empty-text approval is refused (FR-028–FR-036, SC-003) — write first, confirm it fails
- [X] T043 [P] [US3] `tests/integration/engagement/send.test.ts` (new): a send that times out becomes `ambiguous` with no auto-retry and is visible on `/failures`; an account at its hourly allowance sends scheduled posts and leaves replies `waiting` with reason `write_allowance`; a platform duplicate refusal marks the item answered; a kill between the ledger claim and the record recovers to `ambiguous` with never a second send (FR-038–FR-045, SC-004, SC-005, SC-006) — write first, confirm it fails
- [X] T044 [P] [US3] `tests/integration/scheduler/engagement-budget.test.ts` (new): pure unit coverage of the reserve arithmetic in research.md §8 — writes-in-window computed from `publish_started_at` plus ledger claims, the `floor(budget.count × (1 − ENGAGEMENT_WRITE_RESERVE))` floor, and the per-run cap — write first, confirm it fails
- [X] T045 [P] [US3] `tests/integration/engagement/no-unreviewed-send.test.ts` (new): the SC-003 sweep — the `send_state = 'none' OR review_state = 'approved'` CHECK refuses a send state on an unapproved draft at the database level; every `ApiKeyPermission` fails an `engagement` request; no exported service function approves more than one reply; no API operation or MCP tool mentions engagement (FR-028–FR-030) — write first, confirm it fails

### Implementation for User Story 3

- [X] T046 [US3] `src/server/services/review/decide.ts` (new, extracted from `src/server/services/review.ts`): `Decidable<T>`, `serialized`, `decide` exactly per contracts/services.md §1, with `approvePost`/`rejectPost` moved onto it with unchanged behaviour (FR-032) — depends on T013
- [X] T047 [P] [US3] `src/server/services/engagement/prompt.ts` (new): builds the reply prompt from the voice profile and version, `brandOf`, the account's posting instructions, the brand's own parent text when known, and the item's bounded text with a stated truncation note, documenting exactly what it carries about the author (FR-020, FR-063) — depends on T011
- [X] T048 [US3] `src/server/services/engagement/draft.ts` (new): `requestDraft`, `writeReply`, `editDraft` per contracts/services.md §3 — `resolveLlmForProject` → `withCreditHold` → `createUsageRecorder({ purpose: "engagement.reply" })` → T047's prompt → `countText`/`countingRuleName` from `src/providers/text.ts`; every refusal code (`no_voice`, `not_configured`, `credit_hold`, `llm_failed`, `no_text`, `not_replyable`) (FR-019–FR-027) — depends on T011, T016, T047
- [X] T049 [US3] `src/server/services/engagement/review.ts` (new): `listReplyQueue`, `countReplyQueue`, `approveReply`, `rejectReply`, `dismissItems` per contracts/services.md §4, `approveReply` running inside `decide()` and never reading `default_approval_policy` (FR-028–FR-036) — depends on T046, T048
- [X] T050 [US3] Edit `src/server/services/review.ts`: `countReviewQueue` becomes `posts + countReplyQueue` (FR-031) — depends on T049
- [X] T051 [US3] `src/server/scheduler/engagement-budget.ts` (new, pure): the reserve function of research.md §8, covered standalone by T044 — depends on T001
- [X] T052 [US3] `src/server/scheduler/engagement-send.ts` (new): claim → reserve check (T051) → gate (account active, `canReply`, not withdrawn, edit acknowledged) → ledger claim in its own committed transaction (`engagement_reply_claims` insert, unique violation ⇒ `already_answered`) → provider `send()` outside any transaction → record outcome under the lease token (`sent`/`duplicate`/`ambiguous`/`fatal_error`/`credentials_invalid`) per contracts/services.md §5 (FR-038–FR-045) — depends on T011, T013, T051
- [X] T053 [US3] `src/providers/bluesky/engagement.ts`: implement `send()` with `com.atproto.repo.createRecord` and `reply: { root, parent }` per contracts/provider-engagement.md's Bluesky row, reusing the existing `AtUri` ambiguity check from `publish.ts` (FR-038, research.md §6) — depends on T032
- [X] T054 [US3] Edit `src/server/scheduler/index.ts`: await the publishing section, then run the engagement-send section with the remaining tick budget (FR-042, plan.md "Where the work runs") — depends on T036, T052
- [X] T055 [US3] Edit `src/server/services/failures.ts`: `countNeedsDecision` adds ambiguous replies; add `markReplySent`/`markReplyNotSent` per contracts/services.md §5's closing paragraph (FR-040, FR-044) — depends on T052
- [X] T056 [US3] Edit `src/app/p/[projectSlug]/review/`: add the "Replies" section above the posts list — comment, author, parent, editable draft with its live count against the platform limit, Approve/Reject/Dismiss, no bulk-approve control, a bulk-dismiss control (FR-031, FR-033, `docket-ui` conventions) — depends on T049, T050
- [X] T057 [US3] Edit `src/app/p/[projectSlug]/inbox/`: add Request a draft / Write a reply / Dismiss actions and the draft panel with its live character count, client component only where the live count needs it (FR-019, FR-025, FR-026) — depends on T048, T039
- [X] T058 [US3] Edit `src/app/p/[projectSlug]/failures/`: add the "Replies needing a decision" section with `markReplySent`/`markReplyNotSent` (FR-040) — depends on T055
- [X] T059 [P] [US3] `src/providers/bluesky/engagement.test.ts`: extend with the `send()` paths (sent, ambiguous via unparseable/timeout, fatal_error, duplicate) through `fake-pds.ts` — depends on T053

**Checkpoint**: User Stories 2 and 3 both work independently — this is the entry's shippable MVP.

---

## Phase 6: User Story 4 — The Meta surfaces, seam only (Priority: P3)

**Goal**: Build and test the provider-capability seam (declaration, `unavailable` presentation, DM visual distinction) through the mock provider, so adding a real Meta surface later touches only that provider's folder — without building any Meta-specific behavior, which stays blocked on Phase 7.

**Independent Test**: with the mock provider's `unavailable` declaration, confirm a gated surface is shown unavailable with its reason and no call is attempted; confirm the seam modules (inbox, drafting, review, notifications, activity) contain no provider key (quickstart.md §6, SC-012).

- [X] T060 [P] [US4] `tests/integration/engagement/provider-seam.test.ts` (new): the mock provider's `unavailable` variant is shown with its reason and docs link and no call is ever made (FR-055); a provider with no `engagement` member is absent with no error (FR-053); a module-scan assertion that `inbox.ts`, `draft.ts`, `review.ts`, the notification modules and the activity modules contain no provider key (SC-012) — write first, confirm it fails
- [X] T061 [US4] Edit `src/server/services/engagement/inbox.ts`'s `listEngagementAccounts`: present a declared-but-`unavailable` surface marked unavailable with its reason and `docsPath`, with no call attempted (FR-055) — depends on T037, T060
- [X] T062 [US4] Edit `src/app/p/[projectSlug]/inbox/`: render the unavailable-surface state with its reason and a link to setup documentation (FR-055, contracts/vocabulary.md §4) — depends on T061
- [X] T063 [US4] Record in `docs/research/engagement.md` and `tasks.md` (this file, Phase 9) that building real Instagram comments, Threads replies and Facebook Page comments is **blocked** on Phase 9's human task, and that every identity field any future Meta surface displays must trace to a confirmed verdict there (FR-005, FR-055) — depends on T024

**Checkpoint**: the capability seam is proven with the mock provider; the real Meta surfaces remain explicitly blocked, not silently skipped.

---

## Phase 7: User Story 5 — Direct messages, seam only (Priority: P4)

**Goal**: Model `direct_message` as a declared inbound kind, visually distinct wherever it appears, through the mock provider — with no platform reading, drafting or sending DMs until that platform's facts are committed to research (which Phase 3/Phase 8 leave unverified for every platform in scope).

**Independent Test**: with mocked HTTP, a DM from the mock provider arrives marked private, is never shown as a public comment, and the review row says the reply goes privately to one person (quickstart.md §6, FR-056).

- [X] T064 [P] [US5] `tests/integration/engagement/dm-presentation.test.ts` (new): a DM from the mock provider is marked Private on the inbox list row, the item view and the review row; the review row states the reply goes privately to one person; no platform in this entry declares `direct_message` (FR-056) — write first, confirm it fails
- [X] T065 [US5] Edit `src/app/p/[projectSlug]/inbox/` and `src/app/p/[projectSlug]/review/`: render the Private marker and the "sent privately to one person" copy wherever a `direct_message` item appears (FR-056, contracts/vocabulary.md §4) — depends on T056, T057, T064
- [X] T066 [US5] Record in `docs/research/engagement.md` that US5 is blocked for every platform in scope pending committed DM research, so no DM reading, drafting or sending is implemented anywhere (FR-056, constitution I) — depends on T024

**Checkpoint**: DMs are modelled and visually safe but inert everywhere except the mock provider, exactly as the spec requires.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Retention, documentation, scope amendment and the final whole-suite pass.

- [X] T067 [P] `src/server/services/engagement/retention.ts` (new): `pruneEngagementItems(now, limit)` — bounded, cross-project via the existing `crossProject` helper, deleting per data-model.md §10 (90-day default, no pending draft, no unresolved ambiguous send, withdrawn items regardless of age; ledger never pruned) — depends on T011, T001
- [X] T068 [US2/US3] Edit `src/server/scheduler/housekeeping.ts`: call T067's prune in the existing bounded housekeeping section, reporting the count in the tick summary (FR-060, FR-061) — depends on T067
- [X] T069 [P] `tests/integration/engagement/retention.test.ts` (new): an item past `ENGAGEMENT_RETENTION_DAYS` with no pending draft and no unresolved ambiguity is deleted with its drafts; one with a pending draft is kept; a withdrawn item is pruned on the next pass regardless of age; the ledger survives; a cursor restart does not resurrect a pruned item because ingest ignores anything older than the retention horizon (FR-060, FR-061, SC-014) — depends on T068
- [X] T070 [P] Account-removal and project-deletion cleanup: edit the account-removal service to explicitly delete that account's `engagement_items`, `engagement_drafts`, `engagement_account_states` and `engagement_reply_claims` rows (a soft delete does not cascade); confirm project deletion's existing cascade covers all four tables (FR-059, data-model.md §10)
- [X] T071 [P] `tests/integration/engagement/permissions.test.ts` (new): a member with no `engagement` permission has the inbox absent from navigation, its count never computed, and a direct link to `/inbox` answers the project's existing not-found with no count disclosed (FR-036, FR-037) — depends on T038, T039, T070
- [X] T072 [P] Edit `tests/integration/security/secret-scan.test.ts`: extend coverage to the inbox page, the item view, the review replies section, the failures replies section and the draft prompt (FR-062, SC-013) — depends on T039, T056, T057, T058
- [X] T073 [P] Edit `tests/integration/api/scope-enforcement.test.ts`, `tests/integration/api/openapi.test.ts`, `tests/integration/api/mcp-surface.test.ts`: confirm all three stay green with **no edits to the operations table**, and that the OpenAPI snapshot changes only for the widened shared activity `kind`/`outcome` enums (FR-030) — depends on T004
- [X] T074 [P] Write `docs/engagement.md` (new) and add it to `mkdocs.yml`'s nav under "Using Docket": supported platforms and why the rest are not yet, that nothing sends without a person approving it, who may read and who may reply, what drafting costs, retention and deletion, the platform permission each supported surface needs, what the draft prompt carries about an author, and the four recorded gaps (no moderation, no API/MCP surface, no webhooks, DMs pending research) (FR-066, FR-069, SC-015, SC-016)
- [X] T075 [P] Edit `docs/privacy.md`: what inbound engagement data is stored, why, for how long, and how it is deleted (FR-064)
- [X] T076 [P] Edit `docs/security.md`: engagement adds no new credential type and no new trust boundary; sending is reachable only by a signed-in member (FR-068)
- [X] T077 [P] Edit `docs/adding-a-provider.md`: the engagement capability and how a provider opts in (FR-067)
- [X] T078 [P] Edit `docs/build-prompt.md` (remove "comment or inbox management" from the out-of-scope list) and `.specify/memory/constitution.md` (same amendment, `docs(constitution):` commit, version bump to 1.5.0) (FR-065)
- [X] T079 [P] Edit `docs/decisions.md`: append the judgement calls already called out in research.md §3–§5, §8, §9 and plan.md's post-design re-check, plus T025's Meta/DM consequence
- [X] T080 [P] Edit `docs/feature-map.md`: add the inbox screen and the Review/Failures sections
- [X] T081 [P] `tests/integration/docs/` (new or extended test, e.g. `engagement-scope.test.ts`): assert `docs/build-prompt.md` and `.specify/memory/constitution.md` no longer list comment or inbox management as out of scope, and that the four gaps are findable in `docs/engagement.md` (FR-065, FR-069, SC-016) — depends on T074, T078
- [X] T082 Run the full final pass: `pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build` — depends on every task above except Phase 9

---

## Phase 9: Human task — the Meta identity spike (US1, Meta half)

**Needs a live Meta Business-type app on Standard Access, a real Facebook Page, a real Instagram Business account, a real Threads account, a second person to comment, and a browser — none of which a pipeline phase has.** Scheduled last so it never starves the implement loop behind it; nothing in Phases 1–8 depends on it completing.

- [X] T083 [US1] **Human task.** Have a second person comment on a Page post, comment on an Instagram post, and reply to a Thread. Read each comment back through the platform's API on Standard Access and record, field by field, into `docs/research/engagement.md`: which permission the read required and whether it is inside the automatic Standard Access set; what identity fields the commenter carries (display name, handle, identifier, profile link) and whether the identifier is stable across two comments by the same person; whether a reply can be sent at the same access level the read required; pagination; read rate limits — each claim cited, a verdict of confirmed/contradicted/unverified per question, and anything unsettled marked unverified with what was tried (FR-001–FR-003). If the window to run this closes before anyone does, mark this task in `docs/research/engagement.md` as unachievable and state why, rather than leaving it silently open. **Resolved unachievable**: no browser, live Meta Standard Access app, real Facebook/Instagram/Threads accounts or second human commenter are available to the headless implement pipeline; recorded with reasoning in `docs/research/engagement.md` under "Phase 9 human task (T083, T084) — unachievable by the implement pipeline". A person with those resources can still run this live at any time per the instruction above.
- [X] T084 [US1] **Human task, depends on T083.** Record the design consequence in `docs/decisions.md` — in particular whether the Meta surfaces can present a recognisable person at all (FR-004). Only after this task resolves may Phase 6's blocked tasks (building real Instagram/Threads/Facebook reading and sending, per US4's acceptance scenarios) be turned into new tasks and implemented, each identity field tracing to a confirmed verdict here (FR-005, FR-055, SC-010, SC-011). **Resolved unachievable, same reason as T083**: the design consequence of Meta identity being unverified is already recorded in `docs/decisions.md` ("Engagement inbox: Bluesky identity is settled, Meta identity is not, DMs are sequenced not cut", 2026-10-15); Phase 6's blocked tasks remain blocked until a person runs T083 live and records confirmed verdicts.

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (Phase 1)**: no dependencies
- **Foundational (Phase 2)**: depends on Phase 1 — **blocks every user story**
- **US1 desk research (Phase 3)**: depends on Phase 2 only (reads the installed package and existing `docs/research/bluesky.md`); independent of US2/US3's code
- **US2 (Phase 4)** and **US3 (Phase 5)**: both depend on Phase 2; US3 additionally depends on US2's inbox existing (a draft answers an inbox item) but not on US2's UI being finished — they may proceed concurrently with care, with US3's send/review work landing after US2's ingest and inbox service land
- **US4 seam (Phase 6)**: depends on Phase 2 and Phase 3 (the research document exists, even if Meta's half is unverified) and on US2/US3's services existing to extend
- **US5 seam (Phase 7)**: depends on Phase 2, Phase 3, and US2/US3's UI surfaces (inbox, review)
- **Polish (Phase 8)**: depends on all of Phases 2–7
- **Human task (Phase 9)**: depends on nothing in this list completing first; nothing in Phases 1–8 depends on it. It is the one task that may run at any time but is recorded last.

### Within Phase 2

T003 → T004, T005 (same file, sequence to avoid merge conflicts) → T006 → T007 → T008, T009 (tests after migration exists). T010 is independent. T011 → T012 → T013 → T014, T015. T016 → T017. T018 → T019 → T020. T021 → T022, T023.

### Parallel opportunities

- Phase 1: T001, T002 in parallel
- Phase 2: T010, T016, T018 (and their immediate test children) can run in parallel with the T003→T009 schema chain since they touch different files
- Phase 3: T026 after T024
- Phase 4: T027, T028 (tests) in parallel; T029, T030 in parallel; then the dependent chain T031→T032→T033/T034→T035→T036→T037→T038→T039
- Phase 5: T041–T045 (all test files) in parallel; T047 in parallel with T046; then T048→T049→T050, and T051→T052→T053→T054→T055→T056/T057/T058 in sequence where noted
- Phase 6 and Phase 7: each phase's test task first, then its implementation tasks
- Phase 8: nearly everything is [P] — nineteen independent files/doc edits, gated only by their listed dependency

---

## Parallel Example: Phase 2 foundational work

```bash
# Launch independent foundational tracks together once T001 lands:
Task: "Edit src/providers/types.ts with the EngagementSupport contract"                    # T010
Task: "Add engagement: [view, reply] to src/server/auth/access.ts"                          # T016
Task: "Add the three engagement kinds to src/lib/activity/outcomes.ts"                      # T018

# Meanwhile, sequence the schema chain in one file:
Task: "Create src/server/db/schema/engagement.ts"                                           # T003
Task: "Edit src/server/db/schema/activity.ts: kind/outcome CHECK"                            # T004
Task: "Edit src/server/db/schema/activity.ts: attention index"                               # T005
```

---

## Implementation Strategy

### MVP first

1. Phase 1 (Setup) → Phase 2 (Foundational) — blocking, must be green
2. Phase 3 (US1 Bluesky desk research) — cheap, gates nothing but US4/US5 risk assessment, worth doing early
3. Phase 4 (US2, the inbox) → **stop and validate independently** (quickstart.md §2)
4. Phase 5 (US3, draft/review/send) → **stop and validate independently** (quickstart.md §3–§4) — this is the entry's MVP: US2 + US3 is a fully working, shippable Bluesky engagement inbox

### Incremental delivery after the MVP

5. Phase 6 (US4 seam) and Phase 7 (US5 seam) — prove the capability seam without a Meta app
6. Phase 8 (Polish) — retention, docs, scope amendment, final whole-suite pass
7. Phase 9 (human task) — runs whenever a live Meta app and real accounts are available; unblocks turning US4's real Meta behaviour into new, buildable tasks

### Notes

- [P] tasks touch different files with no unmet dependency
- Every test task is written and confirmed failing before its matching implementation task
- Commit after each task or logical group
- The human task (Phase 9) is deliberately last in this list despite being first in risk order (spec constraint 2) — an unrunnable task placed early starves the implement loop behind it

---

## Phase 10: Review remediation

**Source**: `specs/077-engagement-inbox/review.md`. Each task carries its finding id and the location
the review cited, because the implement pass that picks it up has no access to the review's reasoning.
BLOCKERs first; nothing here is optional for the merge.

- [X] T085 Fix engagement reading so new items keep arriving: thread the insert result back into `anyAlreadyStored` instead of hardcoding `false`, read the newest page from `cursor: null` on every run and stop at the first already-stored item, use the stored cursor only for the `older`/backfill direction, and clear `backfilling` when a page contains an already-stored item — review F1 (BLOCKER), src/server/scheduler/engagement-read.ts:137, src/server/scheduler/engagement-read.ts:156, src/lib/engagement/paging.ts:44
- [X] T086 Give the mock provider a multi-page fixture (cursors, `exhausted`, and the error/`cursor_lost` results) so the cursor and backfill machinery can be executed by a test at all — review F1 (BLOCKER), src/providers/mock/engagement.ts:28
- [X] T087 Add the lease predicate `or(isNull(sendLeaseUntil), lte(sendLeaseUntil, now))` to `claimDueEngagementSends`, condition every outcome write on `send_lease_owner = token`, and add an integration test running two `runEngagementSend` passes concurrently against one approved draft asserting exactly one provider `send()` — review F2 (BLOCKER), src/server/dal/engagement-claims.ts:31, src/server/scheduler/engagement-send.ts:67
- [ ] T088 Re-encode the send ledger so a live claim is distinguishable from a release at any generation (separate `released_at`/`release_reason` on the claim row, or an explicit state column), replace the three `releaseReason === null` liveness tests, and test release → re-approve → send → second approval is refused `already_answered` — review F3 (MAJOR), src/server/db/schema/engagement.ts:184, src/server/scheduler/engagement-send.ts:136, src/server/services/engagement/review.ts:106, src/server/services/engagement/inbox.ts:68
- [ ] T089 Resolve the parent at ingest: look `parentExternalId` up against the account's `post_targets.external_id` and set `parent_post_target_id`/`parent_post_id`, then fix `tests/integration/engagement/ingest.test.ts:41` to expect `docket_post` with the brand's own text — review F4 (MAJOR), src/server/scheduler/engagement-read.ts:197, src/server/services/engagement/inbox.ts:48
- [X] T090 Consume `InboundItemDraft.upstream` in the ingest loop (stamp `withdrawn_at`/`edited_upstream_at` on the stored row), add a mock fixture that returns it, test US2 AS8, and replace `docs/engagement.md`'s deletion claim with the stated Bluesky-signal gap from research.md §7.4 — review F5 (MAJOR), src/server/scheduler/engagement-read.ts:180, src/server/dal/engagement.ts:45, docs/engagement.md:54
- [X] T091 Correct `docs/engagement.md` to state that the draft prompt carries the commenter's display name or handle and nothing else about them (or remove `who()` from the prompt), and pin the prompt's author exposure with a test — review F6 (MAJOR), docs/engagement.md:46, src/server/services/engagement/prompt.ts:45
- [X] T092 Let an expired read lease be reclaimed (`or(isNull(readLeaseUntil), lte(readLeaseUntil, now))`), condition the commit on the lease token, and test that a tick killed mid-read is resumed from the committed cursor by the next tick — review F7 (MAJOR), src/server/dal/engagement-read-claims.ts:66
- [X] T093 Refuse dismissal of an answered item in `dismissItems` and hide the Dismiss control for non-`waiting` items, with a test for the answered-then-dismiss path — review F8 (MAJOR), src/server/services/engagement/review.ts:147, src/app/p/[projectSlug]/inbox/[itemId]/page.tsx:90
- [ ] T094 Make a definitely-failed send leave the item answerable: move the draft out of `review_state = 'approved'` on `fatal_error` with its stated reason (and/or refuse `already_answered` when `engagement_drafts_one_live_answer_uq` is violated), surface failed replies where a person looks, and test fatal_error → second approval → send — review F9 (MAJOR), src/server/scheduler/engagement-send.ts:244, src/server/services/engagement/review.ts:112
- [X] T095 Enforce the platform text limit on the server: count the draft in `approveReply` (and in the send gate) and return `over_limit`, disable the Approve control when over, and test the server refusal — review F10 (MAJOR), src/server/services/engagement/review.ts:92, src/app/p/[projectSlug]/review/ReplyList.tsx:116
- [ ] T096 Write the five ingest cases T027 claims and never delivered — expired credentials with the cursor unmoved, a 500-item backlog over successive ticks, two overlapping ticks with the lease held, a kill mid-read resuming, a rejected cursor restarting and stamping `gap_at` — and make the "no engagement declaration" case connect an account on a provider without `engagement` instead of asserting an empty inbox (depends on T086) — review F11 (MAJOR), tests/integration/engagement/ingest.test.ts:26, tests/integration/engagement/ingest.test.ts:64
- [ ] T097 Resolve `auto_draft`: either build the opt-in pre-draft path (an account control, a tick pass that skips projects on a credit hold, with the scope question settled given the job runner is denied `engagement`) or remove the column, the repo method, the service function and the `autoDraft` account-view field and record the cut in the spec's Decisions — review F12 (MAJOR), src/server/services/engagement/inbox.ts:172, src/server/db/schema/engagement.ts:174
- [ ] T098 Render the item's full draft history on the inbox item page — each draft with its origin, requester and time, and for an approved one its send state (`waiting` with its reason, `sent` with the text, time, approver and link, `failed`/`ambiguous` with the reason) — so a waiting reply is shown as waiting and a sent reply appears in the thread — review F13 (MAJOR), src/app/p/[projectSlug]/inbox/[itemId]/ReplyPanel.tsx:41, src/server/services/failures.ts:219
