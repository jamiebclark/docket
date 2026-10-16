# Review: Comment and message engagement — re-review after remediation

Reviewed the 31 file(s) changed across the 4 remediation commits
(`54cf74d`..`HEAD`), against the 14 findings of the first review and the 14 tasks
T085–T098 they produced. The whole feature is 128 files across 14 commits
(`3b8014f`...`HEAD`); per the constitution's "Review is exhaustive once, then
scoped", the exhaustive sweep of every FR and SC happened in the first round and
is **not** repeated here. This pass checks two things only: is each earlier
finding actually fixed, and did the remediation break anything.

**Read in full** (remediation diff): `src/server/scheduler/engagement-read.ts`,
`src/server/scheduler/engagement-send.ts`, `src/server/dal/engagement.ts`,
`src/server/dal/engagement-claims.ts`, `src/server/dal/engagement-read-claims.ts`,
`src/server/dal/targets.ts`, `src/server/db/schema/engagement.ts`,
`src/server/services/engagement/{inbox,review}.ts`, `src/server/services/failures.ts`,
`src/providers/mock/{engagement,settings}.ts`,
`src/app/p/[projectSlug]/inbox/[itemId]/{ReplyPanel.tsx,page.tsx}`,
`src/app/p/[projectSlug]/review/ReplyList.tsx`,
`tests/integration/engagement/{ingest,send,read-lease,review-reply}.test.ts`,
`tests/unit/engagement/prompt.test.ts`, `drizzle/0038_*.sql`, `drizzle/0039_*.sql`,
`drizzle/meta/_journal.json`, `docs/engagement.md`, and the `spec.md` /
`data-model.md` / `contracts/services.md` amendments.

**Read for context, unchanged by the remediation**: `src/lib/engagement/paging.ts`,
`src/server/scheduler/engagement-budget.ts`, `src/server/services/engagement/draft.ts`,
`src/providers/bluesky/engagement.ts`, `src/server/dal/scheduler.ts`
(the house lease pattern), `src/server/env.ts` + `.env.example` (lease and page
defaults).

**Not reviewed**: `drizzle/meta/0038_snapshot.json` and `0039_snapshot.json`
(23k generated lines); anything outside the remediation diff, which the first
round already swept.

**Executed**: `pnpm vitest run tests/integration/engagement tests/unit/engagement/prompt.test.ts
tests/unit/dal/engagement.test.ts` — **13 files, 65 tests, all pass** (14.9 s).
Per the constitution's "review: do not re-run the full suite, lint, typecheck or
build", the full suite, lint, typecheck, `db:check` and `build` were not re-run;
CI on the same commits is the authority.

## Verdict

The remediation is real work and most of it is right. All four structural fixes
land and are now covered by tests that would have caught the original defects:
the read loop no longer latches into a backfill that never returns to the newest
page and no longer sends a backwards-paginating cursor in the forward direction
(F1); the send claim respects the lease and every outcome write is conditioned on
the lease token (F2); the ledger is re-encoded with `released_at` so a live claim
is distinguishable from a release at any generation, with the three call sites
fixed and an end-to-end release then re-approve then send then refuse test (F3);
the expired read lease is reclaimable and a stale token's commit is dropped (F7).
The parent post is resolved at ingest through a project-scoped
`targets.getByExternalId` and the misleading assertion is inverted (F4); the
`upstream` signal has a consumer, a mock fixture and two tests, and the
documentation now states the Bluesky gap instead of promising the behaviour (F5);
the privacy claim matches `who()` and is pinned by a unit test (F6); dismissal is
restricted to `waiting` items in both the service and the UI (F8); a fatal send
rejects the draft so the item is answerable again (F9); the text limit is
enforced server-side in both `approveReply` and the send gate and the Approve
button is disabled (F10); the five missing ingest cases exist (F11); `auto_draft`
is cut cleanly — column dropped by migration, repo method, service and view field
gone, spec Decision, FR-022, FR-023, SC-009, the glossary and
contracts/services.md all amended (F12); and the item page now renders a draft
history with requester, approver, times, send state and the sent text (F13).

Two things stop me calling it clean. The read loop's restructuring moved the
inserts out of the transaction and above the error check, so a read that stores
items on one page and then fails on the next commits those items and never writes
the `engagement_received` event — permanently, because the next run re-reads them
and inserts nothing. That is a new defect, in the exact scenario the backlog
catch-up exists for, and it breaks FR-046 (F25). And F13's fix covers approved,
rejected and discarded drafts but renders nothing for a second `needs_review`
draft, which is the one case the spec's own edge case names — leaving an empty
"Draft history" heading on the item page (F26). Both are small and local. Nothing
in the remediation regressed the first round's fixes, and nothing I found needs
the architecture reopened.

