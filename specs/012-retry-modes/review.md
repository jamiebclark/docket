# Review: Retry a failed target now, into the next free slot, or at a picked time (012-retry-modes)

Reviewed 41 files against `2c9a1d0` (merge-base with `origin/main`):

- 24 tracked files changed. Only the two branch commits (`3a1795d` spec, `59f18b7` plan) are committed. Every code and test change sits **uncommitted in the working tree** (see F1).
- 17 untracked files.
- The evidence is therefore `git diff 2c9a1d0` of the working tree plus the untracked files, not `git diff base...HEAD`. `HEAD` holds no implementation.

**Read in full:**

- New service code: `src/server/services/posts/{retry,locked,gate,schedule-patch}.ts`.
- New UI: `src/components/targets/{RetryDialog.tsx,retry-ui.ts,retry-ui.test.ts}`, `src/components/ui/Announce.tsx`, `src/components/schedule/explicit-time-text.ts`.
- New tests: `tests/helpers/retry.ts`, `tests/integration/failures/{retry-modes,retry-occurrences,retry-concurrency,retry-dst}.test.ts`.
- `docs/failures.md`.
- The full diffs of:
  - `src/server/services/{queue/index.ts,failures.ts,posts/index.ts}`;
  - `src/app/p/[projectSlug]/{posts/actions.ts,failures/page.tsx,posts/[postId]/page.tsx,compose/ScheduleDialogs.tsx}`;
  - `src/components/targets/TargetResolution.tsx` (also read whole) and `src/components/ui/PageHeader.tsx`;
  - `tests/helpers/failures.ts` and `tests/integration/{failures/ui.test.tsx,failures/authz.test.ts,queue/allocation.test.ts}`;
  - `README.md`, `docs/index.md`, and the `## 012` section of `docs/decisions.md`.

**Context read so I could judge the diff** (not part of it):

- UI parts: `Dialog.tsx`, `Button.tsx`, `LiveRegion.tsx`, `SegmentedControl.tsx`.
- Server: `run-action.ts`, the `post_targets` DAL (`tryHoldOccurrence`, `heldInstants`, `update`, `lockForPost`), the scheduler claim in `src/server/dal/scheduler.ts`, and `resolveAmbiguous`, `scheduleExplicit`, `listFailures` and `targetActions`.
- The composer's `ScheduleAtDialog`.

**Sampled:** `specs/012-retry-modes/research.md` and `quickstart.md`. I checked them against the code through `plan.md`, `data-model.md` and `contracts/*.md`, which restate their decisions.

**Not reviewed:** `.specify/roadmaps/failure-recovery-completeness-roadmap-th.json`. It is the roadmap runner's state, not feature code.

**Tests not re-run.** Following the constitution's review rule, I did not re-run lint, typecheck, the suite or the build. The last implement pass reports:

- lint and typecheck clean (5 lint warnings);
- `pnpm test`: 2776 passed, 2 failed. Both failures were in `tests/integration/instagram/limits.test.ts`, which passes on its own;
- `pnpm db:check` current;
- `pnpm build` passing;
- no diff under `src/app/api`.

## Verdict

The service layer satisfies the spec and fits together cleanly. I would not ship it yet:

- the UI has three cross-pass defects that break explicit accessibility and usability requirements;
- one race test cannot fail;
- none of the work is committed.

**The service and allocator hold up.**

- `retryTarget` / `retryLockedTarget` keep every old guard, and `now` is byte-for-byte the old retry.
- `requeue` takes its occurrence through the one allocator, inside the same transaction, under the `failed` write guard.
- The own-hold rule (`ownOccurrence`) is one option on one allocator, and the preview and the allocation both use it.
- `at` shares `explicitSchedulePatch` with `scheduleExplicit`.
- The refused requeue writes only `last_error` plus one attempt.
- Nothing touches the API, and no migration is needed.

**The defects are where separately built passes meet:**

