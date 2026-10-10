# Feature Specification: Reusable week grid for posting slots

**Feature Branch**: `035-week-slot-grid`

**Created**: 2026-10-10

**Status**: Draft

**Input**: User description: "Entry 2 of 2 in the UI tweaks roadmap (`.specify/roadmaps/ui-tweaks.json`): a reusable weekly posting-slot grid, replacing the per-account day-and-time picker. Entry 1 (prompt-text-fields) has landed; inherit the type scale it settled and use its `TextareaField` if this entry needs a textarea at all. The reported problem, in the user's words: 'Date/time picker for each account feels clunky in its current state. Could we instead do a reusable component of a horizontal row of a week with the ability to place, drag, and edit timeslots in each column of the day? Hovering over each timeslot could reveal an X to delete it. Clicking the date would toggle it active/inactive.' Build a `WeekSlotGrid` in `src/components/schedule/` as a reusable, presentational client component: seven columns Mon–Sun across a horizontal row, each column holding that day's timeslot chips ordered by time. It takes slots plus callbacks and holds no knowledge of accounts or server actions. Place, drag, edit and delete must all work by keyboard and by pointer; clicking a chip body toggles paused. A server-side move does not exist yet — add `moveSlot` to `src/server/services/slots.ts` and a `moveSlotAction` to the accounts actions, taking `{ id, weekday, localTime }`, enforcing `slot: [\"manage\"]` inside a `scope.transaction`, with the same duplicate rejection `addSlot` gets. Optimistic updates with rollback on a rejected action. Read-only for anyone without `slot: [\"manage\"]`. Accessibility is the hard part: a keyboard path for drag, accessible names carrying day, time and state, `aria-live` announcements via the existing `Announce.tsx` / `LiveRegion.tsx`, and `prefers-reduced-motion` honoured. Replace the Day/Time/Status/Actions table and `SlotEditor` on the accounts page with the grid; delete `SlotEditor`'s add form and `SlotRowActions`; leave `ReconnectMockButton` and `MockBehaviourForm`. Keep the 'Posting slots' definition copy and the time-zone note. Document it in `docs/design-system.md` and the docket-ui skill, and check `docs/accounts.md`. Not included: a month or day calendar view or any change to `calendar/`; slots at any granularity other than weekly day-plus-time; copying a week of slots between accounts; bulk editing across accounts; time-zone-per-account; anything that reschedules already-queued posts when a slot moves."

## Context

A **posting slot** is a weekly recurring time for one social account — "Tuesdays at 09:00" — in the project's
time zone. Slots are what **Add to queue** fills: a post added to the queue lands in the account's next free
slot. Setting them up is therefore one of the first things anyone does in a project, and on a busy account it
is something they keep coming back to.

### What exists now, verified in the tree

- **The data.** A slot is `{ id, socialAccountId, weekday, localTime, paused }`
  (`src/server/services/slots.ts:10`). `weekday` is the ISO weekday, 1 = Monday … 7 = Sunday, range-checked in
  the database (`posting_slots_weekday_range`, `src/server/db/schema/accounts.ts:105`) and by `weekdaySchema`
  (`src/lib/validation/scheduling.ts:5-10`). `localTime` is a wall-clock time in the project's zone, validated as
  24-hour `HH:MM` by `localTimeSchema` but read back from Postgres as `HH:MM:SS` — every display site writes
  `slot.localTime.slice(0, 5)`.
- **Duplicates are rejected by the database, not by a schema rule.** `addSlotSchema`
  (`src/lib/validation/scheduling.ts:91`) validates shape only. The no-two-slots-at-the-same-day-and-time rule
  is the unique constraint `posting_slots_account_time_uq` on `(social_account_id, weekday, local_time)`
  (`src/server/db/schema/accounts.ts:106`), which `createSlotsRepo.insert` turns into
  `ConflictError("That account already has a slot at that time.", "localTime")`
  (`src/server/dal/slots.ts:46-60`). The roadmap entry describes this rejection as coming from `addSlotSchema`;
  it does not. It comes from the constraint plus that one translation site, and that is the rule a move must
  reuse.
- **The services.** `listSlots` needs `slot: ["view"]`; `addSlot`, `setSlotPaused` and `deleteSlot` each need
  `slot: ["manage"]`, re-check it inside `scope.transaction`, and check the row exists first. `deleteSlot`
  carries the comment "Targets keep their times: `slot_id` goes NULL by the foreign key." There is **no move**:
  changing a slot's day or time today means deleting it and adding another, which loses the slot's identity and
  nulls `slot_id` on every target that pointed at it.
