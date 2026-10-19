---

description: "Task list for Threads replies and mentions land in the inbox"
---

# Tasks: Threads replies and mentions land in the inbox

**Input**: Design documents from `/specs/086-threads-replies-and-mentions-reader/`

**Prerequisites**: plan.md, spec.md, data-model.md, research.md, quickstart.md, contracts/

**Tests**: Requested by the spec (FR-033..FR-035, constitution II) — every task below is proven by a
test with no live platform call, run with `pnpm vitest run <file>` per task and one final
`pnpm lint && pnpm typecheck && pnpm test && pnpm build` at the end.

**No migration. No new dependency. No `pnpm install`.** `drizzle/0047_salty_owl.sql` stays the
latest file.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 / US2 / US3 / US4 / US5, mapping to spec.md's priorities (P1, P1, P2, P2, P3)

---

## Phase 1: Foundational (Shared Infrastructure)

**Purpose**: `docsHref` must exist before any site can render a declared `docsPath` correctly —
blocks FR-003's notice link (US1) and the accounts-page block (US1). The two component call sites
are the same shipped defect (research.md §2.6) and are fixed alongside it so no `as DocPage` cast
survives anywhere in the tree.

- [X] T001 [P] Add `docsHref(docsPath: string): string` to `src/lib/docs.ts` — splits on the first
  `#`, validates the page against `DocPage`, calls `docsUrl(page, anchor)`; an unknown page returns
  `DOCS_BASE_URL` rather than throwing (contracts/threads-engagement.md §4)
- [X] T002 [P] Write `src/lib/docs.test.ts`: `docsHref("meta-setup#engagement")` equals
  `docsUrl("meta-setup", "engagement")`'s value; a bare page with no `#` returns the page URL; an
  unknown page returns the docs base instead of throwing
- [X] T003 [P] Update `src/components/insights/TargetMetrics.tsx` to call `docsHref(docsPath)`
  instead of `docsUrl(docsPath as DocPage)`, dropping the `as DocPage` cast
- [X] T004 [P] Update `src/components/targets/PerformancePanel.tsx` (all three call sites) to call
  `docsHref(docsPath)` instead of `docsUrl(docsPath as DocPage)`, dropping the `as DocPage` casts

**Checkpoint**: `docsHref` is in place and proven; every existing `docsPath` render in the tree
resolves to a real documentation URL. User story work can begin.

---

## Phase 2: User Story 1 - A Threads account tells the truth about the inbox (Priority: P1) 🎯 MVP

**Goal**: A connected Threads account is declared `unavailable` with an honest reason and a working
docs link, is never claimed/leased/decrypted/called on a tick, is excluded from the inbox filter,
and the accounts page says the same thing — even if the operator has granted the Threads engagement
permissions and reconnected.

**Independent Test**: Connect a Threads account in a test install, open the inbox, confirm the
unavailable notice names Threads and its reason; run a scheduler tick and confirm no Threads account
is claimed and no Threads credential is decrypted.

### Implementation for User Story 1

- [X] T005 [P] [US1] Create `src/providers/threads/engagement.ts`: `threadsEngagement` export with
  `declaration` (`reads: ["reply", "mention"]`, `canReply: false`, `unavailable.reason` naming both
  surfaces and the unconfirmed-endpoint cause with none of *reconnect/grant/permission needed/opt
  in/enable*, `unavailable.docsPath: "meta-setup#engagement"`, no `readScopes`, no
  `missingReadScopes`, no `writeBudget`), two `.strict()` empty schemas
  (`threadsEngagementItemDataSchema`, `threadsEngagementStateSchema`), `read()` returning
  `{ kind: "unavailable", reason, docsPath }` without touching `_ctx`, `send()` returning
  `{ kind: "fatal_error", error: "Threads replies cannot be sent through Docket." }` without
  touching `_ctx`. Imports only `zod`, `../types`, `./settings` (contracts/threads-engagement.md §1-3)