- The dialog loads its preview on the same transition as its confirm. While the preview loads, "Now" cannot be confirmed and the button reads "Retrying…" (FR-016).
- The new page-level announcer drops a second identical announcement (FR-018, SC-006).
- The dialog is mounted per open, which bypasses the shared `Dialog`'s focus return, so "Back" drops focus to `<body>` (FR-019).

All three fixes are small and stay inside `RetryDialog`, `Announce` and `TargetResolution`. Fix them, make the retry-vs-scheduler race test able to fail, commit everything as conventional commits, then re-review only those points.

## Findings

- [ ] MAJOR F1 — The whole implementation is uncommitted; the branch HEAD contains only the spec and plan
      where:  `git log 2c9a1d0..HEAD` → only `3a1795d`, `59f18b7`; untracked `src/server/services/posts/retry.ts:1`, `src/components/targets/RetryDialog.tsx:1`, `specs/012-retry-modes/tasks.md:1`; modified `src/server/services/posts/index.ts:1`
      why:    The constitution's Development Workflow says to commit after each completed task and to stage explicit paths only. It also says spec artifacts are committed by the phase that writes them. The last implement pass says it did not run the optional after-implement commit hook, "so nothing is committed". `tasks.md` is also untracked. If this branch is pushed or merged as it stands, it ships the spec and plan without the feature, and CI never runs against the code.
      owed:   Commit the implementation in small Conventional Commits with explicit `git add <path>` paths, for example `feat(retry): …`, `test(retry): …`, `docs(failures): …`, and `docs(tasks): …` for `tasks.md`. Never use `git add -A` or `.`. Leave the roadmap runner's `.specify/roadmaps/*.json` out unless the runner expects it.
      traces: Constitution — Development Workflow (Commits, Quality gates)

- [ ] MAJOR F2 — While the requeue preview loads, the confirm button is disabled and reads "Retrying…" for every mode, so "Now" and "Pick a time" are not usable
      where:  src/components/targets/RetryDialog.tsx:44, src/components/targets/RetryDialog.tsx:46-51, src/components/targets/RetryDialog.tsx:53-58, src/components/targets/RetryDialog.tsx:153, src/components/ui/Button.tsx:56-61
      why:    `loadPreview` runs inside `start(...)` from the same `useTransition` whose `pending` drives the primary button. A React 19 async transition keeps `pending` true until `previewRequeueAction` resolves. During that time, on every open and after every requeue refusal (`RetryDialog.tsx:105-108`):
              - the primary button is `disabled`;
              - it is `aria-busy`;
              - it shows the pending label "Retrying…", with "Now" preselected and before anything was retried.
              A slow preview (it walks a year of occurrences and validates content) leaves "Now" unconfirmable. FR-016 says the other modes stay usable while the preview loads, and the "preview cannot be loaded" edge case says "Now" and "Pick a time" stay usable. The sibling "Mark not published…" dialog avoids this by not rendering its buttons until the preview arrives (`TargetResolution.tsx:221-235`). The static-markup test cannot see it, because effects do not run in SSR.
      owed:   Give the preview load its own state (the `preview === "loading"` it already sets is enough). Only the confirm should use `useTransition`, so `pending` means "a retry is in flight". Add a `retry-ui` or markup assertion that the confirm label is `confirmLabel(mode)` while `preview === "loading"`.
      traces: FR-016, FR-019, Edge case "preview cannot be loaded", US3-AS1

- [ ] MAJOR F3 — The shared page-level live region does not announce a second identical message, so consecutive retries are silent to screen readers
      where:  src/components/ui/Announce.tsx:15-16, src/components/ui/Announce.tsx:28, src/components/targets/RetryDialog.tsx:97, src/components/targets/TargetResolution.tsx:58-59
      why:    `announce(next)` is `setMessage(next)`. When `next` equals the current message, React bails out of the update and the `role="status"` text never changes, so assistive tech announces nothing. Before P11 each `TargetResolution` owned its own region. Now one provider-owned region serves the whole Failures page and the whole post page, so repeated text is the normal case:
              - retry two Failures rows, or two targets of one post, with "Now", and the second "Retry queued for the next tick." is never announced;
              - the same applies to "Marked published." on two ambiguous rows.
              FR-018 requires the outcome to be announced, and SC-006 requires every outcome to be.
      owed:   Make `announce` re-announce identical text. For example, clear the message then set it on the next frame, or key the text node on a counter. Add a test that two `announce` calls with the same string both reach the region, for example by asserting on the provider's state sequence through a pure helper.
      traces: FR-018, SC-006, plan P11, Edge case "post page shows several targets"

