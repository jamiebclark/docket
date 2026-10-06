# Feature Specification: Retry a failed target now, into the next free slot, or at a picked time

**Feature Branch**: `012-retry-modes`

**Created**: 2026-10-06

**Status**: Draft

**Input**: User description: "Today `retryTarget` (src/server/services/posts/index.ts) only puts a failed target back to `scheduled` with `nextAttemptAt = now`, keeping its old schedule kind and instant. Give the retry of a single failed target three modes, chosen by the user: (1) `now` — today's behaviour, unchanged; (2) `requeue` — allocate the next free slot for the target's account, exactly as the ambiguous path does in `resolveAmbiguous` (gate → `allocateNextFree` with `after: now`, `expected` instant from the preview so the result reports `changedFromPreview`, held occurrence taken inside the same transaction); (3) `at` — schedule at an explicit future instant, with the same rules as `scheduleAt`/`scheduleExplicit` (refuse `in_past`, return `nearQueuedWarnings`, clear any held slot occurrence and switch `scheduleKind` to `explicit`). Service layer: extend `retryTarget(scope, targetId, input)` with a Zod-validated input `{ mode: 'now' } | { mode: 'requeue', expected?: iso } | { mode: 'at', at: iso }` (an absent input means `now`, so existing callers and tests keep working), returning a result union in the style of `ResolveResult` (scheduled with scheduledAt/localTime/slotId|null/changedFromPreview/warnings, or a typed failure). Keep every existing guard: post lock then target lock via `withLockedTarget`, status must be `failed` (ConflictError otherwise, incl. `publishing`), `retryBlockedReason` for removed/needs_reauth accounts and missing providers, the `{ statuses: ['failed'] }` update guard, and reset of attemptCount/stepState/firstStepAt/publishStartedAt/lastError. Requeue with no free slot (`no_active_slots` / `no_free_occurrence`) must leave the target `failed`, unchanged except for an explanatory message, and report the reason — never half-schedule it. Validation failures from `gate` are reported, not swallowed. The requeue preview reuses `previewRequeue` in src/server/services/failures.ts (make sure it is correct for a failed target, not only an ambiguous one, including a target that still holds or has lost its old occurrence). Attempt log: keep writing `retry_requested` with the actor; for `requeue` and `at` also record the new instant (and slot id) in `requestSummary`, following the `requeued` entry `resolveAmbiguous` writes; if a new `publish_attempt_outcome` value is needed, add it with a committed SQL migration and keep `pnpm db:check` green. UI: replace the single Retry button in src/components/targets/TargetResolution.tsx with a retry control offering the three modes — a dialog that loads the next-free-slot preview (same loading / no_free_slot / account_unavailable handling as the 'Mark not published…' dialog) and a date-time field in the project time zone for 'pick a time' (Temporal, explicit DST disambiguation, as the composer's schedule-at already does). It must work in both places that render TargetResolution: the Failures page (`variant=\"row\"`) and the post page (`variant=\"detail\"`). Announce the outcome through the LiveRegion, label every control, keep full keyboard use, follow the docket-ui skill and docs/design-system.md. Server actions in src/app/p/[projectSlug]/posts/actions.ts pass the mode through; role checks stay on the server (`post: ['schedule']`). Tests: integration tests for each mode, the no-free-slot path, in_past, blocked accounts, concurrent retry vs scheduler claim and vs a second retry, slot double-booking when two failed targets on one account are requeued at once, DST around a picked time, and action authz. Update docs (README or the relevant docs/*.md section on failures) and log judgement calls in docs/decisions.md. This entry does NOT add any bulk / 'Retry all failed' action — `bulk-retry-failures` builds that on top of the per-target modes defined here. It does NOT change `resolveAmbiguous` or the ambiguous dialogs beyond any shared refactor, and it does NOT add or change any public API endpoint, OpenAPI schema or API-key attribution — `api-retry-resolve` owns all of that."

## Context and sources

