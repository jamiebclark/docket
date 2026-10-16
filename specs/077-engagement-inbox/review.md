# Review: Comment and message engagement

Reviewed 120 file(s) changed across 10 commit(s), against `3b8014f`...`HEAD`
(`git merge-base HEAD origin/main`).

**Read in full**: `spec.md`, `plan.md`, `tasks.md`, `data-model.md`,
`contracts/services.md`, `contracts/provider-engagement.md`;
`src/server/db/schema/engagement.ts`, `src/server/dal/engagement.ts`,
`src/server/dal/engagement-claims.ts`, `src/server/dal/engagement-read-claims.ts`,
`src/server/scheduler/engagement-read.ts`, `src/server/scheduler/engagement-send.ts`,
`src/server/scheduler/engagement-budget.ts`,
`src/server/services/engagement/{inbox,draft,prompt,review,retention}.ts`,
`src/server/services/review/decide.ts`, `src/lib/engagement/{paging,identity}.ts`,
`src/providers/bluesky/{engagement,engagement-map}.ts`, `src/providers/mock/engagement.ts`,
`src/app/p/[projectSlug]/inbox/**`, `src/app/p/[projectSlug]/review/ReplyList.tsx`,
the action files, `docs/engagement.md`, and the full diffs of
`activity/{outcomes,details}.ts`, `notifications/{attention,eligibility}.ts`,
`auth/access.ts`, `services/{review,failures,accounts}.ts`, `scheduler/{index,config,housekeeping}.ts`,
`env.ts`, `LeftNav.tsx`, `layout.tsx`, `constitution.md`, `build-prompt.md`, `privacy.md`.
`tests/integration/engagement/{ingest,send,review-reply,no-unreviewed-send,provider-seam}.test.ts`.

**Sampled**: `research.md` (§1 head, §6, §7 read; §2–§5, §8–§10 skimmed), `docs/research/engagement.md`
(headings and verdict rows), `drizzle/0036_*.sql` + `0037_*.sql` (statement order and the enum
`ADD VALUE`s only), `docs/{decisions,feature-map,security,adding-a-provider}.md` (diffstat and
spot-checks), the remaining new test files
(`draft`, `immutability`, `retention`, `dm-presentation`, `permissions`, `engagement-budget`,
`upgrade-in-one-transaction`, the two `docs/` tests, the `secret-scan` and `enum-value-in-batch`
extensions).

**Not reviewed**: `drizzle/meta/003{6,7}_snapshot.json` (23k generated lines),
`quickstart.md` and `checklists/requirements.md` (planning artifacts, not landed behaviour).

**Executed**: the engagement suites (`tests/integration/engagement`, `tests/unit/dal/engagement.test.ts`,
the two Bluesky engagement suites, `scheduler/config.test.ts`) — **14 files, 71 tests, all pass**.
Then the whole suite: **717 files / 6,714 tests pass, 3 failed, 8 files skipped** — the three failures
(`tests/integration/jobs/credit-outage.test.ts` 120 s timeout, `tests/integration/threads/refresh.test.ts`)
**pass when re-run in isolation**, so they read as load flakiness on the shared test database and I
could not attribute them to this feature.

## Verdict

The scaffolding of this entry is genuinely good and the hard parts it set out to get right — one
shared decision core, the database-level `send_state = 'none' OR review_state = 'approved'` backstop,
the pinned review-required policy, no API/MCP surface, the enum-in-batch migration discipline, the
provider seam with its module scan, the permission model, project isolation, the documentation and
the honest research verdicts — are all there and tested. But the two moving parts that make it a
*working* inbox are both wrong, and neither has a test: **reading stops delivering new items after an
account's first successful read** (F1), and **the send path's concurrency and ledger guards do not
hold** (F2, F3), so a reply can be sent twice. On top of that, three obligations were designed, given
schema, repo methods and consumer-side gates, and then never wired to a producer — the brand's own
post beside the comment (F4), withdrawn/edited-upstream (F5), and the auto-draft switch (F12) — and
the item thread never shows a reply once it has been approved (F13). The published privacy claim about
what the draft prompt carries is the opposite of what the code does (F6). This is the classic
chunked-implement failure: each pass is locally plausible, the suite is green, and the seams between
passes are where everything is missing. I would not merge it; the remediation is well-bounded
(14 tasks, mostly small) because the structure underneath is sound.

## Findings