- [ ] MAJOR F4 — "Back" in the retry dialog drops keyboard focus to `<body>` instead of returning it to "Retry…"
      where:  src/components/targets/TargetResolution.tsx:140-151, src/components/targets/RetryDialog.tsx:150, src/components/ui/Dialog.tsx:25-43
      why:    `Dialog` returns focus only in the native `<dialog>` `close` handler (`Dialog.tsx:40-43`). That handler fires when its effect calls `el.close()` after `open` turns false while the dialog stays mounted, or on Escape. `TargetResolution` mounts `RetryDialog` only while `open === "retry"`, and always with `open` set (`:140-142`). So "Back" (`onClose` → `close()` → `setOpen(null)`) unmounts a modal `<dialog>` without closing it:
              - no `close` event fires;
              - `returnTo.focus()` never runs;
              - focus falls to `<body>`, and `restoreFocus()` is not called on this path.
              Escape still works, because the native close runs first. Every other dialog in `TargetResolution` stays mounted (`:153`, `:166`, `:204`) and keeps focus return. This breaks FR-019 and the constitution's "full keyboard use". T039's manual check covers Escape only, so it would miss this.
      owed:   Keep `RetryDialog` mounted and pass `open={open === "retry"}`. Reset its state on open, for example with `key` on an open counter, or by resetting state in the open effect. Alternatively, have `Dialog` close the element in an effect cleanup so unmounting restores focus too. Either fix must keep the "fresh state per open" property the comment at `RetryDialog.tsx:56` relies on.
      traces: FR-019, SC-006, Constitution — Engineering Constraints (Accessibility)

- [ ] MAJOR F5 — The retry-vs-scheduler race test cannot fail, and the two-target requeue race passes even when one target is refused
      where:  tests/integration/failures/retry-concurrency.test.ts:29-37, tests/integration/failures/retry-concurrency.test.ts:22-26, tests/integration/failures/retry-concurrency.test.ts:57-58, src/server/dal/scheduler.ts:74
      why:    Three assertions are weaker than the requirement:
              - **Retry vs scheduler (`:29-37`).** It races only `requeue` against `runTick()` at `LATER`. A requeued target gets `next_attempt_at` 2026-10-12, and a failed target is not claimable, while the claim requires `next_attempt_at <= now` (`scheduler.ts:74`). So the tick never has this target to claim, whatever the retry does. The retry's own result is ignored by `allSettled`, so a retry that threw also passes.
              - **Two failed targets requeued at once (`:22-26`).** It asserts `new Set(at).size === 2`, where a refused target contributes the string `"failed"`, so one scheduled target plus one `no_free_occurrence` refusal passes.
              - **Mixed-mode retries (`:57-58`).** It never checks "at most one occurrence held" (T032).
              FR-024 and SC-002 require these races to be tested, and the feature description names "concurrent retry vs scheduler claim".
      owed:   Race `retryTarget(…, { mode: "now" })`, whose target becomes due immediately, against `runTick()`. Assert:
              - the retry fulfilled;
              - the target ends either `scheduled` with `next_attempt_at = LATER` or claimed or attempted exactly once;
              - there is at most one `publish` attempt and no `done` duplicate.
              In the two-target test, assert both results are `scheduled` with distinct `scheduledAt`. In the mixed-mode test, assert the account holds at most one occurrence for this target.
      traces: FR-024, SC-002, Edge cases "retry and a scheduler pass", "two retries of the same target"

