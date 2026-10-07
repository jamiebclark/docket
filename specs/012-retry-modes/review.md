# Review: Retry a failed target now, into the next free slot, or at a picked time (012-retry-modes)

**Round 2: re-review after the Phase 8 remediation (T040–T044).**

Reviewed 41 files changed across 8 commits, against `2c9a1d0...HEAD`. `2c9a1d0` is the merge-base with `origin/main`, and `HEAD` is `ee0f565`.

The constitution's rule for a re-review sets the scope of this round (`.specify/memory/constitution.md:125-128`). This round checks two things: whether each round-1 finding is fixed, and whether the files the remediation changed introduced a regression. Anything else I noticed is recorded as MINOR, not as a blocker.

**Read in full:**

- The remediation commit `ee0f565`: `src/components/targets/RetryDialog.tsx`, `src/components/targets/TargetResolution.tsx`, `src/components/ui/Announce.tsx`, `tests/integration/failures/retry-concurrency.test.ts`, `tests/integration/failures/ui.test.tsx` and `specs/012-retry-modes/tasks.md`.
- The current state of those files, plus the parts they depend on: `src/components/ui/Dialog.tsx`, `src/components/ui/LiveRegion.tsx`, `src/components/ui/Button.tsx:40-62` and `src/components/targets/retry-ui.ts`.
- The service code again, to confirm the remediation did not touch it: `src/server/services/posts/{retry,gate,locked,schedule-patch}.ts`, the `queue/index.ts`, `failures.ts` and `posts/index.ts` diffs, `posts/actions.ts`, the two page diffs and `docs/failures.md`.
- To check F2 and F14: React 19.2.8's async-transition entanglement in `node_modules/react-dom/cjs/react-dom-client.development.js:5841-5871` and `:8070-8076`.
- To check F5: the scheduler claim in `src/server/dal/scheduler.ts:63-80`, plus `heldOccurrences` and `tryHoldOccurrence` in `src/server/dal/targets.ts:208-242`.

**Sampled:** `tests/helpers/{failures,retry}.ts`.

**Not re-reviewed this round:** these are unchanged since round 1 and outside the remediation, so the re-review rule leaves them out.

- `retry-modes`, `retry-occurrences`, `retry-dst` and the `authz`/`allocation` tests.
- `docs/decisions.md`, `README.md` and `docs/index.md`.
- `compose/ScheduleDialogs.tsx` and `explicit-time-text.ts`.
- The spec artifacts.
- `.specify/roadmaps/failure-recovery-completeness-roadmap-th.json`, which is the runner's untracked state.

**Run as targeted probes (allowed by `constitution.md:111-114`):**

- `pnpm vitest run tests/integration/failures/retry-concurrency.test.ts tests/integration/failures/ui.test.tsx src/components/targets/` passed: 3 files, 18 tests.
- `pnpm exec commitlint --from 2c9a1d0 --to HEAD` reported no problems.

**Not run:** the full suite, lint, typecheck and build. The constitution says review does not re-run them. The branch has no upstream, so CI has not run either.

## Verdict

Not ready to merge yet. There is one MAJOR left, and the remediation introduced it.

Four round-1 findings are fixed:

- **F1:** everything is committed in Conventional Commits that pass commitlint.
- **F2:** the preview load no longer drives the confirm button when the dialog opens.
- **F3:** identical announcements are now re-announced.
- **F4:** "Back" returns focus to "Retry…".

F5's core problem is also fixed: the race tests can now fail. The service layer is untouched and still holds up.

**The new MAJOR (F14).** The F4 fix keeps the dialog mounted, so a *successful* retry now also runs the dialog's return-focus path:

1. Focus goes back to "Retry…".
2. The page's `restoreFocus()` check runs one frame after confirming. If "Retry…" is still on screen at that point, the check sees that focus is fine and does nothing.
3. The `refresh()` then removes "Retry…": the Failures row disappears, or the post page's target becomes `scheduled`.
4. Focus falls to `<body>`.

Whether this happens depends on whether the refreshed page commits within one frame. The plan (P11) says the fallback runs *after the refresh* for exactly this reason. Before the remediation this path was robust, because unmounting the dialog dropped focus to `<body>` before the check ran.

The fix is small and stays inside `RetryDialog`, `Dialog` and `Announce`. After it, re-review only F14.

The rest is MINOR and safe to ship:

