# Review: Reusable week grid for posting slots (round 4 — re-review after the round-3 remediation)

**This is a re-review, the third one**, so the constitution's scoping rule applies: it checks only that each
of round 3's findings is fixed and that the files the remediation changed introduced no regression. It opens
no new line of inquiry at blocking severity; anything else it notices is recorded as MINOR for a hardening
entry. Round 3's nine MINOR findings are carried forward below unchanged in substance, with citations
re-anchored to the current line numbers, so nothing is lost by replacing that file.

Reviewed the present working tree (`git diff HEAD` plus the five untracked source files) — the implementation
is **still entirely uncommitted** (21 modified, 5 new), so CI has never seen it; the only committed work on
this branch is the 8 spec artefacts in `0c1798f..0b7e2db`.

**The round-3 remediation (T064) touched exactly four files** (mtimes 04:59:00–05:00:17, all after round 3's
`review.md` body; every other file in the feature predates it and is therefore still as round 3 verified it):

| File | Changed by | Read this round |
|---|---|---|
| `src/components/schedule/week-slot-grid-logic.ts` | T064 | in full |
| `src/components/schedule/WeekSlotGrid.tsx` | T064 | in full |
| `src/app/p/[projectSlug]/accounts/AccountSlotGrid.tsx` | T064 | in full |
| `src/components/schedule/week-slot-grid-logic.test.ts` | T064 | in full |

Also read in full to settle F1: `src/components/schedule/WeekSlotGrid.test.tsx`, `src/lib/action-result.ts`,
`src/server/services/slots.ts`, `src/app/p/[projectSlug]/accounts/actions.ts`, `src/components/ui/Dialog.tsx`,
`specs/035-week-slot-grid/{spec.md,plan.md,tasks.md,data-model.md}`, `contracts/week-slot-grid.md` §Props +
guarantees, `quickstart.md` §7, `docs/design-system.md:272`, `docs/accounts.md:64-78` and
`.specify/memory/constitution.md`.

Not reviewed: anything outside the feature's diff. The server half (`dal/slots.ts`, `services/slots.ts`,
`validation/scheduling.ts`), the accounts page, `loading.tsx`, `SlotEditor.tsx` and the four integration test
files were not re-read beyond the two files F1's chain runs through, because none has changed since round 2
proved them (100 integration assertions against real Postgres there).

**Probes run this round**, because the code changed after round 3's probes and the implement pass's own
evidence is a note appended to the *previous* `review.md` rather than a readable run log:

- `npx tsc --noEmit` — **clean** (exit 0).
- `npx eslint src/components/schedule "src/app/.../AccountSlotGrid.tsx"` — **clean**, 0 errors, 0 warnings.
- `DOCKET_SKIP_DB_SETUP=1 npx vitest run src/components/schedule src/lib/validation/scheduling.test.ts` —
  **82 passed across 3 files**, including the two new `additionFocusId` cases.

Not re-run, per the constitution: the full 535-file suite, `pnpm build` and the DB-backed integration files.
The last is not a choice — `.env` is absent and `DATABASE_URL` is unset, and `tests/setup/global-setup.ts:36-42`
requires a `*_test` database, so the integration suite cannot run in this phase at all.

## Verdict

**Round 3's one blocking finding is fixed, and this time the fix is structurally immune to the timing that
broke the last two attempts — so there are no blocking findings and the feature is ready for a human to
merge once the browser walk-through is done.** T064 took option (a): `SlotActionOutcome`'s success variant now
carries an optional `id` (`WeekSlotGrid.tsx:41`), `AccountSlotGrid.addOutcome` passes through the id
`addSlotAction` already returns in its `SlotView` (`AccountSlotGrid.tsx:14-17`, `services/slots.ts:19-27`), and
`handleAdd` computes the focus target from the returned value rather than from a render-time lookup
(`WeekSlotGrid.tsx:181`, `week-slot-grid-logic.ts:167-169`). The reason this holds where round 3's did not is
that nothing now depends on *when* the refreshed `slots` prop arrives: the id comes from the resolved promise,
and the focus effect keeps an unfound target instead of draining it and lists `slots` among its dependencies
(`WeekSlotGrid.tsx:130-140`), so whichever render brings the real chip in is the render that lands focus on it.
I traced all three commits — the `resolveTick` one, the `setAdditions` one and the refreshed-`slots` one — and
in each the effect either finds `slot-<realId>` or preserves the target. `resolvedAdditionFocusId`, whose null
branch was the production path, is deleted along with its two tests, and a grep for it and for `hourTicks`
across `src/`, `docs/`, `.claude/` and the design artefacts now returns nothing.