- [ ] MINOR F6 — Without an `AnnounceProvider`, retry outcomes are never announced and focus is never restored
      where:  src/components/targets/RetryDialog.tsx:97-99, src/components/targets/RetryDialog.tsx:104, src/components/targets/TargetResolution.tsx:144, src/components/targets/TargetResolution.tsx:115
      why:    `RetryDialog` announces only through `ctx?.announce`. `TargetResolution` passes `onDone={() => undefined}`, so its fallback `LiveRegion` never receives a retry message. `tests/integration/failures/ui.test.tsx` asserts that the region exists without a provider, which suggests the fallback works when it cannot for retries. Today both render sites have a provider, so it is safe to ship. A third caller would be silent.
      owed:   Have `TargetResolution` pass `onDone={(r) => setMessage(retryAnnouncement(r))}` and announce failures through it too, or require the provider.
      traces: contracts/ui.md "No provider", FR-018

- [ ] MINOR F7 — A transport failure of the requeue preview throws into the error boundary instead of showing "unavailable"
      where:  src/components/targets/RetryDialog.tsx:46-51, src/components/targets/TargetResolution.tsx:94-101, specs/012-retry-modes/contracts/ui.md:39
      why:    `runAction` turns service errors into `{ ok: false }`, but a network failure or a server crash outside `runAction` rejects the server-action promise. Inside an async transition that rejection reaches the nearest error boundary, so the dialog is lost. The contract's claim that this handling "covers … a network error" is wrong. It matches `openNotPublished` exactly, so this is inherited behaviour, but the spec's edge case wants "Now" and "Pick a time" to stay usable.
      owed:   Wrap the preview call in `try/catch` and map a rejection to `{ ok: false, code: "account_unavailable", message: "Couldn't load the next free slot." }`. The explicit-time preview at `RetryDialog.tsx:63` has no `.catch` either.
      traces: Edge case "preview cannot be loaded"

- [ ] MINOR F8 — After the time field is edited, the previous time preview stays confirmable until the new one arrives
      where:  src/components/targets/RetryDialog.tsx:41-42, src/components/targets/RetryDialog.tsx:60-76, src/components/targets/RetryDialog.tsx:93
      why:    `timePreview` is the last fetched result whenever both fields are filled. Edit 10:00 to 11:00 and press confirm before the new preview returns, and the retry is scheduled at the 10:00 instant. The text under the fields still shows 10:00, so SC-004 (stored = shown) technically holds, but it contradicts the field. This is inherited from `compose/ScheduleDialogs.tsx:181-182`.
      owed:   Remember the `local` string the preview was fetched for, and treat `timePreview` as `null` when it differs from `${date}T${time}`.
      traces: FR-017, SC-004

- [ ] MINOR F9 — `docs/failures.md` misstates the time zone and the no-permission case
      where:  docs/failures.md:13, docs/failures.md:31-36
      why:    "shown in your time zone" is wrong: the fields are in the **project's** time zone (`RetryDialog.tsx:133-134`). "Retry is disabled, with the reason shown, when … you do not have permission" is also wrong: without `post:schedule` a row shows "View only" and the post page shows nothing (`TargetResolution.tsx:62`), and no reason or disabled control appears.
      owed:   Say "the project's time zone". Move the permission case out of the "reason shown" list.
      traces: FR-023