- **The actions.** `addSlotAction`, `setSlotPausedAction` and `deleteSlotAction`
  (`src/app/p/[projectSlug]/accounts/actions.ts:90-107`) each wrap the service in `mutate`, which runs
  `runAction` and calls `refresh()` on success so the server-rendered account sections re-render. `runAction`
  turns a thrown `ConflictError` into `{ ok: false, error: "conflict", message, fieldErrors }` and a
  `ForbiddenError` into `error: "forbidden"`.
- **The UI being replaced.** `src/app/p/[projectSlug]/accounts/page.tsx:246-261` renders, per account, a
  `Table` with columns Day / Time / Status / Actions (Actions only for a manager), one row per slot, each row's
  Actions cell holding a `SlotRowActions` (Pause/Resume, plus Delete behind a two-step confirm —
  `SlotEditor.tsx:52-91`). Below the table, for a manager only, sits `SlotEditor` (`SlotEditor.tsx:15-47`): a
  `SegmentedControl` of Mon–Sun radios named `slot-day-${accountId}`, a `type="time"` `Field`, and an "Add
  slot" button. Adding a slot submits the form, the route refreshes, and the new row appears somewhere in a
  table sorted by day then time — which is the clunkiness the user reported: you add a slot at one end of the
  card and then hunt for it at the other.
- **An empty account** shows the line "No posting slots yet." (`page.tsx:244`) instead of the table.
- **Permission gating on the page is `account: ["manage"]`, not `slot: ["manage"]`.** `page.tsx:69` computes
  one `canManage` from `scope.can({ account: ["manage"] })` and uses it for every manager-only block including
  the slot controls, while the services enforce `slot: ["manage"]`. The two happen to coincide for all three
  roles today (`src/server/auth/access.ts`: owner and admin hold both, editor holds neither), so nothing is
  broken — but the slot UI is reading the wrong capability, and this entry is the right moment to fix it.
- **The connect landing focuses a control that is about to be deleted.** After a successful connect,
  `page.tsx:130` passes `focusSelector={`input[name="slot-day-${id}"]:checked`}` to `ConnectLanding`, which
  scrolls to `#account-${id}-slots` and focuses that selector (`ConnectLanding.tsx:13`). That selector matches
  `SlotEditor`'s checked weekday radio and nothing else. Deleting `SlotEditor` silently breaks the
  "you just connected an account, now add some slots" hand-off, and `tests/integration/accounts-landing.test.ts`
  covers that flow.
- **An established drag pattern already exists in the repo.** The calendar
  (`src/app/p/[projectSlug]/calendar/CalendarBoard.tsx`) makes post chips `draggable`, lets empty slots accept
  a drop, keeps all decision logic in a pure module (`calendar-logic.ts`: `canDrop`, `moveChipToSlot`,
  `announceMoved`, `REFUSED_OTHER_ACCOUNT`) tested in `CalendarBoard.test.ts`, announces through
  `<LiveRegion message={announcement} />`, and gives every drag a keyboard equivalent through a `Menu` plus a
  dialog (`MoveDialogs.tsx`). The docket-ui skill already records that rule: "every drag action has a keyboard
  equivalent". This entry follows that pattern rather than inventing a second one.
- **Announcements.** `src/components/ui/LiveRegion.tsx` is a mounted `role="status"` / `aria-live="polite"`
  region driven by a `message` prop. `src/components/ui/Announce.tsx` wraps one `LiveRegion` in a provider with
  `useAnnounce()` and de-duplicates identical consecutive messages by appending a no-break space. The accounts
  page does **not** mount `AnnounceProvider` today (only `failures` and `posts/[postId]` do), and the calendar
  uses a bare `LiveRegion`. A reusable component cannot assume a provider above it.
- **No drag-and-drop library and no DOM test harness.** `package.json` has no drag library (the calendar uses
  native HTML5 drag events) and no browser testing library: component tests in this repo are
  `renderToStaticMarkup` assertions on rendered markup (`src/components/ui/TextareaField.test.tsx`) plus pure
  unit tests on extracted logic modules (`textarea-sizing.test.ts`, `CalendarBoard.test.ts`). Per the
  constitution, pipeline phases cannot reach the npm registry.