- **F15:** F2's residual on the requeue-refusal path, and an F2 test that cannot fail.
- **F16:** F5's residual weak assertions.
- **F6–F9:** the open round-1 MINORs.

## Findings

- [ ] MAJOR F14 — After a successful retry, focus returns to "Retry…" and is then lost to `<body>` when the refresh removes that button; the page-heading fallback usually runs too early to catch it
      where:  src/components/targets/TargetResolution.tsx:144-147, src/components/targets/RetryDialog.tsx:98, src/components/targets/RetryDialog.tsx:101, src/components/ui/Dialog.tsx:31-32, src/components/ui/Dialog.tsx:40-43, src/components/ui/Announce.tsx:23-29, specs/012-retry-modes/research.md:147
      why:    What happens on success since the remediation:
              - **The dialog now closes instead of unmounting.** `RetryDialog` stays mounted (`TargetResolution.tsx:144-147`). So `onClose()` (`RetryDialog.tsx:98`) turns `open` false and `Dialog`'s effect calls `el.close()` (`Dialog.tsx:31-32`).
              - **Closing returns focus to the opener.** Both the native modal close and the `close` handler (`Dialog.tsx:40-43`) return focus to "Retry…".
              - **The check runs on the next frame.** `restoreFocus()` is called right after (`RetryDialog.tsx:101`). It checks once, on the next animation frame, and only acts when focus is on `<body>` or a detached node (`Announce.tsx:24-27`).
              - **The refresh lands later.** The `refresh()` tree commits only after the confirm callback returns. React 19 runs it as a transition entangled with the still-running confirm action (`react-dom-client.development.js:5841-5857`). That is after the frame callback was scheduled, and its render can take more than one frame.
              - **The result.** Whenever the frame callback runs before that commit, focus is still on the connected "Retry…" button, so the check does nothing. The commit then removes the button: on the Failures page the row leaves the list, and on the post page `status` stops being `failed`. Focus ends on `<body>`.
              Worse, if the frame callback lands before `el.close()`, the queued `close` event can move focus back onto "Retry…" *after* the heading was focused.
              Before the remediation, unmounting the open dialog dropped focus to `<body>` before the check ran, so the heading fallback worked whatever the refresh timing. P11 (`research.md:147`) specifies the fallback runs "after the refresh" for this reason. FR-018 requires focus to return to a sensible place on success.
              This is inferred from the code plus React and `<dialog>` semantics. I did not observe it in a browser.
      owed:   Make success-path focus recovery independent of refresh timing, while keeping "Back" and Escape returning focus to "Retry…" (F4). Two options:
              - Let the success path opt out of `Dialog`'s return-to-opener, for example a `returnFocus` flag or clearing `returnTo` before `onClose()`, and move focus to the page heading directly.
              - Or have `restoreFocus` keep checking until the opener is disconnected, using a `MutationObserver` or a bounded frame loop, and then focus the heading if focus is on `<body>`, detached, or still on the removed opener.
              Add the success case on both pages, including a Failures page with several rows, to T039's manual check.
      traces: FR-018, SC-006, plan P11 (`research.md:147`), contracts/ui.md "Announcements and focus", Constitution — Engineering Constraints (Accessibility)

- [ ] MINOR F15 — F2's residual: after a confirm fails while a preview load is in flight, the confirm button stays disabled and reads "Retrying…" until the preview arrives; and the new F2 test cannot fail
      where:  src/components/targets/RetryDialog.tsx:44-46, src/components/targets/RetryDialog.tsx:107-110, src/components/targets/RetryDialog.tsx:155, tests/integration/failures/ui.test.tsx:129-144
      why:    **The residual.** React 19 entangles overlapping async transitions. Each `isPending=false` update shares one lane, and rendering that lane suspends until every pending action has finished (`react-dom-client.development.js:5841-5871`, `:8070-8076`). A separate `useTransition` therefore fixes the open path: `pending` is no longer set by the preview. It does not fix two other paths:
              - after a requeue refusal, `loadPreview()` starts inside the confirm transition (`:107-110`);
              - "Retry now" can be confirmed before the first preview arrives and then come back as a failure.
              On both paths the confirm's `pending` stays true until the preview resolves. During that time the button is disabled, `aria-busy` and labelled "Retrying…", right under the message "Retry now or pick a time." It recovers when the preview arrives, and the path needs a race to occur, so it is transient. F2 named the refusal path explicitly.
              **The test.** The new test renders with `renderToStaticMarkup`, where effects never run and `pending` is always false. So it passes against the pre-fix code too and cannot catch a regression.
      owed:   Don't start the preview reload from inside the confirm transition. Run the preview as a plain `async` call with `live`-flag cancellation, like the explicit-time preview at `:62-78`, so it never joins the confirm's action scope. Replace the static-markup assertion with a check that can fail, or name this explicitly in T039.
      traces: FR-016, Edge case "preview cannot be loaded"