- [X] T006 [US1] Wire `engagement: threadsEngagement` onto `threadsProvider` in
  `src/providers/threads/index.ts` (depends on T005)
- [X] T007 [P] [US1] Write `src/providers/threads/engagement.test.ts`: `reads` is exactly
  `["reply", "mention"]`; `canReply` is `false`; no `readScopes`/`missingReadScopes`/`writeBudget`
  key; `unavailable.reason` contains none of the forbidden words (FR-004); `read()` returns
  `kind: "unavailable"`; `send()` returns `kind: "fatal_error"` with no `flagAccount`; neither
  function reads any property off its context argument
- [X] T008 [P] [US1] Add FR-035 declaration-refusal tests to `src/providers/registry.test.ts`:
  the shipped `threadsEngagement.declaration` passes `assertEngagementDeclaration`; the same
  declaration plus `readScopes: ["threads_manage_replies"]` throws
  `unavailable and readScopes must never both be set`; the same declaration plus a `writeBudget`
  throws
- [X] T009 [US1] Add `countAccountsOnUnavailableEngagement(providerKeys: readonly string[]):
  Promise<number>` to `src/server/dal/engagement-read-claims.ts`, mirroring
  `countAccountsMissingEngagementScopes`'s predicate shape (`removedAt IS NULL`,
  `status = 'active'`) (research.md §3 Finding D3)
- [X] T010 [US1] In `src/server/scheduler/engagement-read.ts`, compute the unavailable provider keys
  alongside the existing rule list and add `countAccountsOnUnavailableEngagement`'s result to
  `counts.unavailable`, called unconditionally outside the `providers.length > 0` guard (depends on
  T009; FR-016)
- [X] T011 [US1] Update `src/app/p/[projectSlug]/inbox/page.tsx`: render the unavailable-accounts
  notice's link through `docsHref` instead of the raw `docsPath` (line 82); render the engagement
  permission notice only for accounts with `!a.unavailable` (precedence guard, FR-015) (depends on
  T001)
- [X] T012 [P] [US1] Add `engagementUnavailable: { reason: string; docsPath?: string } | null` to
  `AccountView` in `src/server/services/accounts.ts`, filled in `view()` from
  `findProvider(a.providerKey)?.engagement?.declaration.unavailable ?? null` (data-model.md §4)
- [X] T013 [US1] Update `src/app/p/[projectSlug]/accounts/page.tsx`: render
  `account.engagementUnavailable` in the same place as the engagement permission block, with the
  declared reason verbatim and a docs link through `docsHref`, no reconnect control; render the
  existing `engagementReadPermission` block only when `account.engagementUnavailable === null`
  (precedence guard, FR-015) (depends on T001, T012)
- [X] T014 [P] [US1] Write `tests/integration/engagement/threads-unavailable.test.ts`: with a
  connected Threads account, a real `runEngagementRead` tick reports `counts.claimed` excluding it
  and `counts.unavailable === 1` and `counts.failed === 0`; no `engagement_account_states` row
  exists for it; the credential-decrypt function is spied and never called; `fetch` is stubbed to
  fail the test if invoked; `listEngagementAccounts` returns it with the declared reason and
  `docsPath`; the account filter's options exclude it; then with `granted_scopes` set to both
  Threads engagement permissions, the member is still told reading is not built and is not offered a
  reconnect (US1 scenario 5, FR-015)
- [X] T015 [P] [US1] Write `tests/integration/accounts/accounts-page-engagement.test.ts`: render the
  real accounts page (`renderToStaticMarkup`, the `accounts-page-insights.test.ts` shape) with a
  connected Threads account and assert the card carries the declared reason verbatim, a
  documentation link, and no Reconnect control for engagement

**Checkpoint**: User Story 1 is fully functional and testable independently — a Threads account is
honestly declared unavailable everywhere a member or operator looks, and a scheduler tick never
touches it.

---

## Phase 3: User Story 2 - A mention is never attributed to a post it is not about (Priority: P1)