- Roadmap (`.specify/roadmaps/failure-recovery-completeness-roadmap-th.json`, entry `retry-reschedule-modes`): the first of three entries. `bulk-retry-failures` (retry every failed target, now or into the next free slots) and `api-retry-resolve` (retry and ambiguous resolution over the public API) both build on the per-target modes defined here, so the modes and their result shape must be reusable as-is by another caller.
- Behaviour on `main` that this feature changes or reuses (read from the current code):
  - **Retry today** puts a `failed` target back to `scheduled` with its next attempt set to now, and resets the attempt count, step progress, first-step and publish-start times and last error. It keeps the target's old schedule kind, its old intended time and any slot occurrence it still holds. It refuses with a conflict when the target is `publishing` or no longer `failed`, and when the account was removed, needs reconnecting, or its provider is gone (the reason is shown to the user in those words). It writes one `retry_requested` attempt entry with the acting member. The UI shows one "Retry" button and announces "Retry queued for the next tick."
  - **Requeue after an ambiguous outcome** ("Mark not published…" with requeue) checks that the target can still be published (content validation and account availability), then takes the earliest free slot occurrence of the account after now inside the same transaction. When the user's dialog showed a preview time, the result says whether the time changed. If no slot is free, the target is marked failed with an explanation instead. It writes a `requeued` attempt entry whose request summary holds the new instant and slot id.
  - **Requeue preview** (used by the "Mark not published…" dialog) shows the next free slot time for the target's account without writing anything, or one of: no active slots, no free occurrence in the queue horizon, account unavailable, or content no longer valid. The dialog shows a loading state, the time, or the reason.
  - **Schedule at a picked time** (composer) refuses a time that is not in the future ("That time has passed. Use Publish now instead."), returns non-blocking warnings when another queued post on the same account is within the configured warning window, releases any slot occurrence the target held and records the target as explicitly scheduled. The composer turns a typed wall-clock time in the project's time zone into an instant with explicit DST handling: a time that falls in a spring-forward gap is moved to the time that actually exists and the user is told; a time that occurs twice in a fall-back overlap uses the earlier one and the user is told.
  - **Slot occupancy**: every target that holds an occurrence counts it as taken, whatever its status. A failed target may therefore still hold the occurrence it was originally queued into, or may have lost it (released by the engine, its slot paused or deleted).
  - **Attempt outcomes**: `retry_requested` and `requeued` already exist as user-action outcomes, so no new outcome value is expected.
- Places that show the retry control: the Failures page (one row per target) and the post page (per-target detail).
- No external platform facts are involved; nothing here needs `docs/research/`. No new runtime dependency is expected.

## Decisions made while specifying

These are judgement calls; planning records each in `docs/decisions.md`.

- **D1 — One "Retry…" control opens a dialog with the three modes; "now" is preselected.** Retrying immediately stays two keystrokes away (open, confirm), and the user sees the other choices every time. The dialog title names the account, as the other target dialogs do.
- **D2 — The target's own held occurrence does not count against it.** When previewing or allocating the next free slot for a failed target, an occurrence the target itself still holds is treated as free for that target (and only that target). Preview and allocation apply the same rule, so they agree. After a requeue the target holds exactly one occurrence — the new one — and any old one is released for other posts. A past occurrence is never offered, because the search starts after now.
- **D3 — A refused requeue updates only the visible message and writes an attempt entry.** When no slot is free, the target stays `failed`, its last-error text becomes an explanation ("Not retried — {account} has no free posting slot. Retry now or pick a time." / "…has no active posting slots…"), and nothing else on the target changes. A `retry_requested` attempt entry with the actor and the reason (`no_free_slot`) is written, so the history shows that someone tried. The original failure remains readable in the attempt history.
- **D4 — "Now" reports the retry instant.** The `now` result reports the time of the retry as its scheduled time, no slot, `changedFromPreview` false and no warnings. What is stored on the target is unchanged from today (old kind, old intended time, any held occurrence kept).
- **D5 — Content and account checks apply to "requeue" and "at", not to "now".** `now` keeps today's checks exactly (the publish engine validates when it runs). `requeue` and `at` check the target's content and account before writing, as requeue-after-ambiguous and schedule-at do, and report a failure instead of scheduling a post that cannot go out.
- **D6 — The preview refuses a target that is neither failed nor ambiguous.** It reports a conflict ("This post is no longer failed.") rather than a time, so a stale dialog does not offer a slot for a target that has already moved on.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Retry a failed post into the next free slot (Priority: P1)