## Findings

- [ ] MAJOR F25 — A read that stores items and then fails on a later page never
      notifies anybody about them, and never will.
      where:  src/server/scheduler/engagement-read.ts:212, src/server/scheduler/engagement-read.ts:236, src/server/scheduler/engagement-read.ts:166
      why:    T085/T089/T090 moved the insert loop out of the closing transaction and up into the
              paging loop (`:166`), where `repos` is bound to the plain client
              (`forSchedulerProject` → `build(getDb())`, `src/server/dal/scheduler.ts:312,315`), so
              every `insertIfAbsent` commits on its own statement. The error check sits *below* it:
              a non-`page` result sets `stop` and breaks, and `if (stop) { await handleStop(...);
              return; }` (`:212`) returns before the `engagement_received` activity insert at
              `:236`. So the items are in the inbox and the event is not written — and it never will
              be, because `insertIfAbsent` is idempotent, so on the next run those rows come back
              `inserted: false`, `inserted` stays 0, and the `if (inserted > 0)` guard never fires
              again. `counts.itemsInserted` is also left un-incremented, so the tick's own report
              undercounts.
              Concretely, with the default `ENGAGEMENT_READ_PAGES_PER_RUN=3` and
              `ENGAGEMENT_READ_PAGE_SIZE=50` (`.env.example:173,177`): an account catching up a
              backlog is `backfilling`, so every page in the run reads `older`. Page 1 stores 50 new
              items; page 2 comes back `rate_limited` — Bluesky rate-limits reads, and a catch-up is
              exactly when you meet one — so `handleStop` runs and 50 items land silently. FR-046
              ("New inbound items MUST raise attention through the existing notification
              mechanism") is violated for them, permanently, and no later event can repair it
              because FR-048 forbids re-notifying a stored item. The same window loses the event on
              a plain crash between the inserts and the final transaction, which data-model.md §7
              step 6 and T034 both explicitly guard against by requiring the event be written "in
              the same transaction" as the inserts — it no longer is. No test reaches this: the five
              new ingest cases either stop on page 1 with nothing inserted
              (`tests/integration/engagement/ingest.test.ts:150`, credentials_invalid) or insert on
              a clean run and stop on a *later* run (`:231`, cursor_lost), never both inside one run.
      owed:   Account for `inserted` on the stop path — write the state commit and the
              `engagement_received` event for whatever landed before handing off to `handleStop`,
              rather than returning early — or move the inserts back inside a transaction that also
              carries the event. Test: a fixture that serves one good page then a stop result in the
              same run, asserting the items are present *and* exactly one `engagement_received`
              event exists.
      traces: FR-046, FR-048, data-model.md §7 step 6, T034, review F1 (regression from its fix)

- [ ] MAJOR F26 — The new draft history renders nothing for a second draft awaiting review, and
      shows an empty "Draft history" heading when there is one.
      where:  src/app/p/[projectSlug]/inbox/[itemId]/ReplyPanel.tsx:50, src/app/p/[projectSlug]/inbox/[itemId]/ReplyPanel.tsx:245, src/server/dal/engagement.ts:243
      why:    `DraftHistoryEntry` handles `rejected`, `discarded` and `approved` and returns `null`
              for anything else (`:50`) — i.e. for `needs_review`. The action area above renders only
              `drafts.find(d => d.reviewState === "needs_review")`, and `listByItem` orders
              `createdAt DESC` (`dal/engagement.ts:243`), so with two drafts awaiting review the
              newest is editable and **the older one is rendered nowhere on the page**. Worse, the
              wrapper's guard is `drafts.some(d => d.id !== pending1?.id)` (`:245`), which is true as
              soon as a second draft exists, so the "DRAFT HISTORY" heading is emitted with no
              content under it — a labelled section containing nothing, on the feature's main screen.
              Two `needs_review` drafts are trivially reachable and are the specified behaviour:
              FR-019 says a member "MUST be able to request another", neither `requestDraft` nor
              `writeReply` discards the previous one (`services/engagement/draft.ts:89,120` — the
              only `discardSiblings` caller is `approveReply`,
              `services/engagement/review.ts:122`), and spec.md:189 states the edge case as "Two
              drafts exist and **both are shown with the time each was written**". T098 ordered "each
              draft with its origin, requester and time"; one class of draft gets none of it.
      owed:   Render a `needs_review` draft that is not the one being edited as a history entry
              (origin, requester, time, and the note that approving one discards the other), and gate
              the heading on there being at least one entry that actually renders. Extend the F13
              test to two concurrent `needs_review` drafts.
      traces: FR-019, spec.md:189 edge case "A draft requested twice in quick succession", US3 AS10, T098

- [ ] MINOR F27 — `withdrawn_at` and `edited_upstream_at` are re-stamped to "now" on every read, so
      they record the last read rather than when the platform reported the change.
      where:  src/server/scheduler/engagement-read.ts:194, src/server/dal/engagement.ts:107
      why:    T090's consumer calls `markWithdrawn`/`markEditedUpstream` unconditionally whenever the
              provider repeats `upstream` for an item, and both DAL methods are plain unguarded
              `UPDATE ... SET withdrawn_at = $at` (`dal/engagement.ts:107-112`). A provider that
              keeps reporting the same item as withdrawn — which is what a provider that reports it
              at all will do — moves the timestamp forward every run. FR-011 requires the change be
              "recorded beside the item as a new fact"; a fact whose date is always today is not one.
              It is latent rather than live today because no Bluesky read ever sets `upstream`
              (`docs/engagement.md:56`), so only the mock exercises it. Related: a *second* upstream
              edit after a reviewer acknowledged the first re-stamps `edited_upstream_at` but leaves
              `acknowledged_edit_at` set, so FR-011's "blocked from sending until a reviewer looks
              again" does not re-arm.
      owed:   Stamp only when the column is still null, and on a re-edit clear the drafts'
              `acknowledged_edit_at` so the gate re-arms.
      traces: FR-011, FR-061

- [ ] MINOR F28 — The draft history shows members the database's internal wait vocabulary.
      where:  src/app/p/[projectSlug]/inbox/[itemId]/ReplyPanel.tsx:72, src/server/scheduler/engagement-budget.ts:32, src/server/scheduler/engagement-send.ts:119
      why:    `send_wait_reason` carries `mayAttemptReply`'s raw verdict — `write_allowance` or
              `per_run_cap` (`engagement-budget.ts:32`, written through at
              `engagement-send.ts:119`) — and the new history entry interpolates it straight into
              prose: "Approved by Ada · Waiting to send: write_allowance". This is the user-visible
              face of the vocabulary drift the first round recorded as F19 (data-model.md §3 fixes
              the column to `write_allowance | retry | later_run`, and `per_run_cap` is a fourth
              undocumented value with no CHECK guarding it). FR-043's "MUST be shown as waiting" is
              met; the sentence is not something to put in front of a person.
      owed:   Map the reason to a sentence in the UI ("waiting for this account's hourly write
              allowance" / "waiting for the next run"), and settle the column's vocabulary.
      traces: FR-043, data-model.md §3, carried from F19

- [ ] MINOR F29 — `not_replyable` is still a declared `approveReply` refusal that no path produces,
      so a draft can be approved for an account that has since been disconnected.
      where:  src/server/services/engagement/review.ts:19, specs/077-engagement-inbox/contracts/services.md:94
      why:    T095 added the `over_limit` half of F10 and left the other half: `ReplyDecisionRefusal`
              declares `not_replyable` and contracts/services.md §4 lists it as an `approveReply`
              refusal, but `approveReply` checks empty text, the limit, withdrawn, edited-upstream
              and the ledger — never the account's status or the provider's `canReply`, which only
              `requestDraft`/`writeReply` check (`services/engagement/draft.ts:33,118`). Request a
              draft, let the account go `needs_reauth`, approve: the approval succeeds, the draft
              goes `waiting`, and the send gate refuses it every tick with no `send_not_before`
              (`engagement-send.ts:83`) — the no-backoff spin the first round recorded as F18.
              Nothing wrong is sent; the member is told "Waiting to send" about a reply that cannot
              go until the account is reconnected.
      owed:   Re-check replyability in `approveReply` and return `not_replyable`, or drop the code
              from the union and from the contract.
      traces: FR-036, carried from F10 and F18

- NOTE F30 — Carried forward unfixed from the first round, correctly, because MINOR findings do not
  block: **F14** `src/lib/engagement/identity.ts:16` still has no importer and FR-017's "MUST say
  plainly that it cannot tell" is implemented nowhere (`author_identity_stable` is stored and
  carried into `InboxItemView` but no surface renders it); **F16**
  `src/server/services/failures.ts:238,253` — `markReplySent`/`markReplyNotSent` still accept a
  draft in any send state, so calling the action directly on a `needs_review` draft trips
  `engagement_drafts_send_requires_approved`; **F17** `src/server/scheduler/engagement-read.ts:287`
  — the `credentials_invalid` read branch still sets no `read_not_before`; **F18**
  `src/server/scheduler/engagement-send.ts:83` — a gate refusal still leaves `send_not_before` null
  and `send_attempts` (a `smallint`) uncapped; **F19** the `send_wait_reason` vocabulary drift (now
  user-visible, see F28) and the read-only draft on `/review` versus contracts/services.md §4.
  **F15 was fixed** in passing by T087's rework: the crash-recovery branch no longer nulls the
  reason it just wrote (`engagement-send.ts:129-141`).

- NOTE F31 — The `sleep(ms, signal)` helper added to `src/providers/mock/engagement.ts:6` for the
  overlap test duplicates the identical private helper at `src/providers/mock/index.ts:9`. It is in a
  mock and the original is module-private, so this is the cheap path rather than a defect; worth
  exporting one of them next time either is touched.

- NOTE F32 — `markReplySent` (`src/server/services/failures.ts:238`) and the duplicate-send path
  (`src/server/scheduler/engagement-send.ts:216`) both store `external_reply_id = ''` to satisfy
  `engagement_drafts_sent_fields`, and `markReplyNotSent` (`:262`) clears `sent_text`/`sent_at` but
  leaves `external_reply_id`/`external_reply_url` in place. No constraint objects and the new history
  entry only renders the link when `send_state = 'sent'`, so nothing is visibly wrong today; the
  stale columns are a trap for the next reader. Unchanged by this remediation, recorded because the
  new UI is the first thing to read those columns.

- NOTE F33 — `recordOutcome`'s `sent` branch conditions the draft write on the lease token but not
  the `markAnswered` or the `engagement_replied` event in the same transaction
  (`src/server/scheduler/engagement-send.ts:216-238`), so a worker that lost its lease would mark
  the item answered without recording the send. Recorded as an observation, not a finding:
  `SCHEDULER_LEASE_SECONDS` floors at 60 and defaults to 300 while
  `SCHEDULER_PROVIDER_TIMEOUT_SECONDS` caps at 20 (`src/server/env.ts:346-347`), so a live process
  cannot outlive its send lease, and a killed one writes nothing. Also, unlike the house pattern
  (`recordWithLease`/`releaseLease`, `src/server/dal/scheduler.ts:323-336`), the new
  token-conditioned `update()` returns `void`, so a lost lease is silent rather than reported — the
  `read-lease.test.ts` assertion proves the write is dropped but nothing tells the caller.

## Coverage

| Checked | Count | Fixed | Partially fixed | Not fixed | New defect |
|---|---|---|---|---|---|
| First-round BLOCKER/MAJOR findings F1–F13 (tasks T085–T098) | 13 | 12 | 1 (F13 → F26) | 0 | — |
| First-round MINOR findings F14–F19 (untasked, non-blocking) | 6 | 1 (F15) | 0 | 5 (carried, F30) | — |
| Remediation diff reviewed for regressions | 31 files | — | — | — | 1 (F25) |

Per-finding verification, with what proves it:

| Finding | Task | Verdict | Evidence |
|---|---|---|---|
| F1 reading latches | T085, T086 | fixed | `engagement-read.ts:127-128` (the persisted cursor drives `older` only; `freshCursor` restarts at null), `:187-190` (`anyAlreadyStored` from the insert result), `:205` (break on overlap in the newest direction); mock pages on an offset cursor (`mock/engagement.ts:68-72`); `ingest.test.ts:166` catches up 500 items, `:231` restarts after `cursor_lost` |
| F2 send claim ignores the lease | T087 | fixed | `engagement-claims.ts:33` lease predicate; every outcome write passes `token` (`engagement-send.ts:70,128,147,217,244,264`); `send.test.ts:137` runs two overlapping passes and exactly one send happens |
| F3 ledger liveness | T088 | fixed | `released_at` column + `engagement_reply_claims_release_pair` (`schema/engagement.ts:180,188`), migration `0038`; `release()` (`dal/engagement.ts:409`); all three call sites now test `releasedAt === null` (`engagement-send.ts:124`, `services/engagement/review.ts:112`, `inbox.ts:110`); `send.test.ts:150` proves generation 2 refuses a third approval |
| F4 parent never linked | T089 | fixed | project-scoped `targets.getByExternalId` (`dal/targets.ts:327`), resolved at `engagement-read.ts:165`; `ingest.test.ts:53` now asserts `docket_post` with the brand's own text |
| F5 `upstream` had no consumer | T090 | fixed | `engagement-read.ts:194-195`; mock fixture field (`mock/settings.ts:14`); `ingest.test.ts:101,118` cover both signals; `docs/engagement.md:53-57` states the Bluesky gap instead of the behaviour. Timestamp accuracy → F27 |
| F6 privacy claim inverted | T091 | fixed | `docs/engagement.md:46-48` now matches `prompt.ts`'s `who()`; `tests/unit/engagement/prompt.test.ts` pins name-present / handle-absent / "Someone" |
| F7 read lease never expires | T092 | fixed | `engagement-read-claims.ts:66`; `read-lease.test.ts:17` proves live-lease refusal, post-expiry reclaim, and that the stale token's commit is dropped |
| F8 dismiss crashes on answered | T093 | fixed | `services/engagement/review.ts:153` (`state !== "waiting"`), `page.tsx:92` (`dismissed={item.state !== "waiting"}`); `review-reply.test.ts:127` |
| F9 failed send blocks the item | T094 | fixed | `engagement-send.ts:259-268` rejects the draft with its reason and `send_state = 'none'`, freeing `engagement_drafts_one_live_answer_uq`; `send.test.ts:150` approves and sends a second draft afterwards. Surfaced on the item page by T098's history rather than on `/failures` — acceptable: the item stays `waiting` in the inbox |
| F10 over-limit approvable | T095 | fixed (`over_limit`) | `services/engagement/review.ts:101-106`, send-gate backstop `engagement-send.ts:92-97`, `ReplyList.tsx:116` `disabled={over}`; `review-reply.test.ts:139`. The `not_replyable` half → F29 |
| F11 ingest suite hollow | T096 | fixed | all five cases present (`ingest.test.ts:150,166,181,195,212`) and the no-declaration case now connects a `tiktok` account (`:74-81`). The one gap this leaves → F25 |
| F12 `auto_draft` dead switch | T097 | fixed (cut) | migration `0039` drops the column; repo method, service and view field gone; `spec.md:53` Decision, FR-022, FR-023, SC-009, the glossary entry and `contracts/services.md:50,80` all amended; no reference survives outside `review.md` |
| F13 approved replies invisible | T098 | partially fixed | `DraftView` + `resolveDraftViews` (`inbox.ts:21,45`), `DraftHistoryEntry` (`ReplyPanel.tsx:19`) render waiting / sent / failed / ambiguous / rejected / discarded with requester, approver, times and link; `review-reply.test.ts:178` covers it. A second `needs_review` draft renders nothing → F26 |

I did not re-verify the first round's 69 FRs, 16 SCs and 7 constitution principles
one by one; that sweep is in the previous revision of this file (git history for
`specs/077-engagement-inbox/review.md`) and the constitution scopes a re-review to
the remediation.

## What I could not check

- **The browser.** F26 is traced through the JSX and the data that reaches it, not
  rendered. The empty-heading claim follows from `drafts.some(…)` being true while
  every entry returns `null`; I did not drive the page to see it. Same for the
  Approve button's new `disabled={over}` and the hidden Dismiss control — read,
  not clicked.
- **F25 by execution.** It is proved by reading: the inserts commit on the plain
  client (`dal/scheduler.ts:312,315`), the `stop` return at `:212` precedes the
  event at `:236`, and `insertIfAbsent`'s idempotence makes the miss permanent.
  Writing a test for it would be writing code, which this phase may not do.
- **`pnpm lint`, `pnpm typecheck`, `pnpm db:check`, `pnpm build` and the full
  suite.** Deliberately not re-run — the constitution's "run checks in proportion
  to the change" forbids a review re-running what implement's final pass and CI
  already ran on the same commits. I ran only the 13 engagement-related test files
  (65 tests, all pass). Note the project's standing caveat that local green is
  weaker than CI green on the ffmpeg-dependent video tests.
- **Anything requiring the network.** No live Bluesky call, so the F1 fix's
  premise — that `app.bsky.notification.listNotifications` paginates backwards and
  has no `since` — still rests on the installed lexicon's parameter list rather
  than an observation. The fix is correct either way: restarting the newest
  direction from `cursor: null` is right for both a backwards and a forwards
  cursor.
- **Real-platform deletion and edit signals**, which is why F27 is stated as a
  latent timestamp defect rather than a live one.
- **The Meta identity spike (T083/T084)**, still correctly recorded as unachievable
  by the pipeline and still owed by a person with a live Standard Access app.
- **Performance.** `resolveDraftViews` adds one `members.list()` per inbox item
  that has drafts, on top of the roughly six queries per item the first round
  counted by reading. Most inbox items have no drafts, so I did not raise it as a
  finding, but nobody has measured `listInbox` against the per-screen budget.