- **Entry 1 has landed.** `TextareaField` exists in `src/components/ui/` with `mono`/`minRows`/`maxRows`, and
  `docs/design-system.md` §4 and §7 record the settled type scale: 14 px `text-sm` for body, labels and
  anything a person types; 12 px `text-xs text-muted-foreground` for hints and explanatory copy; never below
  12 px; never shrink text inside a control. This entry has no multi-line text, so it inherits the scale but
  does not need `TextareaField`.

### What this entry changes

It replaces the table-plus-form with one direct-manipulation surface: a week laid out as seven day columns,
each column holding that day's slots as chips in time order. You add a slot where you want it, you move it by
dragging it, you type an exact time on the chip itself, you delete it with an X on the chip, and you turn it
off by clicking it. Every one of those has a keyboard route that does the same thing.

The grid lives in `src/components/schedule/` and knows nothing about accounts or server actions — it takes
slots and callbacks — so the calendar or a future project-wide slot view can mount it. The accounts page is
its only caller in this entry.

Two pieces of server work are needed, because a move cannot be expressed today: a `moveSlot` service function
and a `moveSlotAction`, both enforcing `slot: ["manage"]` and reusing the existing duplicate rule. Moving
rather than delete-and-re-add preserves the slot's identity, which means targets already pointing at it keep
pointing at it.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Set up a week of posting times by pointing at them (Priority: P1)

An owner has just connected an Instagram account and wants it posting on weekday mornings. Instead of picking
a weekday from a row of buttons, typing a time, pressing "Add slot", then scanning a growing table to confirm
what happened, they see a week: seven columns, Monday to Sunday. They click in the Monday column at roughly
breakfast height and a chip appears there reading "08:00". They click the same height in Tuesday, Wednesday,
Thursday and Friday. Five clicks, five slots, and the whole week's shape is visible without reading a single
table row.

**Why this priority**: This is the reported problem. Adding slots is the one thing everybody does on this
screen, and the add-then-find-the-row-again loop is what the user called clunky. On its own — even with no
drag, no inline edit and the old delete behaviour — this is already a better screen than what exists.

**Independent Test**: With slot-manage permission, open Accounts for a project with one connected account and
no slots. Click in each weekday column. Each click adds a slot on that day at the time the click position
rounds to, the chip appears in that column immediately, and the slots survive a page reload.

**Acceptance Scenarios**:

1. **Given** an account with no slots and a viewer who can manage slots, **When** the grid renders, **Then**
   seven columns labelled Monday–Sunday are shown in that order, each column is identifiable by name, the
   project's time zone is named once for the grid, and an empty-state line says no slots exist yet.
2. **Given** that grid, **When** the viewer clicks an empty position in the Wednesday column, **Then** a new
   slot is created on Wednesday at the time that position rounds to on the grid's step, a chip for it appears
   in the Wednesday column in time order, and an announcement states the day and time added.
3. **Given** the same grid, **When** the viewer instead reaches the Wednesday column by keyboard and triggers
   its add affordance, **Then** a slot is added on Wednesday with no pointer involved, and the new chip
   receives focus.
4. **Given** a column that already holds a slot at 09:00, **When** the viewer clicks a position that rounds to
   09:00, **Then** no duplicate is created, the refusal is shown in text naming the reason, and the existing
   09:00 chip is still the only chip at that time.
5. **Given** a newly placed chip at a rounded time, **When** the viewer types an exact time into the chip's
   time input and commits it, **Then** the slot is saved at the typed time and the chip moves to its new
   position in the column's time order.

---

### User Story 2 - Move a slot to a different day or time (Priority: P1)

The Friday 17:00 slot is getting poor engagement, so it should move to Saturday morning. The owner drags the
Friday 17:00 chip across to the Saturday column and drops it near the top. The chip lands on Saturday at the
time it dropped to; Friday no longer has a 17:00 slot. A colleague using a keyboard does the same thing
without a mouse: they focus the chip, enter its move controls, step it to Saturday and to the morning, and
commit. If either of them drops it on a time Saturday already has a slot at, the move is refused in words and
the chip goes back exactly where it was.

**Why this priority**: Also P1, because without it the grid is a prettier version of the same problem —
changing a slot's time still means delete-and-re-add, which loses the slot's identity and nulls `slot_id` on
every target that pointed at it. This story is what the new `moveSlot` service exists for.

**Independent Test**: Create a slot on Friday at 17:00 and one on Saturday at 09:00. Drag the Friday chip to
Saturday 08:00: it lands and persists, and the slot keeps its id. Drag it onto Saturday 09:00: it is refused,
the chip returns to its pre-drag day and time, and nothing is overwritten. Repeat both by keyboard only.