- [ ] MINOR F16 — F5's residual: the retry-vs-scheduler race now fails only if the retry is rejected; its "publishes at most once" and "consistent state" checks, and the mixed-mode hold check, cannot fail
      where:  tests/integration/failures/retry-concurrency.test.ts:38-39, tests/integration/failures/retry-concurrency.test.ts:42, tests/integration/failures/retry-concurrency.test.ts:65-66, tests/helpers/failures.ts:16-17, src/server/db/schema/posts.ts:157
      why:    The race test's new assertion that the retry was fulfilled is real. So is the two-target test now requiring two `scheduled` results. Three assertions still cannot fail:
              - **"At most one `done` (`:42`)."** The target's account keeps the mock `fatal` behaviour (`helpers/failures.ts:16-17`), so a re-publish fails again and no `done` is ever written.
              - **The state check (`:38-39`).** The allowed statuses include every reachable one. `scheduledAt` is never null after a `now` retry, because it keeps the old slot instant.
              - **The mixed-mode hold check (`:65-66`).** A target row has one `slot_occurrence_at` column (`schema/posts.ts:157`), so `≤ 1` holds by construction.
              T044's ticked text ("consistently scheduled or claimed once, and there is at most one publish") is therefore only partly honoured. The service code these tests guard is correct: the claim is `SKIP LOCKED` and requires `status in (scheduled, publishing)` (`scheduler.ts:63-80`).
      owed:   For the hardening entry, make the scheduler race and the mixed-mode test assert things that can fail:
              - In the scheduler race, count `publish`-step attempts made after the retry (at most 1).
              - Assert either `status='scheduled'`, `nextAttemptAt = LATER` and `attemptCount = 0`, or exactly one new attempt.
              - In the mixed-mode test, assert the winner's columns: `slot` ⇔ `slotOccurrenceAt = scheduledAt`, and `at` ⇒ `slotOccurrenceAt` null.
      traces: FR-024, SC-002

- [ ] MINOR F6 — (open from round 1) Without an `AnnounceProvider`, retry outcomes are never announced and focus is never restored
      where:  src/components/targets/RetryDialog.tsx:99-101, src/components/targets/TargetResolution.tsx:148, src/components/targets/TargetResolution.tsx:116
      why:    Unchanged. `RetryDialog` announces only through `ctx?.announce`, while `TargetResolution` passes `onDone={() => undefined}` and its fallback `LiveRegion` never receives a retry message. Both render sites have a provider today.
      owed:   As in round 1: route retry outcomes into the fallback region through `onDone`, or require the provider.
      traces: contracts/ui.md "No provider", FR-018

- [ ] MINOR F7 — (open from round 1) A transport failure of the requeue preview rejects into the error boundary instead of showing "unavailable"
      where:  src/components/targets/RetryDialog.tsx:48-53, src/components/targets/RetryDialog.tsx:65
      why:    Unchanged. There is no `try/catch` around `previewRequeueAction` and no `.catch` on `previewExplicitTimeAction`.
      owed:   As in round 1: map a rejection to the "Couldn't load the next free slot." unavailable state.
      traces: Edge case "preview cannot be loaded"

- [ ] MINOR F8 — (open from round 1) After the time field is edited, the previous time preview stays confirmable until the new one arrives
      where:  src/components/targets/RetryDialog.tsx:41-42, src/components/targets/RetryDialog.tsx:95
      why:    Unchanged. `timePreview` is not tied to the `local` value it was fetched for.
      owed:   As in round 1: treat `timePreview` as null when its `local` differs from `${date}T${time}`.
      traces: FR-017, SC-004

- [ ] MINOR F9 — (open from round 1) `docs/failures.md` misstates the time zone and the no-permission case
      where:  docs/failures.md:13, docs/failures.md:31-36
      why:    Unchanged. The doc says "shown in your time zone", but the fields use the project's zone. It also lists "no permission" as a case where Retry is disabled with a reason, but the UI shows "View only" in a row and nothing at all on the post page.
      owed:   As in round 1.
      traces: FR-023