- [ ] 🛑 BLOCKER F1 — A Bluesky account stops receiving new items after its first successful read.
      where:  src/server/scheduler/engagement-read.ts:137, src/server/scheduler/engagement-read.ts:156, src/lib/engagement/paging.ts:44, src/providers/bluesky/engagement.ts:19
      why:    Two independent faults, either of which alone stops ingest.
              (a) `anyAlreadyStored` is hardcoded `false` (`engagement-read.ts:156`), so
              `nextBackfillState` latches `backfilling = true` on any page that comes back full, and
              once latched it returns `true` on every subsequent page (`!anyAlreadyStored` is always
              true) until the provider answers `exhausted` (`paging.ts:44-46`). While backfilling,
              `directionFor` only ever pages *older* (`engagement-read.ts:137`), so the newest page is
              never read again.
              (b) In the `"newest"` direction the persisted `state.cursor` is sent as the request
              cursor (`engagement-read.ts:137`, committed at `:207`), and
              `app.bsky.notification.listNotifications` takes only `reasons`/`limit`/`cursor` — its
              cursor paginates *backwards* (verified in
              `node_modules/@atproto/api/dist/client/types/app/bsky/notification/listNotifications.d.ts`;
              there is no `since`). So a stored cursor can only fetch items older than ones already
              read, never newer ones.
              Concretely: an account with 60 unread notifications and `ENGAGEMENT_READ_PAGE_SIZE=50`.
              Run 1 reads the newest 50 (cursor `c1`), latches `backfilling`, then wastes a call
              re-reading the same newest page (`backfillCursor` is still null), then reads items
              51–60. `backfilling` stays `true`. Every later run pages older from `backfillCursor`;
              when the platform returns a cursor for the last short page, `exhausted` is never true
              and the account never returns to the newest page. New replies and mentions are never
              ingested. No test reaches this: the mock provider always answers
              `{ cursor: null, exhausted: true }` (`src/providers/mock/engagement.ts:28,41`), so the
              cursor and backfill machinery is never executed anywhere in the suite.
      owed:   Read the newest page from `cursor: null` every run and stop at the first already-stored
              item (that is what `anyAlreadyStored` was for — thread the insert result back into the
              paging decision); use the stored cursor only for the `older`/backfill direction; clear
              `backfilling` when a page contains an already-stored item. Give the mock provider a
              paged fixture so the backlog-catch-up case in T027 can actually run.
      traces: FR-006, FR-008, SC-001, SC-007, US2 Independent Test