**Acceptance Scenarios**:

1. **Given** a slot on Friday at 17:00 and a viewer who can manage slots, **When** the viewer drags its chip
   within the Friday column to a position that rounds to 08:00, **Then** the slot's time becomes 08:00, its
   day stays Friday, its identity is unchanged, and an announcement states the new day and time.
2. **Given** the same slot, **When** the viewer drags its chip into the Saturday column, **Then** the slot's
   day becomes Saturday at the time the drop position rounds to, and the Friday column no longer shows it.
3. **Given** a slot on Saturday at 09:00, **When** the viewer drags the Friday 17:00 chip onto a position that
   rounds to Saturday 09:00, **Then** the move is refused, a message in text says the account already has a
   slot at that time, the dragged chip is shown again on Friday at 17:00, and the Saturday 09:00 slot is
   untouched.
4. **Given** a focused chip and no pointer in use, **When** the viewer enters the chip's keyboard move mode,
   steps the day and the time, and commits, **Then** the slot moves exactly as the equivalent drag would, and
   each step and the outcome are announced.
5. **Given** a chip in keyboard move mode that has been stepped away from its original day and time,
   **When** the viewer cancels, **Then** the slot is unchanged, no action is sent to the server, and the chip
   keeps focus at its original position.
6. **Given** a move that the server rejects for any reason, **When** the rejection arrives, **Then** the chip
   is shown at its pre-move day and time, the failure message is visible in text and announced, and no later
   reload shows a different result.
7. **Given** a slot with queued posts already scheduled against it, **When** the slot moves, **Then** those
   posts keep the times they already have and the move affects future scheduling only.

---

### User Story 3 - Turn a slot off for a while, and delete one you do not want (Priority: P2)

The account is going quiet over the holidays, so the owner clicks each chip body to pause it. The paused
chips are plainly inactive — muted, visibly different in more than hue, and reading "paused" to a screen
reader. In January they click them again to bring them back. A slot added in the wrong column gets removed
with one click of the X that appears on the chip when the pointer is over it; on a phone, and for anyone on a
keyboard, that X is simply always there.

**Why this priority**: Pause, resume and delete all work today through `SlotRowActions`, so this is behaviour
being carried across rather than new capability. It is still mandatory — the grid replaces that control, so
the grid has to offer all of it — but it is the part a reviewer can verify last.

**Independent Test**: With two active slots, click one chip body: it becomes paused, the state is in its text,
and a reload shows it still paused. Click again: active. Click a chip's X: the slot disappears with no
confirmation step, and a reload confirms it is gone. Do all three by keyboard.

**Acceptance Scenarios**:

1. **Given** an active slot and a viewer who can manage slots, **When** the viewer activates the chip body,
   **Then** the slot becomes paused, the chip reads as inactive through at least a text change and a
   non-hue visual change, and the change is announced.
2. **Given** a paused slot, **When** the viewer activates the chip body, **Then** the slot becomes active
   again and the change is announced.
3. **Given** any chip, **When** a pointer hovers it, **Then** a delete control appears on that chip; **and**
   when no pointer is available or the chip is focused, that same control is present without hover.
4. **Given** a chip, **When** the viewer activates its delete control, **Then** the slot is deleted with no
   confirmation step, the chip is removed from its column, the deletion is announced naming the day and time
   that was removed, and no dialog or second click is required.
5. **Given** a deleted slot, **When** the deletion has completed, **Then** any posts that were scheduled
   against it keep their times, exactly as deleting a slot does today.
6. **Given** a pause, resume or delete that the server rejects, **When** the rejection arrives, **Then** the
   chip returns to its previous state, and the failure message is visible in text and announced.

---

### User Story 4 - See the week without being offered controls you cannot use (Priority: P2)

An editor opens Accounts to check when the Threads account posts. They see the same week grid with the same
chips in the same places, each one stating its day, time and whether it is active. Nothing invites them to
drag, place, retime or delete anything, because they cannot: no add affordance, no X, no drag handle, no time
input. If there are no slots at all, the line they get tells them who to ask rather than offering a button
that would fail.

**Why this priority**: The constitution requires roles to be enforced on the server and the design system
requires never showing a control a person cannot use. The grid is the one surface where that is easy to get
wrong, since every chip carries four controls.

**Independent Test**: Open Accounts as an editor on a project with slots. The grid renders every slot with its
day, time and state. No control on it mutates anything, and nothing is rendered disabled-but-present. With no
slots, the empty line names the people to ask.

**Acceptance Scenarios**:

