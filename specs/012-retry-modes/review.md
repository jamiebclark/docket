# Review: Retry a failed target now, into the next free slot, or at a picked time (012-retry-modes)

**Round 3: re-review after the Phase 9 remediation (T045).**

Reviewed 42 files changed across 10 commits, against `2c9a1d0...HEAD`. `2c9a1d0` is the merge-base with `origin/main`, and `HEAD` is `9ba0054`.

This round follows the constitution's re-review rule (`.specify/memory/constitution.md:125-128`). It checks two things: whether F14, the only blocking finding from round 2, is fixed, and whether the files the remediation changed introduced a regression. Anything else I noticed is recorded as MINOR, not as a blocker.

The remediation is one commit, `9ba0054`. It changes 4 files: `src/components/targets/RetryDialog.tsx`, `src/components/ui/Dialog.tsx`, `src/components/ui/Announce.tsx` and `specs/012-retry-modes/tasks.md` (`git diff 81aa6a6 HEAD --stat`).

**Read in full:**

- The `9ba0054` diff and the current state of all three changed source files.
- `src/components/targets/TargetResolution.tsx`. It is unchanged, but it is the parent whose `close`, `retryKey` and `open` drive the new code.
- The two fallback targets: `src/app/p/[projectSlug]/failures/page.tsx:172-176` and `src/app/p/[projectSlug]/posts/[postId]/page.tsx:53-64`.
- `src/app/p/[projectSlug]/posts/actions.ts:15-25`, to see how `refresh()` reaches the client.
- To check that the fix does not depend on timing, the framework source that orders the commits:
  - Next 16.3.8: `node_modules/next/dist/client/components/app-router-instance.js:75-128` and `node_modules/next/dist/client/components/router-reducer/reducers/server-action-reducer.js:255-333`.
  - React 19.2.8: `node_modules/react-dom/cjs/react-dom-client.development.js:1305-1312`, `:16334-16346` and `:18994-19005`.

**Searched for regressions in the changed APIs:**

- Every remaining reference to `restoreFocus`, `focusFallback` and `returnFocus` in `src`, `tests`, `docs` and the spec artifacts.
- All 21 files under `src` that render `<Dialog`. Apart from `RetryDialog`, none passes `returnFocus`, so the other 20 keep the default `true`.

**Run as targeted probes (allowed by `constitution.md:111-114`):**

- `pnpm vitest run tests/integration/failures/ui.test.tsx src/components/targets/` passed: 2 files, 15 tests.
- `pnpm exec eslint` on the three changed source files was clean.
- `pnpm exec commitlint --from 81aa6a6 --to HEAD` reported no problems.

**Not re-reviewed this round:** everything outside `9ba0054`. It has not changed since round 2, so the re-review rule leaves it out. That covers the service layer, the queue, the tests, the docs and the spec artifacts (I grepped them only for the renamed API). It also covers `.specify/roadmaps/failure-recovery-completeness-roadmap-th.json`, which is the runner's untracked state.

**Not run:** the full suite, typecheck and build. The constitution says review does not re-run them. The implement pass for T045 reports a clean typecheck, a clean eslint and passing targeted tests, and says it did not run the full suite (`.pipeline/implement.result.json`). The last full pass was T038, before rounds 2 and 3. The branch has no upstream, so CI has not run.

## Verdict

**Ready for a human to merge once CI is green and T039's manual screen-reader check is done.** There are no blocking findings this round.

**F14 is fixed, and the fix no longer depends on refresh timing.** On success, `RetryDialog` now does three things:

1. It sets `done` (`RetryDialog.tsx:105`). That passes `returnFocus={false}` to `Dialog` (`:129`).
2. `Dialog` copies that into a ref (`Dialog.tsx:30-32`) before its open effect calls `el.close()` (`:40-41`), so the `close` event handler skips the return-to-opener (`:50`).
3. `RetryDialog`'s own effect runs after `Dialog`'s effects in the same commit, because React runs child effects first. It moves focus straight to the page heading (`RetryDialog.tsx:64-67` → `Announce.tsx:24`).