- [ ] 🛑 BLOCKER F2 — The send claim ignores the lease, so two overlapping ticks claim the same
      in-flight send and a reply can go out twice.
      where:  src/server/dal/engagement-claims.ts:31, src/server/scheduler/engagement-send.ts:114, src/server/scheduler/engagement-send.ts:136
      why:    `claimDueEngagementSends` selects `review_state = 'approved' AND send_state IN
              ('waiting','sending')` with **no predicate on `send_lease_until`** — unlike every other
              claim loop in the repo, which uses `or(isNull(leaseUntil), lte(leaseUntil, now))`
              (`src/server/dal/scheduler.ts:105`, `:277`). `FOR UPDATE SKIP LOCKED` only protects the
              claim transaction, which commits before the provider call is made, so a second tick sees
              an unlocked row in state `sending` with a live lease and claims it. The write-back then
              ignores the lease token entirely (`engagement-send.ts:67`, `:199` update by `draft.id`
              only), contrary to contracts/services.md §5 "Record under the lease token".
              Failure: a draft whose item has had one ledger release (any `fatal_error`,
              `retryable_error`, `credentials_invalid` or a member's `markReplyNotSent` — see F3) is at
              generation ≥ 2, so `latest.releaseReason === null` is false and the recovery branch at
              `:114` is skipped. Tick B therefore computes `generation = latest.generation + 1`
              (`:136`), inserts a fresh claim that does not collide, and calls `engagement.send()`
              again while tick A's call is still in flight — **two replies to one comment**.
              Even on the first attempt the overlap misbehaves: tick B takes the recovery branch and
              writes `send_state = 'ambiguous'` while tick A writes `sent`; whichever lands second
              either raises a spurious human decision or violates
              `engagement_drafts_sent_pair` (`send_state='ambiguous'` with `sent_at` set) and throws
              out of the section.
      owed:   Add the lease predicate to the claim, and condition every outcome write on
              `send_lease_owner = token` (the token is already returned by `claimDueEngagementSends`
              and currently unused). Add an integration test that runs two `runEngagementSend` passes
              concurrently against one approved draft and asserts exactly one provider call.
      traces: FR-007, FR-039, FR-040, SC-004, US3 AS6, spec edge case "Two ticks overlapping on one account"

- [ ] MAJOR F3 — The ledger's "already answered" test can only ever be true at generation 1, so after
      any release the guard that is supposed to make a second send impossible stops working.
      where:  src/server/db/schema/engagement.ts:184, src/server/scheduler/engagement-send.ts:136, src/server/services/engagement/review.ts:106, src/server/services/engagement/inbox.ts:68
      why:    `engagement_reply_claims_generation_release_pair` is
              `(generation = 1) = (release_reason IS NULL)`, so every row above generation 1 *must*
              carry a release reason. `processClaim` therefore copies the previous reason forward when
              it inserts a **claim** at generation ≥ 2 (`engagement-send.ts:137-138`). Three call
              sites then test liveness as `latest.releaseReason === null`
              (`engagement-send.ts:114`, `review.ts:106`, `inbox.ts:68`) — a test that is false for
              every generation ≥ 2, claim or release alike. So after one successful send at
              generation ≥ 2 (reachable via `markReplyNotSent` → re-approve → send),
              `approveReply` no longer refuses `already_answered` and `replyableVerdict` no longer
              reports a reply in progress; the only thing still standing between that and a duplicate
              reply is the `engagement_drafts_one_live_answer_uq` index, which fails as an unhandled
              Postgres error rather than a refusal (see F9). Combined with F2 it is a plain double
              send. The ledger is specified as "the authority on whether Docket has already replied";
              as encoded it cannot answer that question.
      owed:   Separate claim rows from release rows (e.g. a nullable `released_at`/`release_reason` on
              the claim row, or an explicit `state` column) so "is there an unreleased claim for this
              item" is a single unambiguous query at any generation, and fix the three call sites.
              Test: release, re-approve, send, then attempt a second approval and assert
              `already_answered`.
      traces: FR-039, FR-041, SC-004

- [ ] MAJOR F4 — The brand's own post is never linked at ingest, so a comment is never shown in
      context — the headline promise of US2.
      where:  src/server/scheduler/engagement-read.ts:197, src/server/services/engagement/inbox.ts:48, tests/integration/engagement/ingest.test.ts:41
      why:    `insertIfAbsent` is called with `parentExternalId` only; `parentPostId` and
              `parentPostTargetId` are never resolved from `post_targets.external_id`, so they are
              always null. `resolveParent` (`inbox.ts:47-52`) and `toReplyQueueRow`
              (`services/engagement/review.ts:45-49`) both key off `parentPostTargetId`, so every item
              renders as `kind: "external_reference"` with `text: null` — the inbox and the Review row
              show the platform's URI, never the brand's words. data-model.md §2 says
              `parent_post_target_id` is "set at ingest when the parent is a post Docket published",
              research.md §6 notes the lookup needs no extra platform call, and plan.md's inbox line
              says the service resolves the post "via `parent_post_target_id`". Nothing does the
              lookup. Worse, `ingest.test.ts:41` asserts
              `parent).toMatchObject({ kind: "external_reference" })` for a reply to `post-1`, so the
              test now certifies the missing behaviour as correct.
      owed:   At ingest, look the item's `parentExternalId` up against the account's
              `post_targets.external_id` and set `parent_post_target_id`/`parent_post_id` when it
              matches; fix the ingest assertion to expect `docket_post` with the brand's text for a
              parent Docket published.
      traces: FR-013, SC-001, US2 AS1, US2 AS3

- [ ] MAJOR F5 — Nothing ever marks an item withdrawn or edited-upstream: the provider contract's
      `upstream` field has no consumer anywhere.
      where:  src/server/scheduler/engagement-read.ts:180, src/server/dal/engagement.ts:45, docs/engagement.md:54
      why:    `InboundItemDraft.upstream?: "withdrawn" | "edited"` is specified
              (contracts/provider-engagement.md:78-80) and `EngagementItemsRepo` exposes
              `markWithdrawn`/`markEditedUpstream` (`dal/engagement.ts:45-46`), but the ingest loop
              never reads `item.upstream` (`engagement-read.ts:180-199` maps every other field) and
              `grep -rn "\.upstream\b|upstream:" src/` finds no producer or consumer in the whole
              tree — not even the mock provider. The only callers of `markWithdrawn` are two test
              files. So FR-011 and FR-061 cannot be satisfied by any provider, and the consumer-side
              machinery built for them — `approveReply`'s `withdrawn`/`edited_upstream` refusals, the
              send gate, `acknowledged_edit_at`, `replyableVerdict`'s withdrawn branch, and
              retention's "withdrawn items regardless of age" clause — is unreachable in production.
              research.md §7.4 accepts that *Bluesky's* deletion signal is unverified, but it promises
              "the code path is exercised through the mock provider"; it is not. And
              `docs/engagement.md:54` tells operators "An item the platform reports as deleted is
              removed on the next pass regardless of its age", which nothing can ever do.
      owed:   Consume `upstream` in the ingest loop (stamp `withdrawn_at`/`edited_upstream_at` on the
              already-stored row), add a mock fixture that returns it, test US2 AS8, and state the
              Bluesky-signal gap in `docs/engagement.md` instead of claiming the behaviour.
      traces: FR-011, FR-061, SC-014, US2 AS8, spec edge cases "deleted upstream" / "edited upstream"

- [ ] MAJOR F6 — The published documentation says the draft prompt never carries the commenter's name
      or handle. It does.
      where:  docs/engagement.md:46, src/server/services/engagement/prompt.ts:45
      why:    `who()` puts the author's display name, or failing that their handle, into the user
              prompt ("Ada wrote:"), and `draft.ts:67` passes
              `author: { displayName, handle }` in. The prompt module's own doc comment says so
              plainly. `docs/engagement.md:46-48` says the opposite: "It never carries the commenter's
              name, handle or any other identity field — only the comment's text goes to the model",
              and `docs/privacy.md:49` points operators at that page for exactly this question. The
              spec permits sending a name ("as little about the author as the answer needs") *provided
              it is documented*, which makes the documentation the requirement — and it is wrong, about
              a third party's personal data leaving the installation for an external LLM provider.
      owed:   Correct `docs/engagement.md` to state that the commenter's display name or handle is
              included (and nothing else — no identifier, URL or platform internals), or drop `who()`
              from the prompt. Add a test that pins the prompt's author exposure to the documented
              sentence.
      traces: FR-063, SC-015

- [ ] MAJOR F7 — A tick killed mid-read strands that account's reading permanently: the read claim
      requires the lease to be NULL and nothing expires it.
      where:  src/server/dal/engagement-read-claims.ts:66
      why:    The claim predicate is `isNull(engagementAccountStates.readLeaseUntil)` with no
              `lte(readLeaseUntil, now)` alternative, and no other code path clears a stale read lease
              (`grep readLeaseUntil` finds only the claim and the three release sites inside
              `processAccount`, all of which require the run to finish). Kill the worker between the
              claim commit and the release — the case FR-007 and plan.md's "A tick killed mid-read
              loses the lease and the next tick resumes from the last committed cursor" exist for —
              and `read_lease_until` stays in the past for ever, so that account is never claimed
              again and its inbox silently stops filling. This is the mirror image of F2 and the same
              root cause: neither new claim loop follows the house lease pattern.
      owed:   Use `or(isNull(readLeaseUntil), lte(readLeaseUntil, now))`, and condition the commit on
              the lease token the claim already returns. Test: claim, do not release, advance the
              clock past the lease, re-run and assert the account is re-claimed and resumes from the
              committed cursor.
      traces: FR-007, FR-014, SC-007, spec edge case "A tick killed mid-read"

- [ ] MAJOR F8 — Dismissing an item that has already been answered crashes on a CHECK constraint.
      where:  src/server/services/engagement/review.ts:147, src/app/p/[projectSlug]/inbox/[itemId]/page.tsx:90, src/server/db/schema/engagement.ts:62
      why:    `dismissItems` skips only items already in state `dismissed`, then calls `markDismissed`,
              which sets `state = 'dismissed', dismissed_at = now` and leaves `answered_at` set. For an
              answered item that makes `engagement_items_answered_pair`
              (`(state = 'answered') = (answered_at IS NOT NULL)`) evaluate `false = true` and
              Postgres rejects the update. The inbox item page renders the Dismiss button whenever the
              viewer holds `engagement:reply` and the item is not already dismissed
              (`page.tsx:89-90` — `canDismiss={canReply}`, `dismissed={item.state === "dismissed"}`),
              so: answer a reply, open the item, press Dismiss → unhandled database error instead of
              either a dismissal or a refusal.
      owed:   Refuse (or skip) dismissal of an answered item in `dismissItems`, and hide the control
              for non-`waiting` items. Test the answered-then-dismiss path.
      traces: FR-034, US3 AS12

- [ ] MAJOR F9 — A send that fails definitively leaves the item unanswerable for ever, and the next
      attempt to answer it throws.
      where:  src/server/scheduler/engagement-send.ts:244, src/server/db/schema/engagement.ts:129, src/server/services/engagement/review.ts:112
      why:    On `fatal_error` the draft is left `review_state = 'approved'`, `send_state = 'failed'`
              and nothing ever moves it out of `approved`: `/failures` lists only `ambiguous` replies
              (`services/failures.ts:219-222`), so `markReplyNotSent` is unreachable for a failed one,
              and there is no other transition. Because
              `engagement_drafts_one_live_answer_uq` is unique on `engagement_item_id` where
              `review_state = 'approved'`, approving any later draft for that item raises a unique
              violation out of `review.ts:112` — an unhandled 500, not the graceful refusal the
              contract lists. Meanwhile `replyableVerdict` still reports the item replyable (the
              ledger's latest row now carries a release reason, and the item is still `waiting`), so
              the inbox actively invites the member into the failing path: "Request a draft" →
              approve → error. The most likely trigger is F10: Bluesky 400s an over-300-grapheme
              reply, which maps to `fatal_error`.
      owed:   On a definite failure, return the draft to `needs_review` (or `rejected`) with the
              stated reason so the item is answerable again, or make `approveReply` catch the unique
              violation and refuse with `already_answered`. Surface failed replies somewhere a person
              looks. Test: fatal_error, then a successful second approval and send.
      traces: FR-044, FR-043, US3 AS9, spec edge case "a scope revoked on the platform"

- [ ] MAJOR F10 — An over-limit draft can be approved and sent: `over_limit` and `not_replyable` are
      declared refusals of `approveReply` that no code path ever produces.
      where:  src/server/services/engagement/review.ts:20, src/server/services/engagement/review.ts:92, src/app/p/[projectSlug]/review/ReplyList.tsx:67
      why:    `ReplyDecisionRefusal` declares `not_replyable` and `over_limit` and
              contracts/services.md §4 lists both as `approveReply` refusals, but the function only
              checks empty text, withdrawn, edited-upstream and the ledger — it never counts the text
              against `capabilities.text`, and never re-checks replyability. The Review row computes
              `over` and paints the counter red with "(too long)" (`ReplyList.tsx:67,110-114`) but does
              not disable Approve, and the inbox panel does not gate Save either
              (`ReplyPanel.tsx:91,109`). So FR-025's "shown as blocking rather than truncated" is
              cosmetic: a 400-grapheme model draft is approvable, is claimed by the tick, is refused
              by Bluesky as a 400, becomes `fatal_error`, and the item is then stuck per F9.
      owed:   Count the text in `approveReply` (and in the send gate) and return `over_limit`; disable
              the Approve control when over. Test an over-limit approval refusal server-side.
      traces: FR-025, FR-036, US3 AS2

- [ ] MAJOR F11 — The ingest suite covers a fraction of what T027 claims, and one of its four cases
      asserts nothing.
      where:  tests/integration/engagement/ingest.test.ts:26, tests/integration/engagement/ingest.test.ts:64, specs/077-engagement-inbox/tasks.md:95
      why:    T027 is ticked for "the full table in quickstart.md §2": expired credentials flagging the
              account with the cursor unmoved, a 500-item backlog caught up over successive ticks with
              `ENGAGEMENT_READ_PAGES_PER_RUN=3`, two overlapping ticks with the second finding the
              lease held, a tick killed mid-read resuming from the committed cursor, and a rejected
              cursor restarting from the newest page and stamping `gap_at`. **None of those five
              exist.** What landed is four cases: items land once and a re-read adds nothing;
              cross-project isolation; one `engagement_received` event; and
              "a provider with no engagement declaration has no accounts in the inbox"
              (`:64-70`), which connects no account at all and asserts an empty inbox — it would pass
              against any implementation. FR-007, FR-008 and FR-014 therefore have no test, which is
              precisely how F1 and F7 reached review green.
      owed:   Write the five missing cases (they need a mock provider that can return more than one
              page and the error results — see F1's `owed`), and either make the no-declaration case
              connect an account on a provider without `engagement` or delete it in favour of
              `provider-seam.test.ts`'s real version.
      traces: FR-007, FR-008, FR-014, US2 Independent Test, Constitution II

- [ ] MAJOR F12 — `auto_draft` is a switch nothing can set and nothing reads.
      where:  src/server/services/engagement/inbox.ts:172, src/server/db/schema/engagement.ts:174
      why:    The column exists and defaults to false, `EngagementAccountStatesRepo.setAutoDraft` and
              the `setAutoDraft` service exist, and `listEngagementAccounts` reports `autoDraft` to the
              UI — but no server action or page calls `setAutoDraft` (`grep -rn setAutoDraft src/`
              returns only the DAL and the service), and nothing in `engagement-read.ts` or anywhere
              else pre-drafts. contracts/services.md §3 specifies the path ("**Pre-drafting**
              (`auto_draft` on) calls exactly this function from the tick with the job-runner scope,
              and skips every project under a credit hold without spending anything") and the spec's
              Decisions make the opt-in half of "drafting is on request by default, with an opt-in
              per-account auto-draft" part of the entry. The prohibition half of FR-022 holds
              vacuously; the capability is absent, and no task in `tasks.md` ever covered it. Note the
              job-runner scope is deliberately denied `engagement` (data-model.md §9, asserted in
              `no-unreviewed-send.test.ts`), so the contracted pre-draft path cannot be built as
              written and needs a decision, not just code.
      owed:   Either build it — a UI control on the account, a tick pass that pre-drafts for
              `auto_draft` accounts under an explicitly reasoned scope, skipping projects on a credit
              hold — or drop the column, the repo method, the service function and the `autoDraft`
              field from the account view, and record the cut in the spec's Decisions.
      traces: FR-022, FR-023, SC-009, spec Decision "Drafting is on request by default"

- [ ] MAJOR F13 — Once a reply is approved it disappears from the interface: no screen shows a
      waiting, sent or failed reply, and a second draft is never shown.
      where:  src/app/p/[projectSlug]/inbox/[itemId]/ReplyPanel.tsx:41, src/server/services/engagement/review.ts:70, src/server/services/failures.ts:219
      why:    The item page passes every draft to `ReplyPanel`, which renders only
              `drafts.find(d => d.reviewState === "needs_review")`. The Review queue lists
              `needs_review` only (`listQueue`), and `/failures` lists `send_state = 'ambiguous'`
              only. `grep -rn "sentText|sendState|sendWaitReason|sentAt" src/app/` returns nothing. So
              a reply that is `waiting` on the write-allowance reserve is shown nowhere (FR-043
              requires it be "shown as waiting — never as sent and never as failed"), and the sent
              text, the time and the approving member are recorded but never displayed (FR-045
              requires the sent reply to "appear in the thread in Docket"; US3 AS3 and AS4 say the
              thread shows what was sent and who sent it). The same `.find` means the edge case "A
              draft requested twice in quick succession — two drafts exist and both are shown with the
              time each was written" shows one of them.
      owed:   Render the item's full draft history on the item page: each draft with its origin,
              requester, time, review state, and for an approved one its send state (`waiting` with
              its reason, `sent` with the text, time, approver and link, `failed`/`ambiguous` with the
              stated reason). Cover it in the inbox UI test.
      traces: FR-043, FR-045, US3 AS3, US3 AS4, US3 AS10, spec edge case "A draft requested twice"

- [ ] MINOR F14 — `src/lib/engagement/identity.ts` has no importer, and FR-017's "MUST say plainly
      that it cannot tell" is implemented nowhere.
      where:  src/lib/engagement/identity.ts:16, src/server/services/engagement/inbox.ts:88
      why:    `resolveAuthorIdentity` is a pure pass-through and `isSameAuthor` is never called
              (`grep` finds no importer and no test). `author_identity_stable` is stored and carried
              into `InboxItemView.author.identityStable`, but no surface renders it, so an unstable
              identity is presented exactly like a stable one. Harmless today because the only real
              provider sets `identityStable: true`; the mock defaults it to `false`, so the gap is
              latent rather than visible.
      owed:   Say so in the inbox when `identityStable` is false, and either use or delete the module.
      traces: FR-017, SC-010

- [ ] MINOR F15 — The crash-recovery path erases the reason it just recorded.
      where:  src/server/scheduler/engagement-send.ts:120, src/server/scheduler/engagement-send.ts:129
      why:    The recovery branch writes `last_error = "Interrupted before the result was recorded."`
              inside the transaction, then calls `back({ sendState: "ambiguous" })`, and `back`
              defaults `lastError: patch.lastError ?? null` (`:67`) — so the explanation is nulled
              immediately. The reply reaches `/failures` with no reason at all.
      owed:   Drop the redundant `back(…)` call, or pass the error through it.
      traces: FR-040, FR-044

- [ ] MINOR F16 — `markReplySent`/`markReplyNotSent` do not check the draft's send state.
      where:  src/server/services/failures.ts:238, src/server/services/failures.ts:253
      why:    Both accept any draft id in the project. On a `needs_review` draft `markReplySent` writes
              `send_state = 'sent'` and trips `engagement_drafts_send_requires_approved`; on an
              already-`sent` draft `markReplyNotSent` re-opens it for review and inserts a release, so
              a member with `engagement:reply` can walk an answered item back into a second genuine
              send. The UI only ever offers these for `ambiguous` drafts, so this is reachable only by
              calling the action directly.
      owed:   Require `send_state = 'ambiguous'` in both, and refuse otherwise.
      traces: FR-039, SC-004

- [ ] MINOR F17 — A read that is refused for bad credentials gets no backoff, so the account is
      re-read and re-flagged every tick.
      where:  src/server/scheduler/engagement-read.ts:270
      why:    Every other stop path sets `read_not_before` through `nextRetryAt`
              (`:104`, `:116`, `:254`, `:262`); the `credentials_invalid` branch sets only `last_error`
              and the failure counter. The account is then `needs_reauth`, so the claim loop's
              `eq(socialAccounts.status, "active")` does exclude it — but between the refusal and the
              status write, and for any provider that answers `credentials_invalid` without the status
              changing, the account is claimed again on the very next tick.
      owed:   Set `read_not_before` on this branch too.
      traces: FR-014

- [ ] MINOR F18 — A send blocked by the gate spins every tick with no backoff, and `send_attempts`
      can overflow.
      where:  src/server/scheduler/engagement-send.ts:72, src/server/dal/engagement-claims.ts:45
      why:    Every gate refusal returns the draft to `send_state = 'waiting'` with `send_not_before`
              left null, so the next tick claims it again; the claim increments `send_attempts`, a
              `smallint`. An approved reply on an account that goes `needs_reauth` therefore loops
              once per tick for as long as it stays disconnected — about 32,767 ticks, ~23 days at the
              default one-minute tick, before `send_attempts` overflows and the update errors.
      owed:   Set `send_not_before` (and `send_wait_reason = 'later_run'`) on a gate refusal, and cap
              `send_attempts`.
      traces: FR-043, FR-007

- [ ] MINOR F19 — Vocabulary drift on `send_wait_reason`, and the Review draft is read-only.
      where:  src/server/scheduler/engagement-budget.ts:32, src/app/p/[projectSlug]/review/ReplyList.tsx:102
      why:    data-model.md §3 fixes `send_wait_reason` to `write_allowance | retry | later_run`;
              `mayAttemptReply` returns `per_run_cap`, which is written straight to the column (no
              CHECK guards it), so a fourth undocumented value reaches the database. Separately,
              contracts/services.md §4 and T056 both specify "the editable draft with its live count"
              on `/review`; the landed `TextareaField` is `readOnly` and editing is only possible from
              the inbox item page. FR-026 is still met overall, but the two artifacts and the code
              disagree.
      owed:   Pick one vocabulary (and record it), and either make the Review draft editable or amend
              the contract.
      traces: FR-043, FR-026

- NOTE F20 — FR-036's member — engagement view but not reply — cannot exist: `owner`, `admin` and
  `editor` are the only roles and the spec grants all three both actions
  (`src/server/auth/access.ts:38,56,68`). `review-reply.test.ts:97-104` tests the gate by fabricating
  a scope with `can` overridden, which is the honest thing to do but means the requirement is
  satisfied only in principle. Worth recording in the spec rather than leaving the FR looking tested.

- NOTE F21 — contracts/services.md §1 specifies the FR-032 guard as "a repository search asserts no
  file outside `decide.ts` writes `review_state = 'approved'`". What landed
  (`no-unreviewed-send.test.ts:74-82`) instead asserts no exported function's *name* contains
  "bulkapprove". The substance of FR-032 is met — both adapters do go through `decide()` — but the
  contracted guard does not exist, and the literal version would fail, since the `apply` callbacks in
  `review.ts` and `engagement/review.ts` are what write the column.

- NOTE F22 — Engagement notifications reuse the problem wording: with `engagement` in
  `ATTENTION_MEMBER_OUTCOMES`, the bell reads "3 unread problems" and the callout "3 problems"
  (`src/lib/notifications/text.ts:17,24`) when the three events are new replies. Sharing the
  mechanism is what the spec asked for; the copy was not revisited.

- NOTE F23 — A `duplicate` send stores `external_reply_id = ''`
  (`src/server/scheduler/engagement-send.ts:213`) to satisfy
  `engagement_drafts_sent_fields`, because contracts/provider-engagement.md says a duplicate arrives
  "without an external id" while data-model.md §3 requires one for `send_state = 'sent'`. It works;
  the two artifacts contradict each other.

- NOTE F24 — The full suite had 3 failures under load
  (`jobs/credit-outage.test.ts` timing out at 120 s, `threads/refresh.test.ts`) that both pass when
  re-run in isolation. I could not attribute them to this feature — neither provider declares
  engagement — but the tick now runs two more sections, so a timing-sensitive suite is worth watching
  in CI.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001…FR-069) | 69 | 53 | 12 | 2 | 2 |
| Success criteria (SC-001…SC-016) | 16 | 11 | 4 | 0 | 1 |
| Constitution principles (I–VII + engineering constraints) | 8 | 7 | 1 | 0 | 0 |

Partial: FR-002 (live Meta observation deferred, honestly recorded), FR-006, FR-007, FR-013, FR-014,
FR-017, FR-022, FR-025, FR-039, FR-043, FR-044, FR-045. Absent: FR-011, FR-061.
Contradicted: FR-008, FR-063. SC partial: SC-001, SC-004, SC-007, SC-014; contradicted: SC-015.
Constitution partial: II — the suite is green, but the cursor/backfill mechanism, both lease paths and
the withdrawn/edited path have never been executed by any test, so parts of this entry are "working"
only in the sense the principle forbids.

Verified green by running: the 14 engagement-related test files (71 tests), and the whole suite
(6,714 passing). Verified by reading: the migration's statement order against
contracts/vocabulary.md §5, the `::text` CHECK regeneration and the inverted attention-index
predicate, the permission wiring and its API-key/job-runner denial, the four tables' presence in
`project-owned.ts`, the explicit account-removal deletes, the scope amendment with its version bump,
and all five documentation obligations (FR-065…FR-069).

## What I could not check

- **Anything requiring the network.** No live Bluesky call, so the cursor-direction half of F1 rests
  on the installed lexicon's parameter list (`reasons`/`limit`/`cursor`, no `since`) and the
  universal AT Protocol cursor convention, not on an observation. The backfill-latch half of F1 is
  provable from the code alone and does not depend on it.
- **The Meta identity spike (T083/T084).** Correctly recorded as unachievable by the pipeline in
  `docs/research/engagement.md`; still owed by a person with a live Standard Access app, real
  Facebook/Instagram/Threads accounts and a second commenter. Nothing in the landed code depends on
  it.
- **Real-platform deletion and edit signals**, which is why F5 is stated as a missing generic code
  path rather than a missing Bluesky behaviour.
- **The browser.** I read every new page and component but rendered none: keyboard reachability,
  focus order, the empty/error/loading states and the `docket-ui` conventions were judged by reading,
  not by driving the app. The over-limit Approve control (F10) and the answered-item Dismiss control
  (F8) were traced through the JSX, not clicked.
- **`pnpm lint`, `pnpm typecheck`, `pnpm db:check` and `pnpm build`.** T082 claims them; I ran only
  the test suite. CI remains the authority, and per the project's own note local green is weaker than
  CI green on the ffmpeg-dependent video tests (8 files skipped here).
- **Performance against the stated budgets.** `listInbox` issues roughly six queries per item
  (`accounts.get` twice, `listByItem`, `effectiveContent`, `countNewerOnSameParent`,
  `claims.latest`) — about 150 round trips for a 25-item page. I did not measure it against the
  per-screen budget, so it is recorded here rather than as a finding.