A team member sees a post that failed on one account (for example the platform was down at the queued time). Retrying it immediately would crowd it next to whatever is going out now, so they choose "Next free slot". The dialog shows the time of the account's next free posting slot; they confirm, and the post is queued there like any other slotted post.

**Why this priority**: It is the main gap — today the only retry is "now", which ignores the account's posting rhythm. It is also the riskiest part (slot allocation for failed targets, held occurrences, races) that the later bulk-retry entry depends on.

**Independent Test**: Make a target fail on an account with posting slots, open the retry dialog, pick "Next free slot", confirm, and check that the target is scheduled at the previewed occurrence, holds it, and is attempted at that time.

**Acceptance Scenarios**:

1. **Given** a failed target on an account with a free slot occurrence tomorrow at 09:00 project time, **When** the user opens "Retry…", picks "Next free slot" and confirms, **Then** the target becomes `scheduled` as a slotted post at that occurrence, its attempt count, step progress, start times and last error are cleared, the outcome is announced with the local time, and the attempt history shows a retry by that member with the new time and slot.
2. **Given** the dialog previewed 09:00 but another post took that occurrence before the user confirmed, **When** the user confirms, **Then** the target is scheduled at the next free occurrence instead and the announcement says the time changed from the preview.
3. **Given** a failed target whose account has no active slots, or no free occurrence within the queue horizon, **When** the dialog opens, **Then** it shows that reason and does not offer "Next free slot" as confirmable; **and When** the slots fill up between preview and confirm, **Then** confirming leaves the target `failed` with an explanatory message, reports the reason, and schedules nothing.
4. **Given** a failed target that still holds its original (past) slot occurrence, **When** it is requeued, **Then** it ends up holding only the new occurrence.
5. **Given** a failed target that still holds a future occurrence that is otherwise free, **When** the preview loads and the user confirms, **Then** both the preview and the result offer that same occurrence (its own hold does not count against it).
6. **Given** a failed target whose content is no longer valid for its platform (for example the media was removed), **When** the user requeues it, **Then** the validation problem is reported and the target stays `failed`, unchanged.

---

### User Story 2 - Retry a failed post at a time the user picks (Priority: P2)

A team member wants the failed post to go out at a specific time — say tomorrow at 18:30 because that's when a campaign starts. They choose "Pick a time", enter the date and time in the project's time zone, see what instant it will go out at (with any DST adjustment explained and any "another post is close to this time" warnings), and confirm.

**Why this priority**: Gives full control when neither "now" nor the queue rhythm fits. Builds on the same dialog as Story 1 but is independent of slots.

**Independent Test**: Retry a failed target with "Pick a time" at a future local time and check that it is explicitly scheduled at the resolved instant, no longer holds a slot occurrence, and is attempted at that time.

**Acceptance Scenarios**:

1. **Given** a failed target, **When** the user picks a future date and time and confirms, **Then** the target becomes `scheduled` as an explicitly scheduled post at that instant, any slot occurrence it held is released, the announcement states the local time, and the attempt history records the retry with the new time.
2. **Given** another post on the same account is queued within the warning window of the picked time, **When** the user confirms, **Then** the retry succeeds and the warning is shown and announced; it does not block.
3. **Given** the picked time is now or in the past (including when it passes while the dialog is open), **When** the user confirms, **Then** nothing changes, the target stays `failed`, and the user is told the time has passed and can use "Retry now" instead.
4. **Given** the project is in a zone with daylight saving and the user types a wall-clock time that does not exist (spring-forward gap), **When** the field is filled in, **Then** the dialog shows the actual time it will go out and that it was adjusted, and confirming schedules at that instant.
5. **Given** the user types a wall-clock time that happens twice (fall-back overlap), **When** the field is filled in, **Then** the dialog states that the earlier of the two is used and confirming schedules at the earlier instant.
6. **Given** the target's content is no longer valid, **When** the user confirms a picked time, **Then** the validation problem is reported and the target stays `failed`, unchanged.

---

### User Story 3 - Retry now, as today (Priority: P3)

A team member just wants to try again immediately. They open "Retry…", leave "Now" selected and confirm. Everything behaves exactly as the current Retry button does.

**Why this priority**: Preserves existing behaviour inside the new control; low risk but must not regress.