No regression reached the four changed files: typecheck, lint and 82 unit tests are clean, the markup test
still asserts the read-only grid, the manager controls, the pending-chip suppression and the focusable chip id,
and the feature's five touched test files still contain zero deletions against HEAD — the two tests T064
removed were tests of the function it deleted, replaced one-for-one by tests of the function that supersedes it
(SC-013 holds).

What I would do: run `quickstart.md` §7 (T054) and merge. Nine MINOR findings carry forward for a hardening
entry; the two worth a human's attention first are F2 (the move dialog still loses focus on commit and on
Cancel, which is the other half of the keyboard story and a MUST in FR-015 that only the re-review scoping rule
keeps out of the blocking set — a human may escalate it) and F1 (the design artefacts now describe an `onAdd`
contract one field narrower than the one the component relies on).

## Findings

- [ ] MINOR F1 — T064 widened `SlotActionOutcome` in code but not in the contract, so the artefact a second caller codes against omits the field G8's focus guarantee now depends on
      where:  specs/035-week-slot-grid/contracts/week-slot-grid.md:32-33, src/components/schedule/WeekSlotGrid.tsx:41, src/components/schedule/WeekSlotGrid.tsx:57, specs/035-week-slot-grid/data-model.md:97, specs/035-week-slot-grid/data-model.md:67, src/components/schedule/week-slot-grid-logic.ts:23-25
      why:    The contract still declares `SlotActionOutcome = { ok: true } | { ok: false; message: string }`
              and comments that "the grid needs the outcome and the words, nothing more", while the shipped
              type is `{ ok: true; id?: string } | …` and G8 ("moves focus to the new chip",
              `contracts/week-slot-grid.md:53`) is now satisfied only when the caller supplies that id. Because
              the field is optional, a second caller that follows the contract literally compiles, runs, and
              silently gets the add-button fallback instead of chip focus — the failure is invisible until
              somebody tests with a keyboard. `data-model.md` §4 has the matching drift T063 was meant to end:
              `additionFocusId` has no row at all, and `isNoOpMove:97` still shows the two-argument signature
              and the single rounded rule although round 1's T055 gave it `exact` and a second rule
              (`week-slot-grid-logic.ts:111-115`) — so the table hides that fix. `GridPermissions`
              (`data-model.md:67`, `week-slot-grid-logic.ts:23-25`) is still listed, still exported and still
              used by nothing. Harm is bounded to a wrong first guess by the next caller, which is why this is
              MINOR, but it is drift this remediation introduced in the one artefact whose job is to be coded
              against.
      owed:   Update `contracts/week-slot-grid.md:32-33` to the shipped `SlotActionOutcome`, say in `onAdd`'s
              doc line that the id is what makes G8's chip focus possible and that omitting it falls back to the
              column's add button, add an `additionFocusId` row to `data-model.md` §4, extend `isNoOpMove`'s row
              to `(slot, intent, exact?) => boolean` with both rules, and drop `GridPermissions` from §3 and
              from the module's exports.
      traces: FR-003, FR-011, constitution Workflow/docs, round-3 F2, round-2 F2