1. **Given** a viewer without slot-manage permission, **When** the grid renders, **Then** every slot is shown
   with its day, time and active/paused state, and no add, move, retime or delete affordance is rendered for
   any of them.
2. **Given** that same viewer, **When** they click an empty position in a day column or a chip body,
   **Then** nothing is created, nothing is toggled, and no request is sent.
3. **Given** a viewer without slot-manage permission and an account with no slots, **When** the grid renders,
   **Then** the empty message names the managers to ask rather than offering an action.
4. **Given** any viewer, **When** a mutation is attempted against the server without slot-manage permission
   by any route, **Then** the server refuses it regardless of what the browser rendered.

---

### Edge Cases

- **A duplicate arriving from the other direction**: a slot is placed or moved onto a time that another person
  filled a moment ago, so the optimistic chip is already drawn when the refusal arrives. The chip must come
  back out and the refusal must be stated — the optimistic state is never left standing.
- **Two mutations in flight on the same chip**: the viewer toggles a chip and immediately deletes it, or
  retimes a chip while its toggle is still unresolved. The settled state must match what the server actually
  did, not the order the optimistic updates were applied in.
- **A drop that lands where it started**: dragging a chip and releasing it at the same rounded day and time is
  not a change, must not be sent as one, and must not announce a move.
- **A drop outside any day column**, or a drag released on the grid's own padding: the chip returns to where
  it was and nothing is sent.
- **Midnight and the end of the day**: a position that rounds below 00:00 or at or past 24:00 clamps into the
  day it was dropped in rather than spilling into the next or previous column.
- **An account with many slots on one day** — more than the column's visible height can hold at the grid's
  scale. The column must stay usable: every chip reachable, focusable, and nameable.
- **Mobile and narrow viewports**, where seven columns do not fit across a phone and there is no hover at all.
  The week must stay usable and the delete control must be present without hover.
- **A slot whose stored time has seconds** (`09:30:00` as Postgres returns it): displayed, named, announced and
  sent back as `HH:MM`, never with a stray `:00`.
- **The account is disconnected or needs reconnecting**: slots still show and still edit — a slot's existence
  is independent of the credential's health, as it is today.
- **A time-zone change on the project while the grid is open**: the grid labels the zone it was rendered for,
  and times are never silently reinterpreted against a different zone.
- **Reduced motion**: a viewer with `prefers-reduced-motion` set gets no snap, slide or settle animation, and
  every interaction still completes.
- **The connect hand-off**: someone finishes connecting an account and is sent to that account's slots to add
  some. Focus must land on something in the grid that actually starts that job.

## Requirements *(mandatory)*

### Functional Requirements

**The grid component**

- **FR-001**: A reusable week grid component MUST live in `src/components/schedule/` and MUST render exactly
  seven day columns in a single horizontal row, ordered Monday first through Sunday last, matching the
  existing ISO weekday numbering where Monday is 1.
- **FR-002**: Each column MUST show the slots for that weekday, ordered by time ascending, as one chip per
  slot.
- **FR-003**: The component MUST be presentational: it MUST take the slots to display, what the viewer is
  allowed to do, the time zone label and callbacks for add, move, retime, toggle and delete, and it MUST NOT
  reference accounts, server actions, routes or data access. It MUST be usable by a caller other than the
  accounts page without modification.
- **FR-004**: Each chip MUST display its time and its active/paused state, and MUST carry an accessible name
  that includes its weekday, its time and whether it is active or paused.
- **FR-005**: Times MUST be displayed and announced as 24-hour `HH:MM` in the project's time zone, with the
  zone named once for the grid, and MUST never render the seconds component of a stored time.
- **FR-006**: The grid MUST state, in text, which time zone its times are in.
- **FR-007**: When an account has no slots, the grid MUST show an empty message in place of chips, and the
  columns MUST remain visible and usable so a slot can be placed.

**Placing a slot**

- **FR-008**: A viewer who can manage slots MUST be able to add a slot by clicking or tapping an empty
  position within a day column, which creates a slot on that weekday.
- **FR-009**: The time created by a click MUST be the position rounded to a fixed step of 15 or 30 minutes,
  chosen once for the grid and applied identically to placing and to dropping.
- **FR-010**: A position that would round outside the day MUST be clamped into that day's range rather than
  creating a slot on an adjacent day.
- **FR-011**: A viewer MUST be able to add a slot on a chosen day using the keyboard alone, with no pointer
  positioning, and the newly created chip MUST receive focus.