- NOTE F10 — `tests/integration/failures/retry-modes.test.ts:83` is named "reports account_unavailable from the gate without writing", but it exercises the `retryBlockedReason` `ConflictError`. `retryBlockedReason` (`src/server/services/posts/retry.ts:57-59`) runs before `gate` and covers removed, disconnected and provider-missing accounts. So the gate's `account_unavailable` mapping at `retry.ts:94` and `retry.ts:141` is effectively unreachable, and no test exercises it. This is harmless, but the test name misleads.
- NOTE F11 — `PageHeader` gained a `titleId` prop (`src/components/ui/PageHeader.tsx:19-25`) that nothing uses. Both pages hand-write `<h1 id="page-title" tabIndex={-1}>` instead (`src/app/p/[projectSlug]/failures/page.tsx:174`, `src/app/p/[projectSlug]/posts/[postId]/page.tsx:62`), because neither renders `PageHeader`.
- NOTE F12 — For `bulk-retry-failures`, `retryLockedTarget` throws `ConflictError` on a guard miss (`src/server/services/posts/retry.ts:75`, `:102`, `:115`, `:142`), and this is what rolls back a requeue's hold. A bulk caller that retries many targets in one transaction needs a savepoint per target, or one stale target aborts the whole batch.
- NOTE F13 — Read literally, FR-013 ("every retry attempt … MUST write a `retry_requested` entry") conflicts with research P8, where refusals that change nothing (`in_past`, validation, conflicts) write no entry. The implementation follows P8 (`retry.ts:137-141`), and P8 is logged in `docs/decisions.md` and stated in `docs/failures.md:27`. I treat FR-013 as satisfied under that logged reading.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-024) | 24 | 20 | 4 (FR-016 F2; FR-018 F3/F6; FR-019 F4; FR-024 F5) | 0 | 0 |
| Success criteria (SC-001–SC-006) | 6 | 4 | 2 (SC-002 F5; SC-006 F3/F4) | 0 | 0 |
| User stories (US1–US4, service and UI paths) | 4 | 4 | 0 | 0 | 0 |
| Edge cases | 10 | 8 | 2 (preview unavailable F2/F7; several targets on one post F3) | 0 | 0 |
| Plan decisions (P1–P12) | 12 | 11 | 1 (P11 F3/F6) | 0 | 0 |
| Constitution core principles (I–VII) | 7 | 7 | 0 | 0 | 0 |
| Constitution engineering constraints (Neon, scheduler, UTC/Temporal, accessibility) | 4 | 3 | 1 (accessibility F3/F4) | 0 | 0 |
| Constitution development workflow (commits, gates, tests, docs) | 4 | 2 | 1 (tests F5) | 0 | 1 (commits F1) |

**Categories swept, per the constitution's first-review rule:**

- **Concurrency and locking.** The lock order is post, then the post's targets, then the occurrence savepoint. Guarded writes, rollback of the hold on a guard miss, and the unique index all hold. There is no new lock order and no change to the claim.
- **Idempotency.** Exactly one retry wins and exactly one `retry_requested` entry is written (tested).
- **Authorization and scoping.** `need` runs before and inside the transaction, everything goes through the scoped DAL, and `runAction` maps errors. Tests cover a non-member, another project's owner, a read-only key and a scope without `schedule`, in every mode.
- **Time zones and DST.** A gap or an overlap stores the previewed instant (tested). The dialog sends `preview.instant` (see F8).
- **Error and ambiguous paths.** The ambiguous path is unchanged apart from D6. On the error paths, see F2 and F7.
- **Secrets.** Attempt summaries hold only instants, ids and reason codes.
- **Every FR and SC.** Checked one by one, as in the table above.

Existing retry, resolve, requeue and concurrency tests are unmodified, which supports SC-005. In the working tree, `git status` shows no change to `tests/integration/failures/{retry,requeue,resolve,concurrency}.test.ts`, `tests/integration/posts/retry-resolve.test.ts` or `tests/integration/actions-authz.test.ts`.

## What I could not check

- **Screen-reader behaviour (T039).** I could not hear VoiceOver or NVDA announcements, or see where focus lands after a successful retry on either page. Whether `restoreFocus()`'s single `requestAnimationFrame` runs before or after the post-`refresh()` re-render removes "Retry…" is a timing question static markup cannot answer. F3 and F4 come from reading the code, not from a running browser.
- **Real-browser dialog behaviour.** I did not test `<dialog>` removal and focus fixup per browser, the arrow-key movement in the radio group, or the visible focus ring.
- **SC-001's "under 30 seconds".** It is met by design (four interactions). I did not time it.
- **Test, lint, typecheck, build and `db:check` results.** I took these from the last implement pass's report, not from a re-run (constitution review rule). I could not tell whether the two `instagram/limits.test.ts` failures are flaky or real. CI has not run, because nothing is committed (F1).
- **Load behaviour.** I did not measure the preview's or requeue's occurrence walk with a full 366-day horizon on a busy account.
