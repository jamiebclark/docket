# Feature Specification: "Retry all failed" on the Failures page, now or into the next free slots

**Feature Branch**: `015-bulk-retry-failed`

**Created**: 2026-10-07

**Status**: Draft

**Input**: User description: "Add a bulk retry of every failed target matching the Failures page's current filter. Service: a new function (in src/server/services/failures.ts or next to `retryTarget`, mirroring `retryFailedItems` in src/server/services/jobs/manage.ts in shape and messaging — `{ changed, message, count }`-style result with singular/plural wording) that takes `{ account?: uuid, mode: 'now' | 'requeue' }`, re-evaluates the set of `failed` targets of live posts in the project server-side at execution time (never trusting a client-sent id list; add a DAL method alongside `listAttention` that returns all matching failed target ids, unpaginated, project-scoped), and applies the per-target retry from `retry-reschedule-modes` to each one with the same semantics. Targets whose retry is blocked (`retryBlockedReason`: removed account, needs_reauth, missing provider), that are no longer failed or are publishing, that fail the gate, or (in requeue mode) find no free slot, are skipped, not errors. Report counts: retried, and skipped broken down by reason (e.g. 'needs reconnecting', 'account removed', 'no free slot', 'no longer failed'), plus per-account detail where useful. Concurrency and locking are part of this entry: decide (and record in docs/decisions.md) whether each target is retried in its own short transaction or in one transaction with a single global lock order (posts by id, slot allocation by account as `queueTargetsInTx` does, F20) — no deadlocks against the scheduler tick or a concurrent bulk/single retry, no double effects if the button is pressed twice, bounded work per request (cap or batch with a clear message if the set is very large). Requeue mode allocates slots per account in the order the targets were meant to go out, so earlier failures get earlier slots. Permission: `post: ['schedule']`, checked on the server. Attempt logging per target is exactly what a single retry writes, with the actor. UI: on src/app/p/[projectSlug]/failures/page.tsx add a 'Retry all failed' control shown only to users who can schedule, only when the current filter can contain failed targets (hidden on the 'Needs your decision' tab) and only when there is at least one; it respects the account filter and names it ('Retry all 4 failed posts for Acme Bluesky'). It opens a confirmation dialog offering 'Retry now' vs 'Requeue into next free slots', shows how many will be retried and how many are already known to be blocked, and after running announces the retried/skipped counts through a LiveRegion and refreshes the list. Follow the docket-ui skill and docs/design-system.md; full keyboard use, labelled controls. Tests: integration tests for filter respect (account, status), skip reasons and counts, requeue ordering and no double-booking across accounts, a concurrent scheduler claim and a concurrent single retry during the bulk run, project isolation, role authz, and an idempotent second press. Update docs and docs/decisions.md. This entry does NOT offer 'pick a time' in bulk (one explicit instant for many targets is out of scope), does NOT bulk-resolve ambiguous targets, and does NOT add any public API endpoint for bulk retry — `api-retry-resolve` exposes this service function."

## Context and sources