**Goal**: Prove, against stored rows and the real housekeeping pass, that a parentless item is
never attributed to any of the brand's own posts — not in storage, not in first-engagement, not in
the same-post count — while a parented item on the same run resolves correctly.

**Independent Test**: Ingest a mention with no parent alongside a reply that does have one, through
the mock provider and the Bluesky mapping, then assert the mention is stored with no parent post or
target, is excluded from first-engagement, and reports a zero same-post count.

### Implementation for User Story 2

*No application code changes — this story proves existing behaviour (research.md §2.1-§2.3) and
fixes any defect proving it reveals.*

- [ ] T016 [P] [US2] Write `tests/integration/engagement/parentless-ingest.test.ts`: run the real
  engagement-read section over a mock page carrying one parentless mention, one parented reply
  resolving to a published target, and one reply whose parent id matches none of the brand's posts,
  all in the same page; read all three rows back from `engagement_items` and assert the mention has
  `parent_external_id`, `parent_post_id` and `parent_post_target_id` all null (FR-017), the resolved
  reply has all three set (FR-021), the unresolved reply has `parent_external_id` set and both post
  columns null (FR-022), and the parented rows are undisturbed by the parentless one (FR-024)
- [ ] T017 [P] [US2] Write `tests/integration/engagement/same-post-count.test.ts`: store three
  parentless mentions with ascending `said_at` and assert the oldest reports
  `newerOnSameParent === 0` (FR-019, not a count of the other two); store two parented replies on one
  target and assert the older one reports `1`
- [ ] T018 [US2] Edit `tests/integration/insights/first-engagement.test.ts`: publish a target, store
  a parentless mention whose `said_at` is after publish, run `recordFirstEngagement`, assert
  `exact_first_at` and `bound_before_at` are null and `firstEngagementFigure` reports `none_yet` or
  `not_examined` (FR-018, SC-003); store a parented reply on the same target in the same run and
  assert it produces `kind: "exact"` (FR-021)

**Checkpoint**: User Stories 1 AND 2 both work independently.

---

## Phase 4: User Story 3 - A parentless item says so, instead of showing nothing (Priority: P2)

**Goal**: The item page states plainly when an item is not about one of the brand's own posts,
distinguishes that from a reference to something that is not the brand's post, and distinguishes
both from the brand's own post as context — three visibly different, non-empty renders.

**Independent Test**: Open a stored mention with no parent and confirm the item page states it is
not about one of the brand's posts; open a reply on one of the brand's posts and confirm that
statement is absent and the post's own context is shown instead.

### Implementation for User Story 3

- [ ] T019 [US3] Replace the parent block in
  `src/app/p/[projectSlug]/inbox/[itemId]/page.tsx` with a three-arm render on `item.parent`'s
  `kind`: `null` renders a plain, non-alert statement that this is not about one of the brand's own
  posts (FR-023); `"docket_post"` renders heading "On your post" with the post's text (FR-021);
  `"external_reference"` renders a heading naming it as not one of the brand's posts with the
  platform reference (FR-022); no `"—"` fallback anywhere; static text, no new control or focus stop
  (contracts/parent-context.md §5)
- [ ] T020 [P] [US3] Write `tests/integration/engagement/parent-context.test.tsx`: render the real
  item page (`renderToStaticMarkup`, the `tests/helpers/actions` mocks) once per stored state —
  null parent, resolved parent, unresolved parent — and assert each produces a distinct non-empty
  statement, with the resolved-case statement absent from the null-case markup and vice versa
  (depends on T019)

**Checkpoint**: All user stories through US3 are independently functional.

---

## Phase 5: User Story 4 - The roadmap's documentation ends honest (Priority: P2)

**Goal**: The supported-platforms table and the provider guide tell the truth about every surface
this roadmap touched, including the ones still unread and why.

**Independent Test**: Read the supported-platforms table and the provider guide's engagement section
cold, and confirm every surface this roadmap touched has a verdict with a reason, and that the guide
names a current example of each of the two reader shapes.