- NOTE F17 — Since the F4 fix, every `TargetResolution` mounts a closed `RetryDialog` (`TargetResolution.tsx:144-154`), including ambiguous, scheduled and retry-blocked targets. I checked whether this costs anything: no preview request fires while the dialog is closed (`RetryDialog.tsx:56`, `:63`), the date and time field ids exist only in "Pick a time" mode (`:133-136`), and a closed `<dialog>` is not in the accessibility tree. The only cost is extra hidden markup per row.
- NOTE — Round-1 notes F10–F13 still stand unchanged (`retry-modes.test.ts:83` name; unused `PageHeader` `titleId`; the bulk-retry savepoint need; the FR-013/P8 reading).

## Round-1 findings: status

| Finding | Severity | Status | Evidence |
|---|---|---|---|
| F1 implementation uncommitted | MAJOR | **Fixed** | Commits `5c5ae31`, `378a8eb`, `2505720`, `eb1d81f` and `ee0f565` are on the branch. `git status` shows only the runner's roadmap JSON untracked, and commitlint is clean. |
| F2 preview load drives confirm `pending` | MAJOR | **Fixed on open; residual → F15 (MINOR)** | `RetryDialog.tsx:46-53` uses a separate `startPreview`. The refusal path is still entangled (`:107-110`). |
| F3 identical announcements dropped | MAJOR | **Fixed** | `Announce.tsx:12-14` and `:21-22` add a trailing no-break space to every other call. It is tested at `ui.test.tsx:147-153`. |
| F4 "Back" drops focus to `<body>` | MAJOR | **Fixed for Back/Escape; regression on success → F14 (MAJOR)** | `TargetResolution.tsx:144-147` keeps the dialog mounted, keyed per open (`:118-121`), so `Dialog.tsx:31-32` and `:40-43` run. |
| F5 race tests cannot fail | MAJOR | **Fixed in core; residual → F16 (MINOR)** | The retry is asserted fulfilled (`retry-concurrency.test.ts:36`), and both targets must be `scheduled` (`:26`, `:28`). |
| F6–F9 | MINOR | Open (not in remediation scope) | Carried above. |
| F10–F13 | NOTE | Unchanged | — |

## Coverage

Counts for obligations the remediation did not touch are carried from the round-1 sweep, which covered every category the constitution lists. The rows the remediation did touch were re-checked this round: FR-016, FR-018, FR-019 and FR-024; SC-002 and SC-006; P11; the accessibility constraint; and the commits and tests workflow items.

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-024) | 24 | 22 | 2 (FR-016 F15; FR-018 F14/F6) | 0 | 0 |
| Success criteria (SC-001–SC-006) | 6 | 4 | 2 (SC-002 F16; SC-006 F14) | 0 | 0 |
| User stories (US1–US4) | 4 | 4 | 0 | 0 | 0 |
| Edge cases | 10 | 9 | 1 (preview unavailable F7/F15) | 0 | 0 |
| Plan decisions (P1–P12) | 12 | 11 | 1 (P11 F14) | 0 | 0 |
| Constitution core principles (I–VII) | 7 | 7 | 0 | 0 | 0 |
| Constitution engineering constraints (Neon, scheduler, UTC/Temporal, accessibility) | 4 | 3 | 1 (accessibility F14) | 0 | 0 |
| Constitution development workflow (commits, gates, tests, docs) | 4 | 4 | 0 | 0 | 0 |

## What I could not check

- **F14's timing in a real browser.** I could not observe whether the refreshed page commits before `restoreFocus`'s frame callback. The conclusion comes from the code, React 19.2.8's source and the `<dialog>` focus-return rules. A human must check it in T039: retry successfully on the Failures page (with several rows) and on the post page, and confirm focus lands on the heading.
- **Screen-reader behaviour (T039, still owed).** I could not hear whether VoiceOver or NVDA re-read a live-region change that differs only by a trailing no-break space (the F3 fix). I also could not hear the announcements in general.
- **Real-browser `<dialog>` focus return.** The F4 fix relies on browser behaviour I could not run: the focus return on `close()` and the timing of the `close` event. I also did not test arrow-key movement in the radio group or the visible focus ring.
- **The full suite, lint, typecheck and build.** I did not re-run them, per the constitution. CI has not run, because the branch has no upstream. My only evidence is the targeted run of the three changed or affected test files (18 passed) and commitlint.
- **Load behaviour.** I did not measure the preview or requeue occurrence walk with a full 366-day horizon on a busy account.