All of this happens in the commit that closes the dialog. That commit always lands before the refreshed page, which is what removes "Retry…":

- `setDone` and `onClose` run after an `await`, so they get the default lane (`react-dom-client.development.js:16340-16345`, `:1305-1311`).
- The router's refresh update was queued inside the confirm's async transition (`app-router-instance.js:125-128`). It therefore shares the confirm action's entangled transition lane (`react-dom-client.development.js:18994-19004`), and it cannot commit until the confirm callback has returned.

The frame-callback race from round 2 is gone. So is the late `close` event that could pull focus back.

"Back" and Escape still return focus to "Retry…" (F4): `done` is false on those paths, so `returnFocusRef` stays true. The heading exists on both pages (`failures/page.tsx:174`, `posts/[postId]/page.tsx:62`). It sits outside the region the refresh changes, so it keeps focus when the row disappears.

**No regression.** The `Dialog` change is opt-in with a default of `true`, so the other 20 dialogs behave as before. `restoreFocus` had exactly one caller, which this commit replaced. Lint, commitlint and the targeted tests are clean.

**What is left is MINOR and safe to ship:**

- The two new findings: F18 (the UI contract still documents the removed `restoreFocus`) and F19 (pre-existing: the ambiguous-resolution dialogs on the Failures page still drop focus when their row leaves).
- The carried MINORs: F6–F9, F15 and F16.

The fix itself is still unobserved in a browser. The success cases are in T039's manual check, which stays `🛑 BLOCKED` on a human with a screen reader.

## Findings

- [ ] MINOR F18 — The UI contract still documents the removed `restoreFocus()`, with its "after the next paint" semantics
      where:  specs/012-retry-modes/contracts/ui.md:118-120, specs/012-retry-modes/contracts/ui.md:126, src/components/ui/Announce.tsx:8-9, src/components/ui/Announce.tsx:24
      why:    `9ba0054` replaced `restoreFocus()` (a one-frame check for `<body>` or a detached node) with `focusFallback()`. The new function focuses the heading immediately, and `RetryDialog` calls it from an effect once the dialog has closed. The contract still gives `useAnnounce()`'s return type as `{ announce; restoreFocus }` and says `TargetResolution` calls `ctx.restoreFocus()` after a successful retry. In fact `RetryDialog` calls `ctx.focusFallback()` (`RetryDialog.tsx:66`). The new `returnFocus` prop on `Dialog` (`Dialog.tsx:14`, `:20-21`) is not in the contract either. `research.md` P11 already says `focusFallback()`, so the two artifacts now disagree. The code is correct; only the document is stale. A later entry that reads the contract would look for an API that no longer exists.
      owed:   Update `contracts/ui.md` "Announcements and focus": give `focusFallback()` its actual semantics (focus `#focusFallbackId` now), note `Dialog`'s `returnFocus` option, and say the success path skips the return-to-opener and focuses the heading after the dialog closes.
      traces: plan P11, contracts/ui.md "Announcements and focus"

