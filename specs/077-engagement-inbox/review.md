# Review: Comment and message engagement — re-review after round-2 remediation

Reviewed the 10 file(s) changed by the single round-2 remediation commit
(`29ef657`, parent `6b3f664`), against the two MAJOR findings of the previous
review (F25, F26) and the two tasks they produced (T099, T100). The whole
feature is 129 files across 15 commits (`3b8014f`...`HEAD`); per the
constitution's "Review is exhaustive once, then scoped", the exhaustive sweep of
every FR and SC happened in round 1 and is **not** repeated here. This pass
checks two things only: are F25 and F26 actually fixed, and did the remediation
break anything.

**Read in full** (the remediation diff): `src/server/scheduler/engagement-read.ts`,
`src/app/p/[projectSlug]/inbox/[itemId]/ReplyPanel.tsx`,
`src/providers/mock/engagement.ts`, `src/providers/mock/settings.ts`,
`tests/integration/engagement/ingest.test.ts`,
`tests/integration/engagement/reply-panel.test.tsx`,
`tests/integration/engagement/read-lease.test.ts`,
`tests/integration/engagement/review-reply.test.ts`, and the `tasks.md`
Phase 11 append.

**Read for context, unchanged by this remediation**: `src/lib/engagement/paging.ts`,
`src/lib/engagement/identity.ts`, `src/server/dal/engagement.ts`,
`src/server/dal/scheduler.ts`, `src/server/scheduler/index.ts`,
`src/server/services/engagement/review.ts`, `src/providers/bluesky/engagement.ts`,
`src/server/db/schema/engagement.ts`, `vitest.config.ts` +
`tests/setup/worker-databases.ts` (to judge the new test's isolation),
`data-model.md` §7, `.specify/memory/constitution.md`.

**Not reviewed**: the four `drizzle/meta/*_snapshot.json` files (46k generated
lines); anything outside the remediation diff, which rounds 1 and 2 already
swept.

**Executed**:
- `pnpm vitest run tests/integration/engagement tests/unit/engagement/prompt.test.ts tests/unit/dal/engagement.test.ts`
  — **14 files, 69 tests, all pass** (16.1 s). Up from 13 files / 65 tests before
  the remediation: +1 file (`reply-panel.test.tsx`, 2 tests) and +2 tests.
- `pnpm vitest run tests/integration/scheduler tests/integration/review tests/integration/notifications`
  — **55 files, 342 tests, all pass** (91.7 s), as the regression probe for the
  tick section and the shared review path the remediation touches.
- `pnpm lint` on the three changed source files — clean.

Per the constitution's "review: do not re-run the full suite, lint, typecheck or
build", the full suite, `pnpm typecheck`, `pnpm db:check` and `pnpm build` were
not re-run; CI on the same commits is the authority.

## Verdict

Both findings are fixed, both are covered by tests that would have caught the
original defects, and nothing in the remediation regressed earlier rounds. F25's
named failure — a run that stores items on page 1 and then meets a stop result
on page 2 — now commits the `engagement_received` event and the inserted count
for whatever landed before handing off to `handleStop`
(`src/server/scheduler/engagement-read.ts:212-231`), still without advancing the
cursor or the backfill flag, which is what FR-014 requires; the new ingest case
serves one full page then a `rate_limited` result **in the same run** and asserts
both the two items and exactly one event
(`tests/integration/engagement/ingest.test.ts:150-189`). F26's second
`needs_review` draft now renders with its origin, requester, time and the note
that approving one discards the other (`ReplyPanel.tsx:50-58`), and the "Draft
history" heading is gated on an entry that actually produces a node
(`ReplyPanel.tsx:255-269`) — proved by server-rendering the real component
against real DAL rows, both for the two-draft case and for the one-draft case
that must emit no heading (`tests/integration/engagement/reply-panel.test.tsx`).

Nothing blocks the merge. Two residues are worth recording for a hardening
entry, neither of them live: the inserts still happen outside the transaction
that carries the event, so a worker killed between the two still loses the
notification permanently, and `data-model.md` §7 step 6 still specifies
same-transaction (F34); and the rendering fix calls `DraftHistoryEntry` as a
plain function rather than as a component, which works today only because it has
no hooks (F36). The five MINORs carried from rounds 1 and 2 are still unfixed and
still correctly non-blocking (F30, F33).

## Findings

- [ ] MINOR F34 — The `engagement_received` event is still written outside the
      transaction that inserts the items, so a worker killed mid-read loses the
      notification for whatever it had already stored, permanently.
      where:  src/server/scheduler/engagement-read.ts:166, src/server/scheduler/engagement-read.ts:218, src/server/scheduler/engagement-read.ts:237, specs/077-engagement-inbox/data-model.md:249
      why:    T099 offered two fixes and the implementer took the first: account for `inserted` on
              the `stop` path. That closes the deterministic half of F25 — a stop result on a later
              page — and the new test proves it. It does not close the crash half. `insertIfAbsent`
              at `:166` still runs on the plain scheduler client inside the paging loop, committing
              per statement, while the event is written later, either at `:218` (stop) or `:254`
              (clean). A SIGTERM or OOM between the two leaves the items in the inbox with no event,
              and no later run can repair it: `insertIfAbsent` is idempotent, so those rows come
              back `inserted: false` for ever and the `if (inserted > 0)` guard never fires again.
              `data-model.md:249-250` still says the event is written "in the same transaction as
              the inserts", so the design document and the code now disagree about the one thing
              that makes the guarantee hold. The window is narrow — a kill inside a read bounded by
              three pages of at most `SCHEDULER_PROVIDER_TIMEOUT_SECONDS` each — and a worker
              restart on deploy is the realistic trigger. Non-blocking because the spec's own edge
              case ("A tick killed mid-read … Items already stored are not re-notified") tolerates
              it, the items themselves are never lost, and T099's text explicitly sanctioned the
              chosen half.
      owed:   Either move the inserts inside a transaction that also carries the event, or amend
              `data-model.md` §7 step 6 to describe what the code actually guarantees. Do not leave
              them disagreeing.
      traces: FR-046, FR-048, data-model.md §7 step 6, residue of review F25

- NOTE F35 — The new ingest case asserts a **global** tick count, not a project-scoped one.
  `expect(tick.engagementRead.counts.itemsInserted).toBe(2)`
  (`tests/integration/engagement/ingest.test.ts:174`) is the only assertion in the feature against
  `EngagementReadCounts`, and `runTick()` reads every claimable account in the worker's database,
  not just this test's. It holds today because files run sequentially inside a worker and the
  earlier ticks in this same file have already drained every other mock account that carries
  fixture items — including `retention.test.ts`'s `too-old` account, whose item *is* inside the
  horizon when the clock is pinned to `AT = 2026-10-10` even though it is outside it at real time.
  That is a long chain of accidents to depend on. The event assertion below it is scoped to the
  project through `scope.activity.list` and is not exposed to this.

- NOTE F36 — `DraftHistoryEntry` is invoked as a plain function, not rendered as a component.
  `ReplyPanel.tsx:258` calls `DraftHistoryEntry({ draft: d, tz })` inside a `.map()` so the result
  can be tested for `null` before the heading is emitted. It is correct today — the function holds
  no hooks and no state, and the element tree it returns is identical — but it collapses the
  component boundary: the entries share `ReplyPanel`'s fiber, so the day somebody adds a `useState`
  or a `useMemo` to `DraftHistoryEntry` it becomes a conditional hook call inside a loop and the
  panel crashes on a hook-order mismatch, at a distance from the edit that caused it. The same
  gate reads just as well as a `canRenderHistory(draft)` predicate beside the component, with the
  component rendered as `<DraftHistoryEntry />`. `pnpm lint` on the file is clean, so nothing will
  warn about it.

- NOTE F37 — Carried forward unfixed from rounds 1 and 2, correctly, because MINOR findings do not
  block: **F14** `src/lib/engagement/identity.ts:16,38` still has no importer anywhere in `src/` or
  `tests/` — `resolveAuthorIdentity` and `isSameAuthor` are a whole module written by an early pass
  and never wired in — and FR-017's "MUST say plainly that it cannot tell" is still rendered
  nowhere; **F16** `src/server/services/failures.ts:238,253` — `markReplySent`/`markReplyNotSent`
  still accept a draft in any send state; **F17** `src/server/scheduler/engagement-read.ts:303-308`
  — the `credentials_invalid` read branch still sets no `read_not_before`; **F18**
  `src/server/scheduler/engagement-send.ts:83` — a gate refusal still leaves `send_not_before` null
  and `send_attempts` uncapped; **F27** `src/server/dal/engagement.ts:107-112` — `markWithdrawn` /
  `markEditedUpstream` are still unguarded `UPDATE … SET … = $at`, so a provider that keeps
  reporting the same item withdrawn moves the timestamp forward every run; **F28**
  `ReplyPanel.tsx:82` still interpolates the raw `send_wait_reason` (`write_allowance`,
  `per_run_cap`) into a sentence shown to a member; **F29**
  `src/server/services/engagement/review.ts:19` still declares a `not_replyable` refusal that
  `approveReply` (`:90-125`) never produces, while `contracts/services.md:94` lists it.

- NOTE F38 — The round-2 NOTEs F31 (duplicate `sleep` helper in `src/providers/mock/engagement.ts:6`
  vs `src/providers/mock/index.ts:9`), F32 (`external_reply_id = ''` sentinel and the stale
  `external_reply_url` after `markReplyNotSent`) and F33 (`recordOutcome`'s `sent` branch
  conditions only the draft write on the lease token, and the token-conditioned `update()` returns
  `void` so a lost lease is silent) are all unchanged by this remediation and still stand as
  recorded.

- NOTE F39 — Found while checking the tree state, outside the feature and outside this phase's
  write scope: `.docket.env` is untracked **and not ignored** — `.gitignore:34` matches `.env*`,
  which does not match `.docket.env` — and it holds an API key. Nothing has committed it and the
  constitution already forbids `git add -A`, so no secret is in history; a one-line `.gitignore`
  entry would remove the trap.

## Coverage

| Checked | Count | Fixed | Partially fixed | Not fixed | New defect |
|---|---|---|---|---|---|
| Round-2 MAJOR findings F25–F26 (tasks T099–T100) | 2 | 2 | 0 | 0 | — |
| Round-2 MINOR findings F27–F29 (untasked, non-blocking) | 3 | 0 | 0 | 3 (carried, F37) | — |
| Round-1 MINOR findings F14, F16–F18 (untasked, non-blocking) | 4 | 0 | 0 | 4 (carried, F37) | — |
| Remediation diff reviewed for regressions | 10 files | — | — | — | 0 |

Per-finding verification, with what proves it:

| Finding | Task | Verdict | Evidence |
|---|---|---|---|
| F25 stop-path event loss | T099 | fixed | `engagement-read.ts:216-231` commits `last_item_at` and the `engagement_received` event in one transaction for whatever `inserted` landed, then increments `counts.itemsInserted` and `counts.accountsWithNewItems`, before handing to `handleStop` at `:232`. The cursor and `backfilling` are still deliberately not advanced (FR-014), and the two event-writing paths stay mutually exclusive — the stop branch `return`s at `:233` — so no item is notified twice. The mock gained `engagementReadFailAfterPages` (`src/providers/mock/settings.ts:50`, `src/providers/mock/engagement.ts:36-53`) so one run can serve a full page and then stop; defaulting it to `undefined` keeps `shouldFailNow` true and every pre-existing fixture byte-identical in behaviour. `ingest.test.ts:150-189` asserts both items present *and* exactly one project-scoped `engagement_received` event; reverting either half of the fix fails it (pre-fix, `inserted` was discarded on the `stop` return). |
| F26 second `needs_review` draft invisible | T100 | fixed | `ReplyPanel.tsx:50-58` renders a `needs_review` entry with origin, requester, `LocalTime` and "Approving one draft discards the other"; `:255-269` builds the history list first, drops entries whose node is `null`, and returns `null` for the whole section when nothing renders, so the heading can no longer be emitted empty. `reply-panel.test.tsx:37-71` server-renders the real component against two real `writeReply` drafts and asserts both texts, the heading and the note; `:73-98` asserts the heading is absent with one draft. `review-reply.test.ts:218-233` pins that two concurrent `needs_review` drafts are reachable at all through the service — `requestDraft`/`writeReply` do not discard siblings, only `approveReply` does. Matches spec.md's edge case "Two drafts exist and both are shown with the time each was written". |

Regression checks run against the remediation diff, all clean:

- **The mock's new page gate** cannot change any existing fixture: `engagementReadFailAfterPages`
  is optional and `undefined` short-circuits `shouldFailNow` to `true`
  (`src/providers/mock/engagement.ts:38`), which is exactly the old unconditional switch. The
  round-1 fixes that depend on the mock's paging — the 500-item catch-up and the `cursor_lost`
  restart — still pass.
- **`read-lease.test.ts:24`'s new `forThisAccount` filter** is a correctness fix, not a weakened
  assertion: `claimDueEngagementReads` claims across every project by design, so an exact total was
  never the right assertion. All four substantive assertions survive unchanged — no reclaim inside
  the lease window (`:32`), reclaim after expiry with a different token (`:37-39`), the stale
  token's commit dropped (`:45`), the live token's commit landing and releasing (`:50-51`).
- **The shared review path and the tick** are unchanged by this commit and still green across 55
  files / 342 tests.
- **No code was written outside the feature's own files**, and the working tree is clean apart from
  the untracked `.docket.env` noted above.

I did not re-verify round 1's 69 FRs, 16 SCs and 7 constitution principles one by one; that sweep
is in the first revision of this file (`git show 7db1806:specs/077-engagement-inbox/review.md`) and
the constitution scopes a re-review to the remediation.

## What I could not check

- **The browser.** F26's fix is proved by `renderToStaticMarkup` against real database rows, which
  is stronger than round 2's read-only tracing but still not a rendered page: nobody has clicked
  Edit, Approve or Dismiss on `/p/<slug>/inbox/<id>`, and the two-draft layout has not been looked
  at.
- **F34 by execution.** The remaining crash window is proved by reading — `insertIfAbsent` at
  `engagement-read.ts:166` runs on the plain client (`src/server/dal/scheduler.ts:312,315`) and the
  event is written in a later transaction — not by killing a worker mid-read. Writing that test
  would be writing code, which this phase may not do.
- **`pnpm typecheck`, `pnpm db:check`, `pnpm build` and the full suite.** Deliberately not re-run;
  the constitution forbids a review repeating what implement's final pass and CI already ran on the
  same commits. I ran the 14 engagement test files plus 55 scheduler/review/notification files, and
  `pnpm lint` on the three changed source files. The project's standing caveat applies: local green
  is weaker than CI green on the ffmpeg-dependent video tests, which this feature does not touch.
- **Anything requiring the network.** No live Bluesky call, so the premise behind the round-1 F1
  fix — that `app.bsky.notification.listNotifications` paginates backwards and has no `since` —
  still rests on the installed lexicon's parameter list rather than an observation.
- **Real-platform deletion and edit signals**, which is why F27 stays a latent timestamp defect
  rather than a live one: no Bluesky read sets `upstream`, so only the mock exercises it.
- **The Meta identity spike (T083/T084)**, still correctly recorded as unachievable by the pipeline
  and still owed by a person with a live Standard Access app, real accounts and a browser. US4 and
  US5 remain seam-only by design, which is what the plan said they would be.
- **Performance.** `resolveDraftViews` still issues one `members.list()` per inbox item that has
  drafts; nobody has measured `listInbox` against the per-screen budget, and this remediation did
  not change that either way.