- **FR-012**: A created slot's time MUST be editable afterwards through FR-018 and FR-019, so a rounded time
  is never a time the viewer is stuck with.

**Moving a slot**

- **FR-013**: A viewer who can manage slots MUST be able to drag a chip within its column to change the
  slot's time and into another column to change the slot's weekday, with the dropped time rounded by FR-009.
- **FR-014**: A drag that is released at the same weekday and rounded time it started from, or outside any day
  column, MUST leave the slot unchanged and MUST NOT send a request or announce a move.
- **FR-015**: Every move available by drag MUST also be available by keyboard: from a focused chip the viewer
  MUST be able to change the target weekday and the target time, commit the move, and cancel it; cancelling
  MUST leave the slot unchanged, send nothing, and keep focus on the chip.
- **FR-016**: A move onto a weekday and time the same account already has a slot at MUST be refused: the
  refusal MUST be shown in text, the moved chip MUST be shown again at its pre-move weekday and time, and
  neither slot's stored values may change.
- **FR-017**: A move MUST preserve the slot's identity, so anything already referencing that slot continues to
  reference it.

**Editing a slot's time**

- **FR-018**: Each chip MUST offer, to a viewer who can manage slots, a way to type an exact time for that
  slot without pointer positioning.
- **FR-019**: A typed time MUST be validated as 24-hour `HH:MM`, MUST be saved against the same slot, and MUST
  be subject to the same duplicate refusal as FR-016, with the same visible refusal and revert.
- **FR-020**: After a successful retime, the chip MUST appear in its column's correct time order.

**Deleting a slot**

- **FR-021**: Each chip MUST offer a delete control to a viewer who can manage slots. The control MUST be
  revealed when a pointer hovers the chip, and MUST be present without hover whenever the chip or the control
  is focused, and on devices that cannot hover.
- **FR-022**: Deleting a slot MUST take effect on a single activation, with no confirmation dialog and no
  second confirming click. This is a deliberate change from the two-step confirm `SlotRowActions` uses today
  and from the design system's rule that `danger` actions always confirm in a dialog: a slot holds no content,
  is cheap to re-add by one click in the grid, and deleting one does not change any post that is already
  scheduled. The exception MUST be recorded alongside the component in `docs/design-system.md`.
- **FR-023**: Deleting a slot MUST leave posts already scheduled against it with the times they already have,
  exactly as deleting a slot does today.

**Toggling active and paused**

- **FR-024**: Activating a chip's body MUST toggle that slot between active and paused for a viewer who can
  manage slots, using the existing pause behaviour.
- **FR-025**: A paused chip MUST be distinguishable from an active one by text and by a visual change that is
  not hue alone, and MUST read as clearly inactive rather than as a slightly different shade of active.
- **FR-026**: A chip's active/paused state MUST be conveyed in text to assistive technology and MUST NOT be
  carried by colour alone.

**Server-side move**

- **FR-027**: A move operation MUST exist in the slots service, taking a slot id, a target weekday and a
  target local time.
- **FR-028**: The move MUST require `slot: ["manage"]`, checked before the work and re-checked inside the
  transaction, in the same shape as the existing pause and delete operations, and MUST refuse a viewer without
  it.
- **FR-029**: The move MUST run inside a project-scoped transaction and MUST refuse a slot id that does not
  exist in the caller's project — including one that exists in another project — as not found.
- **FR-030**: The move MUST validate the target weekday and local time with the existing scheduling validation
  rather than a second copy of those rules, and MUST reject an out-of-range weekday or a malformed time.
- **FR-031**: The move MUST reject a target weekday and time the same account already has a slot at, with the
  same conflict outcome and the same message a duplicate add produces today, reusing that one rule rather
  than restating it.
- **FR-032**: A corresponding server action MUST expose the move to the accounts page, returning the same
  success and failure shapes the other slot actions return, and refreshing the route on success so
  server-rendered slot-derived figures stay correct.
- **FR-033**: A successful move MUST NOT reschedule, retime or otherwise alter any post or target that is
  already queued or scheduled.

**Optimistic updates and failures**

- **FR-034**: Every add, move, retime, toggle and delete MUST be reflected in the grid immediately, before the
  server has answered.
- **FR-035**: Any rejected or failed operation MUST restore the grid to the state it had before that
  operation, leave no optimistic change standing, show the failure message in text, and announce it.
- **FR-036**: When several operations are in flight, the state the grid settles on MUST match what the server
  actually recorded, not the order the optimistic updates were applied in.

**Permissions**