- [ ] MINOR F19 — (pre-existing, outside 012's requirements) On the Failures page, a successful "Mark published" or "Mark not published…" returns focus to its opener, and the refresh then removes the row, so focus falls to `<body>`
      where:  src/components/targets/TargetResolution.tsx:65-72, src/components/targets/TargetResolution.tsx:136-140, src/components/ui/Dialog.tsx:49-51
      why:    The ambiguous dialogs close through `run` → `setOpen(null)` (`TargetResolution.tsx:71`). That uses `Dialog`'s default return-to-opener (`Dialog.tsx:50`), so focus goes back to "Mark published" or "Mark not published…". When the action's `refresh()` commits, the resolved row leaves the list and focus goes to `<body>`. This was never wired to the fallback: no commit on this branch ever called `restoreFocus` from these dialogs. `docs/decisions.md:543` records that the row-removal problem predates 012. It is not a regression from this remediation. I noted it because the new `returnFocus` option and `focusFallback()` make the fix a few lines.
      owed:   For the hardening entry: on success in the ambiguous dialogs, pass `returnFocus={false}` and call `ctx?.focusFallback()` once the dialog has closed, as `RetryDialog` now does.
      traces: FR-018 (by analogy; FR-018 is about retry outcomes), Constitution — Engineering Constraints (Accessibility)

- [ ] MINOR F15 — (open from round 2) F2's residual: after a confirm fails while a preview load is in flight, the confirm button stays disabled and reads "Retrying…" until the preview arrives; and the F2 test cannot fail
      where:  src/components/targets/RetryDialog.tsx:50-55, src/components/targets/RetryDialog.tsx:114-117, src/components/targets/RetryDialog.tsx:170, tests/integration/failures/ui.test.tsx:129-144
      why:    Unchanged in substance. Only the line numbers moved. The requeue-refusal path still calls `loadPreview()` from inside the confirm transition (`:114-117`), so the confirm's `pending` waits on the preview. The static-markup test never runs effects, so it passes against the pre-fix code too.
      owed:   As in round 2: load the preview as a plain `async` call with `live`-flag cancellation, and replace the static-markup assertion with one that can fail, or name the check in T039.
      traces: FR-016, Edge case "preview cannot be loaded"

- [ ] MINOR F16 — (open from round 2) F5's residual: the retry-vs-scheduler race test fails only if the retry is rejected; its "publishes at most once" and "consistent state" checks, and the mixed-mode hold check, cannot fail
      where:  tests/integration/failures/retry-concurrency.test.ts:38-39, tests/integration/failures/retry-concurrency.test.ts:42, tests/integration/failures/retry-concurrency.test.ts:65-66, tests/helpers/failures.ts:16-17
      why:    Unchanged; this round did not touch these files. Round 2 has the full reasoning.
      owed:   As in round 2: count the `publish`-step attempts made after the retry, assert the exact post-race state, and assert the winner's `slotOccurrenceAt` against its mode.
      traces: FR-024, SC-002

- [ ] MINOR F6 — (open from round 1) Without an `AnnounceProvider`, retry outcomes are never announced and focus is never restored
      where:  src/components/targets/RetryDialog.tsx:66, src/components/targets/RetryDialog.tsx:107, src/components/targets/TargetResolution.tsx:116, src/components/targets/TargetResolution.tsx:148
      why:    Unchanged. `RetryDialog` announces and places focus only through `ctx?.`, while `TargetResolution` passes `onDone={() => undefined}` and its fallback `LiveRegion` never receives a retry message. Both render sites have a provider today.
      owed:   As in round 1: route retry outcomes into the fallback region through `onDone`, or require the provider.
      traces: contracts/ui.md "No provider", FR-018

- [ ] MINOR F7 — (open from round 1) A transport failure of the requeue preview rejects into the error boundary instead of showing "unavailable"
      where:  src/components/targets/RetryDialog.tsx:50-55, src/components/targets/RetryDialog.tsx:72
      why:    Unchanged. There is no `try/catch` around `previewRequeueAction` and no `.catch` on `previewExplicitTimeAction`.
      owed:   As in round 1: map a rejection to the "Couldn't load the next free slot." unavailable state.
      traces: Edge case "preview cannot be loaded"

- [ ] MINOR F8 — (open from round 1) After the time field is edited, the previous time preview stays confirmable until the new one arrives
      where:  src/components/targets/RetryDialog.tsx:41-42, src/components/targets/RetryDialog.tsx:102
      why:    Unchanged. `timePreview` is not tied to the `local` value it was fetched for.
      owed:   As in round 1: treat `timePreview` as null when its `local` differs from `${date}T${time}`.
      traces: FR-017, SC-004

- [ ] MINOR F9 — (open from round 1) `docs/failures.md` misstates the time zone and the no-permission case
      where:  docs/failures.md:13, docs/failures.md:31-36
      why:    Unchanged. The doc says "shown in your time zone", but the fields use the project's zone. It also lists "no permission" as a case where Retry is disabled with a reason, but the UI shows "View only" in a row and nothing at all on the post page.
      owed:   As in round 1.
      traces: FR-023

- NOTE F20 — `done` is cleared only by the dialog's `close` event (`RetryDialog.tsx:124-127`). If someone presses Escape while a confirm is still in flight and the retry then succeeds, the `close` event has already fired, so `done` stays `true` on that closed instance. I checked whether this matters. The effect sends focus to the heading once (`:64-67`), which is the right place, because the opener is about to leave. The next "Retry…" click remounts the dialog with fresh state (`TargetResolution.tsx:118-121`, `:145`). It has no visible effect.
- NOTE — Round-2 note F17 and round-1 notes F10–F13 still stand unchanged.

## Earlier findings: status

| Finding | Severity | Status | Evidence |
|---|---|---|---|
| F14 focus lost to `<body>` after a successful retry | MAJOR | **Fixed** | `RetryDialog.tsx:105`, `:129`, `:64-67`; `Dialog.tsx:30-32`, `:50`; `Announce.tsx:24`. The order is set by the commit lanes (`react-dom-client.development.js:16340-16345`, `:18994-19004`; `app-router-instance.js:125-128`), not by frame timing. T039 now lists both success cases. |
| F1–F4 | MAJOR | Fixed (round 2) | No regression: `Dialog`'s default `returnFocus=true` keeps F4's Back/Escape path. Announce's F3 counter (`Announce.tsx:12-15`, `:23`) is untouched. |
| F5 | MAJOR | Fixed in core (round 2); residual F16 | Unchanged this round. |
| F6–F9, F15, F16 | MINOR | Open | Carried above with updated line numbers. |
| F10–F13, F17 | NOTE | Unchanged | — |

## Coverage

Rows the remediation did not touch are carried from the round-1 sweep, which covered every category the constitution lists, as amended in round 2. This round re-checked the rows the remediation touched: FR-018, SC-006, P11, the accessibility constraint and the commits workflow item.

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-024) | 24 | 22 | 2 (FR-016 F15; FR-018 F6, no-provider path only) | 0 | 0 |
| Success criteria (SC-001–SC-006) | 6 | 5 | 1 (SC-002 F16) | 0 | 0 |
| User stories (US1–US4) | 4 | 4 | 0 | 0 | 0 |
| Edge cases | 10 | 9 | 1 (preview unavailable F7/F15) | 0 | 0 |
| Plan decisions (P1–P12) | 12 | 12 | 0 (P11 honoured; its contract text is stale, F18) | 0 | 0 |
| Constitution core principles (I–VII) | 7 | 7 | 0 | 0 | 0 |
| Constitution engineering constraints (Neon, scheduler, UTC/Temporal, accessibility) | 4 | 4 | 0 (accessibility subject to T039) | 0 | 0 |
| Constitution development workflow (commits, gates, tests, docs) | 4 | 4 | 0 | 0 | 0 |