**Independent Test**: Retry a failed target with "Now" and check the stored target and attempt history are identical to what today's retry produces; existing retry tests pass unchanged.

**Acceptance Scenarios**:

1. **Given** a failed target, **When** the user confirms "Now", **Then** the target is `scheduled` for the next scheduler pass with its old schedule kind, intended time and any held occurrence kept, the counters and error are reset as today, and "Retry queued for the next tick." is announced.
2. **Given** an existing caller that retries a target without choosing a mode, **When** it calls retry, **Then** the behaviour is the "now" mode.

---

### User Story 4 - Blocked and stale retries are refused clearly (Priority: P2)

Whatever mode is chosen, a retry that cannot go ahead is refused with a reason in plain words, and nothing is partly changed.

**Why this priority**: Protects against duplicates and confusing states; required for every mode.

**Independent Test**: Attempt each mode against a target that is publishing, already rescheduled, on a removed or disconnected account, or whose provider is gone; check each is refused with the right message and the target is untouched.

**Acceptance Scenarios**:

1. **Given** a failed target whose account was removed, needs reconnecting, or whose provider is no longer available, **When** the user views it, **Then** the retry control is not offered and the reason is shown; **and When** any mode is requested anyway, **Then** it is refused with that same reason.
2. **Given** a target that is `publishing`, **When** any retry mode is requested, **Then** it is refused with "Publishing in progress. Try again in a moment."
3. **Given** a target that another member (or another tab) has already retried, **When** a second retry of any mode is confirmed, **Then** it is refused with "This post is no longer failed." and the first retry's result stands.
4. **Given** a member whose role does not allow scheduling posts, **When** they invoke any retry mode or the preview directly, **Then** the server refuses it, whatever the UI showed.

### Edge Cases

- Two failed targets on the same account are requeued at the same moment: each gets a different occurrence; no occurrence is ever held by two targets.
- A retry and a scheduler pass run at the same time: the scheduler never claims the target in a half-retried state; it either sees it still `failed` (not claimable) or fully scheduled.
- Two retries of the same target run at the same time (any combination of modes): exactly one succeeds; the other is refused as no longer failed; the target holds at most one occurrence.
- The account is disconnected, or its last slot paused, between the dialog opening and confirming: the server re-checks and reports the reason; nothing is scheduled.
- The preview cannot be loaded (network or server error): the dialog shows the same "unavailable" handling as the "Mark not published…" dialog and "Next free slot" cannot be confirmed; "Now" and "Pick a time" stay usable.
- A failed target that has lost its old occurrence (released, slot paused or deleted): requeue simply takes the next free occurrence; there is nothing to release.
- A failed target that is explicitly scheduled (no slot) is requeued: it becomes a slotted post at the next free occurrence.
- A picked time in the far future: accepted (the same limits as composer schedule-at apply; no new upper bound).
- The post page shows several targets for one post: each target's control works on its own target only and announces its own outcome; the post's overall status updates after a retry.
- Malformed input (unknown mode, missing or non-ISO time): refused as invalid input; nothing changes.

## Requirements *(mandatory)*

### Functional Requirements

**Retry modes (service)**