### Implementation for User Story 4

- [ ] T021 [P] [US4] Edit `docs/engagement.md`: split the Threads row into **Threads — replies** and
  **Threads — mentions**, each naming its own permission and attributing the block to the
  unconfirmed read endpoint rather than the permission (FR-026); remove the sentence attributing
  Threads' absence to the commenter/mention identity shape; state that granting the Threads
  engagement permissions does not cause anything to be read (FR-028) (contracts/documentation.md §1-2)
- [ ] T022 [P] [US4] Edit `docs/meta-setup.md`: replace "Nothing is read on any Meta or Threads
  surface yet in this release" (now false since 085) with language stating Facebook and Instagram
  comments are read once the permission is granted, and Threads replies and mentions are not read at
  all yet (FR-028) (contracts/documentation.md §2)
- [ ] T023 [P] [US4] Edit `docs/adding-a-provider.md` §20: replace the stale "one real
  implementation so far" pointer with both reader shapes named by file path —
  `src/providers/bluesky/engagement.ts` (account-level) and `src/providers/meta/engagement-sweep.ts`
  with `src/providers/facebook/engagement.ts` / `src/providers/instagram/engagement.ts` (per-post) —
  and which platform shape each suits (FR-029); add the "has not published" vs "has not granted"
  distinction sentence naming `src/providers/threads/engagement.ts` as the current example of the
  first (FR-030) (contracts/documentation.md §3)
- [ ] T024 [P] [US4] Edit `docs/decisions.md`: append one `## 086 — …` section recording the three
  judgement calls — both surfaces unverified means no reader and the entry is the declaration;
  `docsHref` and the shipped broken link fixed in passing; `countAccountsOnUnavailableEngagement`
  as a count query rather than letting `processAccount` claim the account (contracts/documentation.md
  §5)
- [ ] T025 [US4] Write `tests/integration/docs/engagement-roadmap-docs.test.ts` (reads the docs files
  as text, the `engagement-scope.test.ts` pattern): the table has a row for Threads replies and a row
  for Threads mentions each naming its own permission; every "Not yet" cell in the reading column has
  more than the words "Not yet"; the Threads reading cells mention an endpoint and do not present the
  permission as the blocker; the reply column names no Meta surface as sendable and the DM column is
  "Not yet" on every row; `docs/engagement.md` no longer attributes Threads' absence to the identity
  shape; `docs/meta-setup.md` no longer claims nothing is read on any Meta surface; the Threads
  opt-in text states granting does not cause reading; §20 names both reader-shape file paths and
  asserts both exist on disk (`existsSync`); §20 contains the "has not published"/"has not granted"
  distinction (depends on T021, T022, T023, T024)

**Checkpoint**: All user stories through US4 are independently functional; the documentation closes
the roadmap honestly.

---

## Phase 6: User Story 5 - The next person does not redo this research (Priority: P3)

**Goal**: The research file records this entry's re-check of both Threads surfaces, its date, and
the bounded list of facts still missing per surface.

**Independent Test**: Read the Threads sections of the research file and confirm they record this
entry's re-check attempt, its date, and that the result was unchanged.

### Implementation for User Story 5

- [ ] T026 [US5] Edit `docs/research/engagement.md` §2: under each of the **Threads replies** and
  **Threads mentions** headings, add prose (not new table rows, not edits to existing answer cells)
  after the existing `**Consequence:**` paragraph recording the 2026-10-19 re-check — what was
  searched for, that the verdict is unchanged, and the Keyword Search fact recorded as found and
  rejected (FR-031) — followed by a numbered list of exactly what is still missing per surface
  (endpoint path, object field list, pagination shape) with the permission named as confirmed and
  not missing (FR-032) (contracts/documentation.md §4)