- [ ] MINOR F2 — The move dialog's Move and Cancel buttons unmount the open `<dialog>` without closing it, so `Dialog`'s focus restore never fires and focus is lost; only `Escape` returns focus to the chip
      where:  src/components/schedule/WeekSlotGrid.tsx:407-419, src/components/schedule/WeekSlotGrid.tsx:411, src/components/schedule/WeekSlotGrid.tsx:415, src/components/ui/Dialog.tsx:34-52, docs/design-system.md:272
      why:    Unchanged from round 3 (F3) and round 2 (F3), re-verified line by line against the current file.
              `Dialog` restores focus in its `<dialog>` `onClose` handler (`Dialog.tsx:49-52`), which runs only
              when the element's close algorithm runs. `Escape` on a native modal runs it. Cancel calls
              `onCancel` → `setMoveDialog(null)` (line 411); Move calls `setMoveDialog(null)` then `handleMove`
              (line 415). Either way the whole `MoveSlotDialog` is conditionally unmounted (line 407), React
              detaches the still-open `<dialog>`, no `close` event fires, the `[open]` effect's `el.close()`
              branch (`Dialog.tsx:40-42`) is never reached because the effect is gone with the component, and
              the focused button inside the dialog is removed — leaving `document.activeElement` as `<body>`.
              The grid also never sets `focusTarget` on the move path, so neither half of `Dialog`'s documented
              bargain ("Set false when the opener is going away; the caller then places focus itself",
              `Dialog.tsx:20`) is taken up. FR-015 requires cancelling to "keep focus on the chip"; the keyboard
              contract requires it on commit too, and `docs/design-system.md:272` states both in the present
              tense. `quickstart.md` §7 row 14 is the row that fails. The calendar's `MoveDialogs` mount the
              same way and have the same latent gap.
              **Severity note:** this is a MUST in FR-015 and would be MAJOR on a first review; it stays MINOR
              only because the constitution's re-review rule forbids opening a new line of inquiry at blocking
              severity, and it has been MINOR for two rounds. A human may escalate it.
      owed:   Set `focusTarget.current = "slot-<id>"` before `setMoveDialog(null)` on both the Move and the
              Cancel path (the chip's body button keeps its real id across the move), or keep the `Dialog`
              mounted with `open={moveDialog !== null}` so `el.close()` runs and `returnTo` fires. Fixing it
              inside `Dialog` with an unmount cleanup would fix the calendar too.
      traces: FR-015, FR-042, FR-043, FR-052, contract G11 + keyboard contract rows 6-7, round-3 F3, round-2 F3

- [ ] MINOR F3 — The empty message is keyed on the `slots` prop rather than the rendered view, so it sits beside the first optimistically placed chip and vanishes early when the last slot is deleted
      where:  src/components/schedule/WeekSlotGrid.tsx:372, src/components/schedule/WeekSlotGrid.tsx:150, specs/035-week-slot-grid/contracts/week-slot-grid.md:50
      why:    Unchanged from round 3 (F4) and round 2 (F4). T056 correctly moved `emptyMessage` out of the
              seven-column loop but keyed it on `slots.length === 0` — the server prop — while the columns
              render `view`, the prop with optimistic overrides and additions applied (line 150). So on a fresh
              account the first click shows "No posting slots yet…" *and* the new chip together until the
              refreshed tree lands, and deleting the only slot leaves the grid blank with no empty line for the
              same window. Contract G5 is worded against `slots`, so the component follows its contract and the
              drift is small and transient — but the branch it replaced read the view, and the markup test
              (`WeekSlotGrid.test.tsx:66-75`) only exercises the static cases where the two agree.
      owed:   Key it on `view.length === 0`, and reword G5 in `contracts/week-slot-grid.md:50` to say the
              rendered grid rather than the `slots` prop.
      traces: FR-007, contract G5, round-3 F4, round-2 F4, round-1 F2

- [ ] MINOR F4 — `docs/accounts.md` tells a user to use a button labelled "Add a slot on &lt;Day&gt;", which T061 renamed to "Add slot"
      where:  docs/accounts.md:69, src/components/schedule/WeekSlotGrid.tsx:392, src/components/schedule/WeekSlotGrid.tsx:399
      why:    Unchanged from round 3 (F5) and round 2 (F5); `docs/accounts.md` has not been touched since
              03:24. T061 shortened the visible label to "Add slot" and kept `Add a slot on <Day>` as the
              `aria-label`, which is the right fix for round-1 F7 and keeps contract G8's accessible name.
              `docs/accounts.md:69` still reads "use that column's **Add a slot on \<Day\>** button" — a sighted
              reader following the user docs is looking for text that now exists only in the accessibility tree.
      owed:   Change it to "that column's **Add slot** button" (the accessible name can go unmentioned, or be
              named as what a screen reader says).
      traces: FR-054, round-3 F5, round-2 F5, round-1 F7

- [ ] MINOR F5 — T058 is ticked but its promised tests were never written; the override-clearing effect — the mechanism round-1 F4 and rounds 2–3's F1 all turned on — still has no test
      where:  specs/035-week-slot-grid/tasks.md:179, src/components/schedule/WeekSlotGrid.tsx:116-128, src/components/schedule/week-slot-grid-logic.test.ts:149-178
      why:    Unchanged from round 3 (F6), and the three rounds spent on the post-add focus are the cost of it.
              T058 asks for "a test that covers a resolution arriving after the `slots` prop and one arriving
              while another mutation is pending". Neither exists: `week-slot-grid-logic.test.ts:149-178` tests
              `applyOverrides` as a pure function only, and `WeekSlotGrid.test.tsx` is `renderToStaticMarkup`,
              so it cannot drive an effect. T064's fix is the right shape — it moved the decision into a pure
              `additionFocusId` that *is* tested (`week-slot-grid-logic.test.ts:180-188`) — but the clearing
              rule itself (which seqs to drop, which additions to filter, in what order) is still inline in the
              effect and asserted nowhere. The repo has no DOM harness (`vitest.config.ts:14` sets
              `environment: "node"`; neither `jsdom` nor `happy-dom` is installed), so the honest fix is
              extraction, not a new dependency.
      owed:   Extract the clearing rule into a pure function in `week-slot-grid-logic.ts` —
              `clearResolved(overrides, additions, doneSeqs)` returning the next pair — and unit-test it for
              both arrival orders, or amend T058 to record that the behaviour is verified only by
              `quickstart.md` §7 rows 20-21 and by code reading.
      traces: constitution Workflow/tests required, FR-036, contract G18, round-3 F6, round-2 F6, round-1 F4

- [ ] MINOR F6 — Click-to-place still bails on any click that is not exactly on the column body, while a drop at the same position is honoured anywhere in the column
      where:  src/components/schedule/WeekSlotGrid.tsx:250, src/components/schedule/WeekSlotGrid.tsx:265-278, src/components/schedule/WeekSlotGrid.tsx:387
      why:    Unchanged from round 3 (F7), round 2 (F7) and round 1 (F8). `columnClickHandler` returns early
              unless `e.target === e.currentTarget`, so a click landing on the chips `<ul>` (line 387) adds
              nothing, while `columnDropHandler` has no such guard and honours a drop at any y, including over
              a chip. Contract G7/G9 route both through one `timeAtPosition` so that placing and dropping
              cannot diverge; their hit areas still do, which on a column that already holds chips means the
              user's click does nothing and says nothing.
      owed:   Let the click through when the target is a non-interactive descendant of the column body, or put
              `pointer-events-none` on the chips list for the click path.
      traces: FR-008, contract G7/G9, round-3 F7, round-2 F7, round-1 F8

- [ ] MINOR F7 — `handleAdd` still skips the local duplicate pre-check `handleMove` performs, so a click onto an occupied time always costs a round trip and a chip flash
      where:  src/components/schedule/WeekSlotGrid.tsx:173-189, src/components/schedule/WeekSlotGrid.tsx:227-232
      why:    Unchanged from round 3 (F8), round 2 (F8) and round 1 (F9). `handleMove` calls
              `conflictAt(view, intent, intent.id)` and refuses locally with `DUPLICATE_REFUSAL`; `handleAdd`
              sends unconditionally and waits for the server's `ConflictError`. The outcome is correct either
              way — US1 AS4 passes — but the same information was available locally, `conflictAt` exists for
              exactly this, and two paths in one component answer the same rule differently.
      owed:   Call `conflictAt` at the top of `handleAdd` and refuse the same way `handleMove` does.
      traces: FR-016, FR-019, data-model.md §4, round-3 F8, round-2 F8, round-1 F9

- [ ] MINOR F8 — Every refusal still produces two announcements, one of them assertive, where SC-006 asks for exactly one polite one
      where:  src/components/schedule/WeekSlotGrid.tsx:366-370, src/components/schedule/WeekSlotGrid.tsx:142-148, specs/035-week-slot-grid/contracts/week-slot-grid.md:62
      why:    Unchanged from round 3 (F9), round 2 (F9) and round 1 (F10). A failure writes the message into a
              `role="alert"` paragraph (implicit `aria-live="assertive"`) and also calls
              `say(announceRefused(...))` into the polite region, so a screen-reader user hears it interrupt
              and then hears it again with the day and time appended. Contract G17 mandates both, so the
              contract is where the conflict starts, but the shipped behaviour is the double announcement.
      owed:   Keep the visible failure text but take it out of the live-region path (plain styled text, or
              `role="status"` with `aria-live="off"`), leaving the single polite announcement to carry it, and
              reword G17.
      traces: FR-044, SC-006, contract G17, round-3 F9, round-2 F9, round-1 F10

- [ ] MINOR F9 — The chip body button's accessible name names the slot but not what activating it does
      where:  src/components/schedule/WeekSlotGrid.tsx:314, src/components/schedule/WeekSlotGrid.tsx:75-77, specs/035-week-slot-grid/contracts/week-slot-grid.md:48
      why:    Unchanged from round 3 (F10), round 2 (F10) and round 1 (F11). The body button is
              "Monday 10:00, active" beside siblings "Move Monday 10:00, active" and
              "Delete Monday 10:00, active", so the one control whose action a screen-reader user cannot infer
              is the one that mutates state on a bare Enter. FR-043 requires the name to identify "both the
              action and the slot it acts on"; contract G3 specifies the bare form, so the contract is what
              misses the requirement.
      owed:   Name it for its action — "Pause Monday 10:00" / "Resume Monday 10:00, paused" — keeping the
              day/time/state string as the chip's own text so G3 and SC-005 still hold.
      traces: FR-043, contract G3, round-3 F10, round-2 F10, round-1 F11

- NOTE F10 — Two consequences of T064's focus-effect shape, neither a defect worth a task, both narrow enough
  that I could not construct a realistic failing input. (a) `focusTarget` is now retained when its element is
  absent (`WeekSlotGrid.tsx:137`), which is exactly what makes F1's fix work, but it also means a target that
  never materialises lingers until some later `slots`/`overrides`/`additions` change — so if a user presses
  Enter on "Add slot" and immediately tabs elsewhere, the refreshed tree can pull focus onto the new chip under
  them. The window is one round trip, and post-action focus moves in this repo behave the same way. (b) Both
  effects share one `focusTarget` ref, so an add whose target is still unfound is silently overwritten by a
  subsequent delete's target (or vice versa). Both are the deliberate shape T064 chose; recording them so the
  next reader does not mistake them for oversights.

- NOTE F11 — Carried from round 3, still true, still not defects. (a) A `pending-N` chip carries `aria-busy`
  and `aria-disabled` (`WeekSlotGrid.tsx:299,316`) but no visual change, so a sighted manager who clicks a chip
  they have just placed sees nothing happen and gets no reason; the window is one round trip and no requirement
  asks for a busy style. (b) `src/app/p/[projectSlug]/accounts/SlotEditor.tsx` still carries that name while
  exporting only the mock-provider controls — deliberate per the plan, but a reader looking for the slot editor
  will land there. (c) `tasks.md:238` correctly leaves T054 unchecked with a "not executed" note; the file is
  right, and anything downstream should trust it over an implement report that claimed completion.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Round-3 blocking findings re-checked | 1 | 1 | 0 | 0 | 0 |
| Round-3 MINOR findings re-checked | 9 | 0 | 9 | 0 | 0 |
| Files the remediation changed, swept for regression | 4 | 4 | 0 | 0 | 0 |
| Requirements round-3 F1 touched (FR-011, FR-042, FR-043, FR-052, SC-004, G8) | 6 | 4 | 2 | 0 | 0 |
| Functional requirements (FR-001…FR-054), carried forward and adjusted for F1's closure | 54 | 46 | 8 | 0 | 0 |
| Success criteria (SC-001…SC-013), carried forward | 13 | 12 | 1 | 0 | 0 |
| Constitution principles (plan's 13-row gate; V and VII are N/A), carried forward | 11 | 7 | 4 | 0 | 0 |

**Round-3 F1 is closed.** The chain is complete and every link was read: `slots.addSlot` returns a `SlotView`
carrying `id` (`services/slots.ts:10,19-27`); `addSlotAction` returns `ActionResult<SlotView>`
(`actions.ts:90-95`); `AccountSlotGrid.addOutcome` extracts `result.data.id`
(`AccountSlotGrid.tsx:14-17,32-34`); `handleAdd` turns it into a focus id through the pure `additionFocusId`
(`WeekSlotGrid.tsx:181`, `week-slot-grid-logic.ts:167-169`), unit-tested both ways
(`week-slot-grid-logic.test.ts:180-188`); the chip body button carries `id="slot-<id>"`
(`WeekSlotGrid.tsx:313`), pinned by a markup test that it is on the focusable `<button>` and not the `<li>`
(`WeekSlotGrid.test.tsx:116-120`); and the focus effect retries across renders rather than draining its target
(`WeekSlotGrid.tsx:130-140`). FR-011 therefore moves to satisfied, and `docs/design-system.md:272`'s claim that
the add button "adds at the next free boundary and focuses the new chip" and `quickstart.md` §7 row 12 are now
true as written. The fallback is honest too: when no id comes back, focus goes to the column's add button
rather than nowhere.

**The eight FRs still partial, by key:** FR-003 (F1), FR-007 (F3), FR-008 (F6), FR-015 (F2), FR-042 (F2),
FR-043 (F2, F9), FR-044 (F8), FR-052 (F2 — `docs/design-system.md:272` still asserts dialog focus restore on
commit and Cancel), FR-054 (F4). SC-006 (F8) is the one partial success criterion. The four partial
constitution rows: II "nothing is working unless it ran" (T054 still owed, and the integration suite cannot run
in this phase); Engineering/accessibility (F2, F8, F9); Workflow/tests required (F5); Workflow/docs (F1, F4).

**No regression from the remediation.** `tsc --noEmit` exits 0, `eslint` is clean on all five changed/new
client files, and 82 unit tests pass across the three files covering everything that changed. The feature's
five touched test files still contain zero deletions against HEAD; the only tests removed in this round were
the two for `resolvedAdditionFocusId`, deleted with the function they covered and replaced one-for-one by
`additionFocusId`'s, so SC-013's "no test deleted to make the suite green" holds. `resolvedAdditionFocusId`
and `hourTicks` appear nowhere in `src/`, `docs/`, `.claude/` or the design artefacts — only in this file's and
`tasks.md`'s historical records.

## What I could not check

- **Everything that needs a browser**, unchanged from rounds 2 and 3. Pointer drag and drop, the hover reveal,
  `prefers-reduced-motion`, the 390 px stacked layout, a ~15-slot column, the cross-tab duplicate race and the
  toggle-then-delete race are all unexecuted. This repo has no DOM test library (`vitest.config.ts:14` sets
  `environment: "node"`; neither `jsdom` nor `happy-dom` is installed), and this phase has no browser and no
  running `pnpm dev`. T054 / `quickstart.md` §7 is the only thing that will settle them, and it is the one
  thing still owed before merge.
- **F1's focus outcome, empirically.** I verified the fix by reading the full chain and by walking the three
  commits an add produces, not by watching focus move. The reasoning rests on one assumption worth naming: that
  `refresh()` delivers a `slots` array with a new identity, which re-runs the focus effect. A server re-render
  produces a fresh array, so this holds — but it is an inference. `quickstart.md` §7 row 12 settles it in
  seconds. Unlike round 3's fix, a miss here is self-correcting: the target is preserved, so any later render
  that brings the chip in lands focus on it.
- **F2's focus outcome, empirically.** Same character: a `<dialog>` detached without `close()` fires no
  `close` event, so `Dialog.tsx:49-52` never runs. Walk-through row 14 settles it.
- **The DB-backed integration suite, the full 535-file suite, `pnpm build` and `pnpm db:check` on the
  remediated code.** The integration tests *cannot* run in this phase: `.env` is absent, `DATABASE_URL` is
  unset, and `tests/setup/global-setup.ts:36-42` requires a connection string whose database name ends in
  `_test`, which needs a human-held password. The last complete suite run is T053's (535 files, 5055 tests);
  the last `pnpm build` and full lint/typecheck are the ones recorded in round 3's "partly closed" note. Since
  then the only code changes are the four files above, all client-side and all covered by the probes I did run
  — but that is an inference, not a run. CI on the PR is where it becomes a fact.
- **FR-051 / SC-012 end to end.** `mutate` calls `refresh()` on success (`actions.ts:13-18`) and the
  per-account counts come from `listSlotCounts` (`services/slots.ts:64-73`), so the wiring is right, but I did
  not watch a count change after a grid mutation in a live page. Walk-through row 26.
- **Whether this is what gets merged.** The implementation is still entirely uncommitted (21 modified, 5
  untracked), so CI has never seen any of it.