- **FR-037**: The grid MUST render read-only for a viewer without `slot: ["manage"]`: no add affordance, no
  drag, no delete control, no time input, and no toggling — and MUST NOT render those controls in a disabled
  state either.
- **FR-038**: A read-only viewer MUST still see every slot with its weekday, time and active/paused state.
- **FR-039**: Every mutation MUST be refused by the server for a viewer without `slot: ["manage"]`, regardless
  of what was rendered.
- **FR-040**: The accounts page MUST gate the grid's editing affordances on the slot-manage capability the
  services enforce, not on the account-manage capability it currently uses for every manager-only block.
- **FR-041**: Where no slots exist and the viewer cannot manage slots, the empty message MUST name the
  managers to ask, following the existing "Ask Robin or Sam to …" convention.

**Accessibility**

- **FR-042**: Placing, moving, retiming, deleting and toggling MUST each be completable with the keyboard
  alone, in a documented key sequence, with commit and cancel for the move interaction.
- **FR-043**: Every interactive element in the grid MUST be reachable in a logical tab order, MUST show a
  visible focus indicator, and MUST have an accessible name that identifies both the action and the slot it
  acts on.
- **FR-044**: Every completed change — added, moved, retimed, deleted, paused, resumed — and every refusal
  MUST produce a polite screen-reader announcement naming the slot's weekday and time, using the repository's
  existing live-region mechanism rather than a new one, and MUST work whether or not the page above the grid
  provides an announcement context.
- **FR-045**: Any snap, drag or settle animation MUST be suppressed for a viewer who prefers reduced motion,
  and every interaction MUST still complete without it.
- **FR-046**: The grid MUST remain usable at narrow viewport widths and on devices without hover.

**Replacing the current UI**

- **FR-047**: The accounts page MUST replace the Day / Time / Status / Actions slot table and the add-slot
  form with the grid, per account.
- **FR-048**: The add-slot form and the per-row pause/delete actions MUST be removed once nothing uses them.
  The unrelated mock-provider controls that share their file MUST be left in place and working.
- **FR-049**: The "Posting slots" definition sentence and the statement of the project time zone on the
  accounts page MUST be kept.
- **FR-050**: The post-connect hand-off that scrolls to an account's slots and focuses a control there MUST
  still land focus on something in the grid that begins adding a slot, since the control it currently targets
  is being deleted.
- **FR-051**: Slot-derived figures shown elsewhere — the per-account active and paused counts, and anything
  reading a project's slots — MUST be correct after every change made in the grid.

**Documentation**

- **FR-052**: The component MUST be added to the components table in `docs/design-system.md`, with its
  keyboard interaction and the no-confirm delete exception from FR-022 recorded.
- **FR-053**: The docket-ui skill's conventions MUST record the week grid as the way posting slots are edited,
  alongside the existing calendar drag-and-keyboard rule.
- **FR-054**: Any documentation describing the old add-slot flow — including the Accounts and getting-started
  docs — MUST be updated to describe the grid.

### Key Entities

- **Posting slot**: a weekly recurring posting time for one social account — an ISO weekday (1 = Monday …
  7 = Sunday), a wall-clock time in the project's time zone, and whether it is paused. An account cannot have
  two slots at the same weekday and time. Unchanged by this entry: no new field, no new granularity.
- **Week grid**: the presentational surface — seven weekday columns over a fixed time range, holding the chips
  for one account's slots, parameterised by what the viewer may do and by the rounding step.
- **Slot chip**: one slot as drawn in the grid — its time, its active/paused state, and the controls to
  retime, move, toggle and delete it, each present only when the viewer may use it.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Setting up five weekday morning slots on a fresh account takes five pointer actions in the grid
  and no form submissions, against the fifteen actions the current weekday-plus-time-plus-Add loop needs.
- **SC-002**: A newly added slot is visible in its day column with no page navigation and no searching a
  table, in every case.
- **SC-003**: Changing an existing slot's day or time is possible without deleting it: 100% of day and time
  changes preserve the slot, and no post already scheduled against it changes time.
- **SC-004**: Every one of the five interactions — place, move, retime, delete, toggle — is completable using
  only a keyboard, verified for all five.
- **SC-005**: Every chip's accessible name states its weekday, its time and whether it is active or paused;
  no chip conveys its state by colour alone.
- **SC-006**: Every completed change and every refusal produces exactly one polite announcement naming the
  weekday and time affected.
- **SC-007**: 100% of refused operations — duplicate day and time, permission refused, slot already gone —
  leave the grid showing the pre-operation state with the reason visible in text.