## What I could not check

- **The F14 fix in a real browser.** The project's Vitest runs in `environment: "node"` (`vitest.config.ts:10`), and there is no jsdom or happy-dom, so nothing automated exercises the focus move. My conclusion comes from the code, from React 19.2.8's lane assignment and from Next 16.3.8's action queue. A human must still run T039: retry successfully on the Failures page (with several rows) and on the post page, and confirm focus lands on the heading. Then press Back and Escape and confirm focus returns to "Retry…".
- **Native `<dialog>` focus behaviour.** The fix assumes `close()` on a modal dialog moves focus to the previously focused element synchronously, with the `close` event fired later as a task, per the HTML spec. I did not observe this in Chrome, Firefox or Safari.
- **Screen-reader behaviour (T039, still owed).** I could not check how VoiceOver or NVDA order the heading focus and the polite announcement on success. I also could not hear whether they re-read a live-region change that differs only by a trailing no-break space (F3).
- **The full suite, typecheck and build after T045.** I did not run them, per the constitution, and neither did the T045 implement pass. CI has not run, because the branch has no upstream. My evidence is the targeted tests (15 passed), eslint on the changed files, and commitlint.
- **Load behaviour.** I did not measure the preview or requeue occurrence walk with a full 366-day horizon on a busy account (carried from round 2).