- [ ] T027 [US5] Run `pnpm vitest run tests/integration/docs/engagement-research.test.ts` and confirm
  it still passes against the §2 edit — the test parses on `### ` headings and requires every
  numbered row to cite a URL or be marked `**unverified**`, so this is the check that the added prose
  did not become a new row or an edited answer cell (depends on T026)

**Checkpoint**: All five user stories are independently functional and proven.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: One final verification pass, not a per-task ritual (constitution; plan.md Development
workflow)

- [ ] T028 Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build` once, at the end of
  implementation. `pnpm build` is required because `src/app/**` route files change. `pnpm db:check`
  is not needed — no migration is added — but runs in CI regardless and must stay green

---

## Dependencies & Execution Order

### Phase Dependencies

- **Foundational (Phase 1)**: No dependencies — can start immediately. Blocks T011 and T013 in
  Phase 2 (both call `docsHref`).
- **User Story 1 (Phase 2)**: Depends on Phase 1 for T011/T013 only; T005-T010, T012, T014, T015 have
  no Phase 1 dependency and can start immediately.
- **User Story 2 (Phase 3)**: No dependency on Phase 1 or Phase 2 — proves existing behaviour only.
- **User Story 3 (Phase 4)**: No dependency on any other story.
- **User Story 4 (Phase 5)**: No dependency on any other story (documentation only).
- **User Story 5 (Phase 6)**: No dependency on any other story (documentation only).
- **Polish (Phase 7)**: Depends on all desired stories being complete.

### Within Each User Story

- US1: T005 before T006 (wiring needs the file); T009 before T010 (count query before its caller);
  T001 before T011 and T013; T012 before T013. T007, T008, T014, T015 can run once T005/T006 land.
- US2: T016, T017, T018 are independent of each other (different files, prove different links).
- US3: T019 before T020 (test renders the implemented page).
- US4: T021-T024 are independent documentation edits; T025 depends on all four.
- US5: T026 before T027.

### Parallel Opportunities

- All of Phase 1 (T001-T004) in parallel.
- Within US1: T005, T007, T008, T012, T014, T015 in parallel (distinct files); T006 waits on T005;
  T009→T010 and T001→T011/T013 are the only other ordering.
- All of US2 (T016, T017, T018) in parallel.
- All of US4's doc edits (T021, T022, T023, T024) in parallel; T025 after.
- Different user stories can be staffed in parallel once Phase 1 is done (US2, US3, US4, US5 need
  nothing from US1).

---

## Parallel Example: User Story 1

```bash
# Launch together once Phase 1 is done:
Task: "Create src/providers/threads/engagement.ts"
Task: "Add FR-035 declaration-refusal tests to src/providers/registry.test.ts"
Task: "Add engagementUnavailable field to AccountView in src/server/services/accounts.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Foundational (`docsHref` and the two component fixes)
2. Complete Phase 2: User Story 1 — the Threads declaration, the no-call guarantee, the inbox and
   accounts presentation
3. **STOP and VALIDATE**: `pnpm vitest run src/providers/threads/engagement.test.ts
   src/providers/registry.test.ts tests/integration/engagement/threads-unavailable.test.ts
   tests/integration/accounts/accounts-page-engagement.test.ts`
4. This is the roadmap's only member-visible behaviour change; everything else is proof and
   documentation

### Incremental Delivery

1. Foundational → US1 (MVP: Threads tells the truth)
2. Add US2 (parentless items never misattributed) → test independently
3. Add US3 (parentless items say so) → test independently
4. Add US4 (documentation closes the roadmap) → test independently
5. Add US5 (research audit trail) → test independently
6. Final pass (Phase 7)

---

## Notes

- [P] tasks touch different files with no completed-task dependency between them
- No task in this feature needs `pnpm install`, a migration, or a live platform call
- Commit after each task or logical group, with explicit paths on every `git add`
- US2's "implementation" is proof-only: research.md §2.1-§2.3 found the ingest, first-engagement and
  same-post-count code already correct by construction; if a task's test reveals a defect, fix it in
  that task rather than opening a new one