- **SC-008**: A viewer who cannot manage slots is offered zero mutating controls while still seeing 100% of
  the slots with their day, time and state.
- **SC-009**: No mutation succeeds for a caller without slot-manage permission, in all of the move, add,
  retime, toggle and delete paths.
- **SC-010**: The whole week for an account is readable in one glance with no scrolling at a desktop width,
  and remains usable at a phone width.
- **SC-011**: With reduced motion preferred, no drag, snap or settle animation runs, and all five interactions
  still complete.
- **SC-012**: Slot counts and active/paused figures shown anywhere in the app match the grid after every
  change.
- **SC-013**: The existing accounts tests still pass, with assertions that read the old slot table rewritten
  against the grid rather than removed, and no test deleted to make the suite green.

## Assumptions

- **Rounding step**: a 30-minute step is assumed for both placing and dropping, as the coarser of the two
  options the roadmap allows and the one that makes a click land on a round time more often. The exact time
  stays reachable by typing (FR-018). Planning may choose 15 minutes instead; it must be the same step for
  both interactions (FR-009).
- **Visible time range**: the columns are assumed to span the full day, 00:00 to 24:00, so every reachable
  time is placeable by pointer and no slot can exist outside the drawn area. Planning owns how that range is
  drawn at a readable height.
- **Keyboard move mechanism**: the roadmap allows either arrow-key stepping or an explicit move mode. Either
  satisfies FR-015. The repository's existing precedent for a keyboard equivalent to a drag is the calendar's
  "Move to slot…" menu plus dialog; planning should prefer consistency with that over inventing a third
  pattern, provided commit and cancel both exist.
- **Announcement mechanism**: the grid is assumed to drive its own mounted live region, as the calendar board
  does, because the accounts page does not provide an announcement context and a reusable component cannot
  require one. If an announcement context is present, the grid should use it.
- **No new runtime dependency**: drag-and-drop is assumed to use the same native browser drag events the
  calendar already uses. The constitution requires a justification in the plan and a decisions entry for any
  new runtime dependency, and pipeline phases cannot install one.
- **Test shape**: this repository has no browser DOM testing library. Interactive behaviour is therefore
  assumed to be verified the way the calendar's drag already is — decision, rounding, ordering, conflict and
  keyboard-step logic extracted into a pure module with unit tests, plus rendered-markup assertions for
  accessible names, state text and the presence or absence of each control per permission — together with
  service-level tests for the move and an integration test that the accounts page renders a real week and that
  a change persists. If planning concludes a requirement cannot be verified that way, it must mark the needed
  package as `NEEDS DEPENDENCY` rather than leaving the requirement unverified.
- **Permission source**: slot editing is assumed to be gated on `slot: ["manage"]` throughout (FR-040).
  Owner and admin hold it and editor does not, so no role's effective access changes.
- **Time-zone handling**: slots stay project-time-zone-only. The grid takes the zone label as a prop and
  performs no conversion; all stored times remain wall-clock times in the project's zone.
- **Scope of the caller**: the accounts page is the only caller in this entry. Reusability is a design
  constraint on the component's interface (FR-003), not a second screen to build.
- **Type scale**: the grid inherits the scale entry 1 settled — `text-sm` for chip times and labels, `text-xs
  text-muted-foreground` for the zone note and hints, nothing below 12 px, and no shrinking of text inside a
  control. The grid has no multi-line text, so `TextareaField` is not needed.
- **One account per grid**: a grid instance shows one account's slots. The duplicate rule is per account, so
  there is no cross-account conflict to resolve.

## Not included

None of the following is in this entry, and no later entry in the UI tweaks roadmap owns any of it:

- A month or day calendar view, or any change to `src/app/p/[projectSlug]/calendar/`.
- Slots at any granularity other than the current weekly weekday-plus-time: no date-specific slots, no
  recurrence rules, no durations, no multiple time zones.
- Copying or templating a week of slots from one account to another.
- Bulk editing slots across accounts, or a project-wide slot screen — the component is built so one can be
  added later, but this entry does not add it.
- A time zone per account; slots stay in the project's time zone.
- Rescheduling, retiming or re-queuing posts that are already scheduled when a slot moves or is deleted.
  A moved slot affects future scheduling only, and existing targets keep their times exactly as deleting a
  slot already does.
- Any change to how slot allocation, the queue or the scheduler reads slots.
- Undo for a deleted slot; re-adding one is a single click in the grid.