- Roadmap (`.specify/roadmaps/failure-recovery-completeness-roadmap-th.json`, entry `bulk-retry-failures`): the second of three entries. It builds on `retry-reschedule-modes` (shipped as `specs/012-retry-modes`, merged in PR #32). The third entry, `api-retry-resolve`, will expose the bulk service function defined here over the public API, so its input, result shape and messages must be usable by an API caller as-is.
- Behaviour on `main` that this feature reuses (read from the current code and `docs/failures.md`):
  - **Single retry** (012) has three modes. **Now** puts a `failed` target back to `scheduled` with its next attempt set to now. It resets the attempt count, step progress, first-step and publish-start times and last error. It keeps the old schedule kind, intended time and any held slot occurrence, and it does not run the content and account check ("gate"). **Next free slot (requeue)** runs the gate, then takes the earliest free occurrence of the account's slots after now. An occurrence the target already holds counts as free for it (012 D2). After a requeue the target holds only the new occurrence. **Pick a time** is not used by this feature.
  - **Single-retry refusals**: a target that is `publishing` or no longer `failed` is refused with a conflict ("Publishing in progress. Try again in a moment." / "This post is no longer failed."). A removed account, an account that needs reconnecting, or a missing provider is refused with the user-facing reason ("This account was removed, so the post can't be retried." / "{account} needs to be reconnected before this post can be retried." / "The provider for {account} is no longer available."). None of these write anything.
  - **Requeue with no free slot** (012 D3): the target stays `failed`, and its last error becomes "Not retried — {account} has no free posting slot. Retry now or pick a time." (or "…has no active posting slots…"). A `retry_requested` attempt entry is written with the actor, the mode, the reason and `error: no_free_slot`. **Requeue failing the gate** (invalid content or unavailable account) is reported and writes nothing.
  - **Attempt log**: every successful retry writes one `retry_requested` entry with the acting member. Now has an empty summary. Requeue records the mode, the new instant, the slot and, when given, the previewed instant.
  - **Locking**: a single retry runs in one short transaction. It reads the target to find its post, locks the post, then locks all of that post's target rows (this waits out a scheduler claim in flight), then re-reads the target. A requeue's occurrence hold is taken inside that transaction, and a guarded status write afterwards rolls the hold back if it misses. The scheduler's claim takes no post lock: it locks due `scheduled`/`publishing` targets with `SKIP LOCKED`, then their accounts with `SKIP LOCKED`, so it never waits on a user action. Queueing several targets of one post holds occurrences in one global order (by account, then target id), so concurrent queueing of posts that share accounts cannot deadlock (the "F20" ordering in the queueing code). An occurrence can have only one holder (unique index), so two targets can never hold the same occurrence.
  - **Bulk retry precedent**: retrying a generation job's failed items returns `{ changed, message, count }` with singular/plural wording ("1 item will be retried." / "{n} items will be retried." / "There are no failed items to retry.").
  - **Failures page**: it has tabs All / Needs your decision / Failed, an account filter, 25 rows per page, and a page-level live region with the page heading as the focus fallback (012 P11). Rows show per-target actions only to people who can schedule.
  - **Roles**: owner, admin and editor all hold the "schedule posts" permission today. A scope without it (for example a future restricted role or a restricted API key) must be refused by the server.
- No external platform facts are involved and nothing here needs `docs/research/`. No new runtime dependency or schema change is expected.

## Decisions made while specifying

These are judgement calls. Planning records each one in `docs/decisions.md`.

- **D1 — Each target is retried in its own short transaction, in a fixed order, not in one big transaction.** The bulk run first reads the matching set (ids only, project-scoped, no locks). It then processes each target the way a single retry does: lock its post, lock that post's targets, re-read the target, apply the single-retry body, update the post's derived status, commit. *Why:* each transaction holds the locks of one post and, in requeue mode, occurrences of one account only. That is the same lock order as a single retry and as queueing (post, then its targets, then occurrences of one account), so no cycle can form with the scheduler tick (which never waits), a concurrent single retry, a concurrent bulk run, or queueing. Editors and the scheduler are never blocked for longer than one target's work. A run that is interrupted part-way leaves every finished target correctly retried and every other target untouched, and pressing again completes the rest. *Rejected:* one transaction with a global lock order. It would hold many post locks for the whole run, block editing and other user actions on every affected post until the end, and roll everything back on any unexpected error. It would also make "bounded work" harder to guarantee.
- **D2 — Processing order is "meant to go out" order.** Targets are processed by their intended time (earliest first), then by when they entered the failed state, then by id. Targets with no intended time come after those with one. In requeue mode this means that, within each account, an earlier failure gets an earlier slot than a later failure in the same run. The order is fixed and the same for every run, so two concurrent runs meet targets in the same sequence.
- **D3 — Skips are outcomes, not errors.** A target that cannot be retried is counted under one skip reason and the run continues. The reasons, in the words the user sees:

  | Reason key | Label | When |
  |---|---|---|
  | `account_removed` | account removed | The target's account no longer exists |
  | `needs_reconnecting` | needs reconnecting | The account is not active (it needs to be reconnected) |
  | `provider_unavailable` | provider unavailable | The account's provider is no longer registered |
  | `no_longer_failed` | no longer failed | Under the lock, the target is no longer `failed` (it was retried, resolved, cancelled or deleted elsewhere, or is `publishing`), or its post was deleted |
  | `cannot_publish` | can't be published as is | Requeue mode only: the gate refused it (invalid content or unavailable account) |
  | `no_free_slot` | no free slot | Requeue mode only: the account has no active slots or no free occurrence |

  Only an unexpected error (for example a lost database connection) aborts the run. Targets already committed stay retried, and the caller gets an error.
- **D4 — Attempt logging is exactly what a single retry writes.** A retried target gets one `retry_requested` entry with the actor (and, for requeue, the mode, instant and slot). A `no_free_slot` skip gets the same last-error message and the same `retry_requested` entry with `error: no_free_slot` that a single refused requeue writes. Every other skip writes nothing, as the matching single-retry refusal writes nothing. No bulk-level log entry, no new attempt outcome and no migration.
- **D5 — Once an account is out of slots, its remaining targets in that run skip without an attempt.** In requeue mode, when an account first reports no active slots or no free occurrence, any later target of that account in the same run is counted as `no_free_slot` without taking its locks or writing anything. *Why:* the answer cannot change within the run, and skipping keeps the work bounded. A large pile of slot-less targets on one account cannot use up a press that should reach other accounts.
- **D6 — Bounded work: at most 100 attempted targets per press, with a clear "press again" message.** The full matching set is counted on every press. Targets that are known to be blocked from their account alone (`account_removed`, `needs_reconnecting`, `provider_unavailable`) are counted without being attempted. So are D5 skips. None of these count toward the cap. Up to 100 of the remaining targets are attempted, in D2 order. Any beyond that are reported as `remaining` with a message such as "50 more failed posts were not retried yet. Press Retry all failed again to continue." Planning may tune the number (and records it in `docs/decisions.md`), but it must stay a fixed, tested cap.
- **D7 — A second press is safe by construction.** Every press re-reads the set from the database, and every target is re-checked as `failed` under its own lock before anything is written. A target retried by the first press is scheduled, so it is not in the second press's set. If both presses are in flight at once, the second meets it as `no_longer_failed`. No target is retried twice, gets two attempt entries for one retry, or holds two occurrences. A target skipped for `no_free_slot` is still `failed` and is tried again by a later press. That repeats exactly what a second single requeue would do, including a fresh `retry_requested` entry, so it is a new attempt rather than a double effect.
- **D8 — The account filter is the only scope input.** The input is `{ account?, mode }`. Leaving out `account` means every account in the project. An `account` that is not in the project (or does not exist) matches nothing, so the result is "There are no failed posts to retry." That is the same as the page's filter showing nothing, and it reveals nothing about other projects. The status filter is implied: only `failed` targets are ever retried, whatever tab the request came from.
- **D9 — "Retry now" is preselected in the dialog**, matching the single-retry dialog (012 D1). The engine's own per-account spacing still applies to targets retried "now".
- **D10 — Result shape follows `retryFailedItems`.** The result has `changed` (true when at least one target was retried), `message` (a full sentence), `count` (the number retried), `mode`, the skip counts by reason, `remaining`, and a per-account breakdown (account id and name, retried, skipped by reason). Example messages:
  - Nothing matches: "There are no failed posts to retry."
  - Now, 1 retried: "1 post will be retried."; now, *n*: "{n} posts will be retried."
  - Requeue, 1 retried: "1 post was queued into the next free slot."; requeue, *n*: "{n} posts were queued into the next free slots."
  - With skips: the sentence is followed by "Skipped {k}: {count} {label}, …" (for example "Skipped 3: 2 need reconnecting, 1 no free slot."). With nothing retried: "No posts were retried. Skipped 3: …".
  - With `remaining`: the "press again" sentence from D6 is appended.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Retry every failed post at once (Priority: P1)

A platform had an outage overnight and a dozen posts failed across several accounts. A team member opens the Failures page and, instead of retrying each row, presses "Retry all 12 failed posts". The dialog says how many will be retried and how many are already known to be blocked, with "Retry now" selected. They confirm. They hear and see "10 posts will be retried. Skipped 2: 2 need reconnecting.", and the list refreshes to show only the two blocked targets.

**Why this priority**: This is the core gap. After an outage, recovery today means one dialog per failed target.

**Independent Test**: Create failed targets on several accounts (some on a disconnected account). Press the control, confirm "Retry now", and check that every eligible target is scheduled for now with its attempt state reset and one `retry_requested` entry by that member, that the blocked ones are untouched, and that the counts match.

**Acceptance Scenarios**:

1. **Given** 12 failed targets of live posts in the project, 2 of them on an account that needs reconnecting, **When** a member who can schedule opens "Retry all 12 failed posts", keeps "Retry now" and confirms, **Then** 10 targets become `scheduled` for now exactly as a single "Retry now" would leave them, each with one `retry_requested` entry naming that member. The 2 blocked targets are unchanged and have no new entries. The announcement reads "10 posts will be retried. Skipped 2: 2 need reconnecting.", and the list refreshes.
2. **Given** the dialog is open, **Then** it states the number of failed posts in scope, how many will be retried, and how many are already known to be blocked, broken down by reason. **And When** every matching target is known to be blocked, **Then** the dialog explains why and neither confirm choice can be submitted.
3. **Given** a failed target on a deleted post, an ambiguous target and a scheduled target in the project, **When** the bulk retry runs, **Then** none of them is touched or counted.
4. **Given** the run finishes, **Then** focus moves to a sensible place that still exists (the page heading when the control has disappeared), and the result summary stays visible until the next action. When skips span more than one account, the summary lists each account with its skip reasons.

---

### User Story 2 - Requeue every failed post into its account's next free slots (Priority: P1)

Retrying a dozen posts "now" would flood followers, so the team member picks "Requeue into next free slots". Each failed target goes into the next free posting slot of its own account. On each account, the post that was meant to go out earliest gets the earliest slot.

**Why this priority**: Equal to Story 1. It is the safe way to recover a large backlog, and it is where the slot-allocation and concurrency risk sits.

**Independent Test**: Create several failed targets with different intended times on two accounts that have slots. Run in requeue mode and check that, per account, the slot order matches the intended-time order, that no two targets share an occurrence, and that each target holds exactly one (new) occurrence.

**Acceptance Scenarios**:

1. **Given** account A has failed targets meant to go out at 08:00, 09:00 and 10:00, account B has two failed targets, and both accounts have free slot occurrences, **When** the member confirms "Requeue into next free slots", **Then** A's targets take A's next three free occurrences in the order 08:00 → earliest, 10:00 → latest, B's take B's next two, no occurrence is held twice, and each requeued target holds only its new occurrence (any old one is released).
2. **Given** account A has only two free occurrences in the queue horizon and three failed targets, **When** requeue runs, **Then** the two earliest-intended targets are queued, the third stays `failed` with the message "Not retried — A has no free posting slot. Retry now or pick a time." and the `no_free_slot` attempt entry a single requeue writes, and the result counts it under "no free slot" for account A.
3. **Given** account C has no active slots and many failed targets, **When** requeue runs, **Then** C's first target is skipped with the single-requeue refusal (message and entry), C's other targets are counted as "no free slot" without being attempted, and targets on other accounts are still processed in the same press.
4. **Given** a failed target whose content is no longer valid (for example its media was removed), **When** requeue runs, **Then** it is counted as "can't be published as is", stays `failed` and unchanged, and no entry is written. **And Given** the same target in "Retry now" mode, **Then** it is retried, because "now" does not run the gate (012 D5).

---

### User Story 3 - Retry only one account's failures (Priority: P2)

The outage affected just one account. The team member filters the Failures page to "Acme Bluesky". The control now reads "Retry all 4 failed posts for Acme Bluesky", and confirming retries only that account's failed targets.

**Why this priority**: Narrows the action to what the person is looking at. It depends on Stories 1–2 but adds the filter contract that the later API entry reuses.

**Independent Test**: With failed targets on two accounts, filter to one and run. Only that account's targets change, and the counts and label name it.

**Acceptance Scenarios**:

1. **Given** the page is filtered to account "Acme Bluesky", which has 4 failed targets, while another account has 3, **When** the page renders, **Then** the control reads "Retry all 4 failed posts for Acme Bluesky" (or "Retry 1 failed post for Acme Bluesky" for one). **And When** confirmed, **Then** only those 4 targets are considered. The other account's targets are untouched and not counted.
2. **Given** the "Needs your decision" tab is active, **Then** the control is not shown. **Given** the "All" or "Failed" tab with at least one failed target in the current filter, **Then** it is shown. **Given** no failed target in the current filter, **Then** it is not shown.
3. **Given** the page is on page 2 of the list, **When** the member runs the bulk retry, **Then** every matching failed target is considered, not just the visible page.

---

### User Story 4 - Safe under concurrency and repeated presses (Priority: P1)

Two teammates press "Retry all failed" at almost the same moment, the scheduler is mid-tick, and someone is retrying one row by hand. Every failed target ends up retried exactly once, no slot is double-booked, nothing deadlocks, and nobody sees an error just because someone else got there first.

**Why this priority**: A bulk action multiplies the impact of a race. A double publish or a double-booked slot is worse than a missed post.

**Independent Test**: Run two bulk retries concurrently (mixed modes), a bulk retry concurrent with a scheduler pass, and a bulk retry concurrent with a single retry of one of its targets. Check the final state and counts.

**Acceptance Scenarios**:

1. **Given** a set of failed targets, **When** two bulk retries run concurrently, **Then** each target is retried by exactly one of them. The other counts it as "no longer failed". Each target has exactly one new `retry_requested` entry, and no occurrence is held twice.
2. **Given** a bulk "Retry now" is in progress, **When** a scheduler pass runs at the same time, **Then** both finish without deadlock or timeout. Targets already retried may be claimed and attempted by the scheduler, but each is attempted at most once by that pass, and no target that was still `failed` when claimed is attempted.
3. **Given** a bulk run is in progress, **When** someone retries one of its targets individually at the same time, **Then** exactly one retry takes effect. If the single retry wins, the bulk run counts the target as "no longer failed". If the bulk run wins, the single retry is refused with "This post is no longer failed.".
4. **Given** a completed bulk retry, **When** the same person presses again immediately, **Then** nothing already retried is touched again. The second result reports only what is still failed (for example "No posts were retried. Skipped 2: 2 need reconnecting.").
5. **Given** a requeue bulk run and a single requeue or a queueing of another post on the same account happening at the same time, **Then** they never hold the same occurrence and none of them deadlocks.

---

### User Story 5 - Large backlogs are handled in bounded steps (Priority: P3)

After a long outage there are 230 failed posts. Pressing the control retries the first 100 (earliest first) and says clearly that more remain and that pressing again continues.

**Why this priority**: Rare, but an unbounded request could time out part-way and leave the person unsure what happened.

**Independent Test**: With more failed, retriable targets than the cap, run once and check that exactly the cap's worth were attempted, in D2 order, with `remaining` and the "press again" message. Then run again and check that it continues.

**Acceptance Scenarios**:

1. **Given** 230 retriable failed targets, **When** the bulk retry runs, **Then** the 100 earliest in D2 order are retried, the result reports 130 remaining, and the message says to press again. **When** pressed again, **Then** the next 100 are retried.
2. **Given** 150 targets known to be blocked and 20 retriable ones, **When** the bulk retry runs, **Then** all 20 are retried in that press. Blocked targets do not use up the cap.
3. **Given** the dialog is opened with more retriable targets than the cap, **Then** it says that up to 100 will be retried in this step.

---

### User Story 6 - Only people who may schedule can bulk retry (Priority: P2)

**Acceptance Scenarios**:

1. **Given** a viewer whose scope lacks the "schedule posts" permission, **Then** the control is not shown. **And When** they invoke the bulk retry (or its dialog preview) directly through the server action or the service, **Then** the server refuses it and nothing changes.
2. **Given** two projects, **When** a member of project 1 runs the bulk retry, with or without an account filter naming an account of project 2, **Then** no target, slot or attempt entry of project 2 is read into the result or changed.

### Edge Cases

- **Target changes between the count and the run**: the dialog's numbers are a snapshot. The result reports what actually happened, and anything that changed in between is counted under its real reason.
- **Target becomes `publishing` mid-run** (claimed by the scheduler after being retried elsewhere): counted as "no longer failed". The run never waits on a claim beyond the post lock a single retry already takes.
- **Post deleted mid-run**: its targets are counted as "no longer failed".
- **Account disconnected mid-run**: targets processed after that moment are skipped as "needs reconnecting". Targets already retried stay retried, and the engine handles them as it does any scheduled target on a disconnected account.
- **A failed target holds its own future occurrence** (requeue): that occurrence counts as free for it (012 D2), so it may keep its slot. A later target of the same account never takes an occurrence still held by an earlier target in the run.
- **Failed targets of one post on several accounts**: each target is processed separately, in D2 order. The post's derived status is updated after each.
- **No failed targets at all**: the control is hidden. A direct call returns `changed: false` with "There are no failed posts to retry.".
- **Unexpected error mid-run**: the run stops and reports an error ("Some posts may have been retried. Reload the page to see where things stand."). Already committed targets stay retried, and pressing again continues safely.
- **Invalid input** (unknown mode, malformed account id): refused as bad input before anything is read.
- **The person closes the dialog or navigates away while the run is in progress**: the run completes on the server. The page shows the refreshed state the next time it is loaded.

## Requirements *(mandatory)*

### Functional Requirements

**Service**

- **FR-001**: The system MUST provide one bulk-retry service function that takes a validated input `{ account?: account id, mode: "now" | "requeue" }` and is the only implementation of bulk retry, used by the UI now and by `api-retry-resolve` later.
- **FR-002**: The service MUST require the "schedule posts" permission on the server, both before starting and inside each per-target transaction, and refuse otherwise without reading or changing any target.
- **FR-003**: The service MUST determine the set of targets itself at execution time: every `failed` target of a non-deleted post in the caller's project, limited to the given account when one is given (D8). It MUST NOT accept or use a list of target ids from the caller.
- **FR-004**: The data-access layer MUST offer a project-scoped, unpaginated read, alongside the existing attention listing, that returns the matching failed targets' ids together with what is needed for ordering and pre-classification (account, intended time, time entered failed). The read MUST use the same "live post" and project rules as the Failures list.
- **FR-005**: The service MUST process targets in D2 order, each in its own short transaction (D1), using the same locking as a single retry (post, then its targets, then re-read) and the same per-target retry body as `retryTarget` for the chosen mode. Results and stored state for each target MUST be identical to what a single retry of that target with that mode would produce.
- **FR-006**: Targets MUST be skipped, not raise errors, for the D3 reasons. Account-level reasons MAY be decided before locking from the account alone. `no_longer_failed` MUST be decided under the lock.
- **FR-007**: In requeue mode, after an account first yields no active slots or no free occurrence in a run, its later targets in that run MUST be counted as `no_free_slot` without being attempted (D5).
- **FR-008**: Each press MUST attempt at most a fixed cap of targets (100 unless planning records a different fixed number) and report the rest as `remaining`, with a message that pressing again continues (D6). Account-level skips and D5 skips MUST NOT count toward the cap.
- **FR-009**: Attempt logging per target MUST be exactly what the matching single retry writes, attributed to the acting member (D4). Skips other than `no_free_slot` MUST write nothing.
- **FR-010**: The result MUST follow D10: `changed`, `message` (with singular/plural wording), `count` retried, `mode`, skipped counts per D3 reason, `remaining`, and a per-account breakdown. The result MUST NOT include other projects' data, tokens or secrets.
- **FR-011**: Two concurrent presses, a press concurrent with a single retry, a press concurrent with queueing, and a press concurrent with a scheduler pass MUST NOT deadlock, double-retry a target, write duplicate entries for one retry, or double-book an occurrence (D7).
- **FR-012**: Pressing again after a completed run MUST NOT change any target the first run retried (D7).
- **FR-013**: Only an unexpected error MUST abort the run. Already committed targets stay as they are, and the caller receives an error.

**Dialog preview (read-only)**

- **FR-014**: The system MUST provide a read-only summary for the dialog, scoped like FR-003 and requiring the same permission: the number of failed targets in scope, how many are known to be blocked by account-level reasons (per reason), how many would be attempted, and whether the cap applies. It MUST write nothing.

**UI (Failures page)**

- **FR-015**: The Failures page MUST show a "Retry all failed" control only when all three hold: the viewer can schedule, the active tab is "All" or "Failed" (not "Needs your decision"), and at least one failed target matches the current account filter.
- **FR-016**: The control's label MUST state the count and, when an account filter is active, the account name. Examples: "Retry all 4 failed posts for Acme Bluesky", "Retry 1 failed post for Acme Bluesky", "Retry all 12 failed posts". The count covers every matching failed target, not just the visible page.
- **FR-017**: Activating the control MUST open a confirmation dialog that names the scope (the account, or all accounts). It MUST offer "Retry now" (preselected, D9) and "Requeue into next free slots" as a labelled choice, and show the FR-014 numbers with reasons and the cap note when it applies. When nothing can be attempted, it explains why and offers no submittable confirm.
- **FR-018**: While the run is in progress, the dialog MUST show a pending state and MUST NOT accept a second submit. Errors MUST be shown in the dialog as an alert.
- **FR-019**: After the run, the result message MUST be announced through the page's live region and shown as a visible summary (with per-account skip detail when skips span more than one account). The list MUST refresh, and focus MUST go to an element that still exists (the page heading when the control has gone).
- **FR-020**: Every control MUST be labelled and fully usable by keyboard (open, choose a mode, confirm, cancel with Escape, focus returned on close), following the `docket-ui` skill and `docs/design-system.md`, using the existing dialog, choice and alert components.
- **FR-021**: The UI's server action MUST pass only `{ account, mode }` to the service. It MUST NOT send target ids. Permission checks stay on the server.

**Docs and tests**

- **FR-022**: `docs/failures.md` MUST describe "Retry all failed": scope, the two modes, ordering, skip reasons, the cap and "press again", and safety under repeated presses. `docs/decisions.md` MUST record D1–D10 and any planning-level calls.
- **FR-023**: Integration tests (real database) MUST cover:
  - Filter respect: an account filter, and only `failed` targets of live posts (ambiguous, scheduled and deleted-post targets ignored).
  - Every skip reason and its count, plus the per-account breakdown.
  - Requeue ordering per account by intended time.
  - No double-booking across accounts and within an account, including a target holding its own occurrence.
  - The D5 short-circuit.
  - The cap and `remaining`, with a second press continuing.
  - Concurrency: a scheduler pass concurrent with a bulk run, a single retry concurrent with a bulk run, and two concurrent bulk runs.
  - An idempotent second press.
  - Project isolation, including a foreign account id.
  - Refusal without the schedule permission, at the service and at the server action.
  - Attempt entries identical to single retries.
  - Singular/plural messages.

### Key Entities

- **Failed target**: a post's attempt on one account whose status is `failed`. It has an account, an intended time (may be empty), when it entered the failed state, a last error, and possibly a held slot occurrence.
- **Bulk retry request**: an optional account and a mode (now or requeue). There is no list of targets.
- **Bulk retry result**: whether anything changed, a message, the retried count, the mode, skipped counts by reason, the count remaining beyond the cap, and per-account detail (account, retried, skipped by reason).
- **Bulk retry summary (preview)**: the in-scope failed count, known-blocked counts by reason, the to-be-attempted count, and whether the cap applies.
- **Attempt entry**: the existing per-target history record. This feature writes only the entries a single retry would.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After an outage affecting any number of failed posts, a person can retry all of them (or all of one account's) in at most 3 interactions (open, choose a mode, confirm), compared with 2–3 interactions per post today.
- **SC-002**: In every tested concurrent scenario (two presses, press plus single retry, press plus scheduler pass, press plus queueing), 100% of targets are retried at most once, 0 slot occurrences are double-booked, and 0 runs deadlock or time out.
- **SC-003**: In requeue mode, 100% of tested runs give each account's targets slots in the same order as their intended times.
- **SC-004**: A press handling the maximum number of attempted targets finishes, and the person sees its result, within 10 seconds on the reference deployment.
- **SC-005**: The reported counts (retried + each skip reason + remaining) always add up to the number of failed targets in scope at the start of the run.
- **SC-006**: A second press immediately after a completed press changes 0 already-retried targets.
- **SC-007**: A keyboard-only user can open the control, choose either mode, confirm or cancel, and hear the result, with no pointer.

## Assumptions

- The per-target retry body from 012 (exported for exactly this use) is reused unchanged. Any refactor is limited to what bulk retry needs to call it.
- "Intended time" is the target's stored scheduled instant from before it failed, and "time entered failed" is when the target last changed (the same value the Failures list shows as entered). Targets with no intended time sort after those with one.
- The cap of 100 attempted targets per press fits well within a server action's time budget, given that each target is a short transaction. Planning may tune the number with evidence.
- The visible result summary uses the existing alert/status component and is cleared on the next navigation or action. No persistent "bulk run" record is stored.
- The control lives in the Failures page's filter bar area, beside the account filter. Exact placement follows the `docket-ui` skill.
- Who may bulk retry is whoever holds the "schedule posts" permission today (owner, admin, editor). No new permission is introduced.
- API-key attribution of bulk retries and any public endpoint belong to `api-retry-resolve`. This entry attributes entries the same way a single retry does.

## Out of Scope

- A bulk "pick a time" (one explicit instant for many targets).
- Bulk resolution of ambiguous targets.
- Any public API endpoint, OpenAPI schema or API-key attribution for bulk retry (`api-retry-resolve`).
- Selecting individual rows to retry (the scope is the filter, not a selection).
- Changes to the single-retry dialog, `retryTarget` semantics, `resolveAmbiguous`, or the scheduler.