- **FR-001**: The system MUST let a user retry a single failed target in one of three modes: `now`, `requeue` (next free slot of the target's account) and `at` (an explicit future instant). The mode and its parameters MUST be validated at the boundary; a `requeue` request MAY carry the instant the user was shown (`expected`); an `at` request MUST carry an ISO-8601 instant. Unknown modes or malformed instants MUST be refused as invalid input with nothing changed.
- **FR-002**: A retry request with no mode MUST behave exactly as `now`, so existing callers and tests keep working unchanged.
- **FR-003**: Every mode MUST keep today's guards: the post is locked before the target; the target is re-read under the lock; it MUST be `failed` (a `publishing` target is refused with "Publishing in progress. Try again in a moment."; any other status with "This post is no longer failed."); a removed account, an account that needs reconnecting, or a missing provider MUST refuse the retry with today's user-facing reason; the write MUST only apply if the target is still `failed` at the moment of writing; and the server MUST require the "schedule posts" permission.
- **FR-004**: Every successful retry MUST reset the attempt count, step progress, first-step time, publish-start time and last error, set the target to `scheduled`, and update the post's overall status.
- **FR-005**: `now` MUST produce exactly today's stored result: next attempt at the current time, with the old schedule kind, intended time and any held occurrence kept.
- **FR-006**: `requeue` MUST check the target's content and account (as requeue-after-ambiguous does), then take the earliest free slot occurrence of the account strictly after now within the same transaction as the status change, so the target can never be scheduled without holding its occurrence or hold an occurrence while still `failed`. The target becomes a slotted post at that occurrence, and any occurrence it held before is released.
- **FR-007**: When computing free occurrences for a failed target — in the preview and in `requeue` — an occurrence held by that same target MUST be treated as free for it, and the preview and the allocation MUST apply identical rules (D2).
- **FR-008**: When `requeue` finds no free occurrence (no active slots, or none within the queue horizon), the target MUST stay `failed` with every field unchanged except its last-error text, which MUST explain why it was not retried; the result MUST report the reason as a typed failure (D3).
- **FR-009**: When `requeue` or `at` finds the content invalid or the account unavailable, the result MUST report that failure with its message (and any field-level issues) and leave the target unchanged; the failure MUST NOT be hidden or turned into a generic error.
- **FR-010**: `at` MUST refuse an instant that is not after the current time with an `in_past` failure, leaving the target unchanged.
- **FR-011**: A successful `at` MUST release any slot occurrence the target held, mark it as explicitly scheduled at the given instant (intended time and next attempt both set to it) and return the warnings for other queued posts of the same account within the configured warning window, excluding the target itself. Warnings never block.
- **FR-012**: Every retry result MUST be one of: *scheduled* — with the scheduled instant, its local time in the project's zone, the slot (or none), whether the time differs from the `expected` instant the user was shown (`requeue` only; otherwise false), and any warnings — or a *typed failure* with a reason code (at least: no active slots / no free slot, in the past, validation, account unavailable) and a user-facing message. Conflicts and permission refusals keep today's error behaviour. The `now` result follows D4.
- **FR-013**: Every retry attempt by a user MUST write a `retry_requested` attempt entry with the acting member. For a successful `requeue` or `at`, the entry (or a companion entry in the same transaction, following the `requeued` entry that requeue-after-ambiguous writes) MUST record the new instant and, for `requeue`, the slot. A refused `requeue` (no free slot) MUST record the reason (D3). If a new attempt outcome value is needed, it MUST be added with a committed migration and the schema check MUST stay green.

**Requeue preview**

- **FR-014**: The next-free-slot preview MUST be correct for a failed target as well as an ambiguous one: it MUST write nothing, apply FR-007, report the account's next free occurrence after now with its local time and slot, or one of: no active slots, no free occurrence, account unavailable (including removed, disconnected or provider gone), or invalid content. It MUST refuse a target that is neither failed nor ambiguous (D6). It MUST require the "schedule posts" permission.

**Interface**

- **FR-015**: Where today a failed target shows a single "Retry" button, the system MUST show one "Retry…" control that opens a dialog naming the account and offering the three modes as a labelled single choice, with "Now" preselected (D1). It MUST appear wherever a failed target's resolution controls appear: each row of the Failures page and each target on the post page.
- **FR-016**: When the dialog opens it MUST load the next-free-slot preview and show a loading state, then the local time of the next free slot, or the reason none is available — matching how the "Mark not published…" dialog handles loading, no free slot and account unavailable. "Next free slot" MUST NOT be confirmable while the preview is loading or reports no slot; the other modes stay usable. Confirming "Next free slot" MUST send the previewed instant so a changed time can be reported.
- **FR-017**: "Pick a time" MUST offer a labelled date-and-time field in the project's time zone (the zone is shown). As the user enters a time, the dialog MUST show the instant it resolves to with explicit DST handling identical to the composer's schedule-at: a non-existent time is moved forward to the time that exists and the user is told; a repeated time uses the earlier occurrence and the user is told; a time in the past is flagged before submission; near-post warnings are shown. Confirming sends the resolved instant.
- **FR-018**: The outcome MUST be announced through the page's live region: "Retry queued for the next tick." for `now`; the local time (and slot) for `requeue`, adding that the time changed from the preview when it did; the local time and any warnings for `at`; the reason for any typed failure or refusal. On success the dialog closes and focus returns to a sensible place; on failure the dialog stays open with the message so the user can choose another mode.
- **FR-019**: Every control in the dialog MUST be labelled, fully usable by keyboard (open, move between modes, enter a time, confirm, cancel with Escape), with visible focus, and MUST follow the project's UI conventions and design system.
- **FR-020**: Targets whose retry is blocked MUST keep showing the blocked reason instead of the control, as today.

**Server actions, scope and documentation**

- **FR-021**: The UI's server action for retry MUST pass the chosen mode through to the single service retry function; role checks MUST stay on the server. The preview action MUST reuse the existing preview.
- **FR-022**: This feature MUST NOT add a bulk or "retry all failed" action, MUST NOT change requeue-after-ambiguous or its dialogs beyond a shared refactor that preserves their behaviour, and MUST NOT add or change any public API endpoint, API schema document or API-key attribution.
- **FR-023**: The documentation section that describes failures and retrying MUST describe the three modes, and every judgement call (D1–D6 and any made during planning) MUST be logged in `docs/decisions.md`.

**Tests**

- **FR-024**: Integration tests (real database) MUST cover: each mode's success path and stored state; no active slots and no free occurrence for `requeue`; `in_past` for `at`; validation failure for `requeue` and `at`; removed, disconnected and provider-missing accounts for every mode; a retry racing a scheduler pass; two retries of the same target racing (mixed modes); two failed targets on one account requeued at once getting distinct occurrences; a target that holds a future occurrence, a past occurrence and none; the preview for a failed target in each of those cases; DST gap and overlap around a picked time; the attempt-log entries; an absent mode behaving as `now`; and that members without the schedule permission are refused by the server actions.

### Key Entities *(include if feature involves data)*

- **Post target**: one post on one social account. Relevant attributes: status (`failed` → `scheduled`), schedule kind (slotted / explicit / now), intended time, next attempt time, the slot occurrence it holds (if any), attempt count, step progress, start times, last-error text. No new attributes are expected.
- **Slot occurrence**: one concrete instant produced by an account's posting slot; held by at most one target at a time.
- **Attempt entry**: append-only history row per target: step, outcome (`retry_requested`, `requeued`, …), request summary (new instant and slot for these retries), error code, acting member, time.
- **Retry request** (input, not stored): mode plus `expected` instant (requeue) or `at` instant.
- **Retry result** (output, not stored): scheduled (instant, local time, slot or none, changed-from-preview, warnings) or typed failure (reason code, message).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can retry a failed post into the account's next free slot, or at a chosen time, from either the Failures page or the post page in under 30 seconds and no more than 4 interactions (open, choose, optionally enter time, confirm).
- **SC-002**: In every tested race (two simultaneous requeues on one account, retry vs scheduler pass, retry vs retry), no slot occurrence is ever held by more than one post and no target is ever published twice or left half-scheduled — 0 violations across the test suite.
- **SC-003**: 100% of refused retries (no slot, past time, invalid content, blocked account, already retried, publishing, no permission) leave the target exactly as it was apart from the documented explanatory message, and tell the user why.
- **SC-004**: For a picked local time on a DST transition day, the instant the post is scheduled at always equals the instant shown in the dialog before confirming.
- **SC-005**: Retrying with "Now" produces stored state and history identical to the current retry; all existing retry tests pass without modification.
- **SC-006**: Every retry control and dialog can be operated with the keyboard alone and every outcome is announced to assistive technology.

## Assumptions

- The roles that may retry are unchanged: whoever has the "schedule posts" permission today.
- The queue horizon, the near-post warning window and the "explicit time must be in the future" rule are the existing configured values; no new settings.
- The existing `retry_requested` and `requeued` attempt outcomes are enough; a migration is added only if planning finds otherwise.
- Overwriting the visible last-error text on a refused requeue is acceptable because the original failure stays in the attempt history (D3).
- The composer's local-time preview (gap / overlap / past / warnings) can be reused for the dialog's "Pick a time" field; if it needs a target or account context to compute warnings, planning extends it without changing its behaviour for the composer.
- Bulk retry (`bulk-retry-failures`) and the public API (`api-retry-resolve`) are later entries and will call the service function defined here; nothing in this entry depends on them.
