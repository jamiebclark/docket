"use client";

import { useEffect, useId, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { announcedText, useAnnounce } from "@/components/ui/Announce";
import { Button } from "@/components/ui/Button";
import { cardStyles } from "@/components/ui/Card";
import { Dialog } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { LiveRegion } from "@/components/ui/LiveRegion";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import {
  additionFocusId,
  announceAdded,
  announceDeleted,
  announceMoved,
  announcePaused,
  announceRefused,
  announceResumed,
  announceRetimed,
  announceWeekAdded,
  applyOverrides,
  clearResolved,
  conflictAt,
  DUPLICATE_REFUSAL,
  hhmm,
  hourTicks,
  isNoOpMove,
  nextFreeTime,
  slotsByWeekday,
  STEP_MINUTES,
  timeAtPosition,
  topPercentOf,
  WEEK_ALREADY_SET,
  WEEKDAY_NAMES,
  WEEKDAYS,
  weekdaysMissingAt,
  type Addition,
  type GridSlot,
  type GridSlotState,
  type MoveIntent,
  type Override,
  type Weekday,
} from "./week-slot-grid-logic";

/**
 * Narrower than `ActionResult<T>` on purpose: the grid needs the outcome, the words, and — from `onAdd`
 * — the created slot's `id`, so focus can land on the real chip rather than the optimistic one.
 */
export type SlotActionOutcome = { ok: true; id?: string } | { ok: false; message: string };

/**
 * A week add's outcome. `added` and `alreadySet` come back from the server because it is the only party
 * that knows how the write actually landed — a day can be taken by a concurrent add between the grid
 * deciding what is missing and the insert running.
 */
export type WeekAddOutcome =
  | { ok: true; added: Weekday[]; alreadySet: Weekday[] }
  | { ok: false; message: string };

export interface WeekSlotGridProps {
  /** One account's slots. `localTime` may be `HH:MM` or `HH:MM:SS`; both normalise to `HH:MM`. */
  slots: readonly GridSlot[];
  /** The project's time zone, named once for the grid. Rendered as text; never used to convert. */
  timeZoneLabel: string;
  /** Whether this viewer may change anything. False renders a complete read-only grid. */
  canManage: boolean;
  /** Labels the grid for assistive technology, e.g. "Posting slots for Studio Page". */
  label: string;
  /** Shown once for the whole grid when `slots` is empty. The caller owns the wording. */
  emptyMessage: string;
  /** Put on the Monday column's add button so a caller can target it, e.g. the post-connect hand-off. */
  addButtonId?: string;

  /** Resolve with the created slot's `id` so focus can follow it; without one, focus falls to the add button. */
  onAdd(input: { weekday: Weekday; localTime: string }): Promise<SlotActionOutcome>;
  /**
   * Puts one time on every weekday that lacks it. Without this the grid renders no week control, so a
   * caller that has no bulk endpoint keeps the one-at-a-time grid unchanged.
   */
  onAddWeek?(input: { localTime: string }): Promise<WeekAddOutcome>;
  onMove(input: MoveIntent): Promise<SlotActionOutcome>;
  onToggle(input: { id: string; paused: boolean }): Promise<SlotActionOutcome>;
  onDelete(input: { id: string }): Promise<SlotActionOutcome>;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// One line, so a chip is short enough to sit at its own time without burying its neighbours.
const chipBaseStyles =
  "flex w-full items-center justify-between gap-1 rounded-md border px-1.5 py-0.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

const activeChipStyles = `${chipBaseStyles} border-accent bg-accent/40 hover:bg-accent/70`;

const pausedChipStyles = `${chipBaseStyles} border-dashed border-input bg-muted/70 text-muted-foreground hover:bg-muted`;

const controlRevealStyles =
  "inline-flex size-6 items-center justify-center rounded-md border border-input bg-surface text-muted-foreground opacity-0 transition-colors pointer-coarse:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

function chipName(weekday: Weekday, localTime: string, paused: boolean): string {
  return `${WEEKDAY_NAMES[weekday - 1]} ${hhmm(localTime)}, ${paused ? "paused" : "active"}`;
}

/**
 * The toggle button's own name. A control is named for what activating it does, so this leads with
 * the verb; the slot's day, time and state stay in the chip's text and on the `<li>`.
 */
function chipToggleName(weekday: Weekday, localTime: string, paused: boolean): string {
  const when = `${WEEKDAY_NAMES[weekday - 1]} ${hhmm(localTime)}`;
  return paused ? `Resume ${when}, paused` : `Pause ${when}`;
}

/**
 * Reusable, presentational grid of posting slots: seven weekday columns, click/drag to place and move,
 * pause/resume and delete. Knows about slots, callbacks and a time-zone label — nothing about an account,
 * a route or a server action.
 */
export function WeekSlotGrid({
  slots,
  timeZoneLabel,
  canManage,
  label,
  emptyMessage,
  addButtonId,
  onAdd,
  onAddWeek,
  onMove,
  onToggle,
  onDelete,
}: WeekSlotGridProps) {
  const announceCtx = useAnnounce();
  const uid = useId();
  const weekFieldId = `${uid}-week-time`;
  const [localMessage, setLocalMessage] = useState("");
  const localCount = useRef(0);
  const [error, setError] = useState("");
  const [overrides, setOverrides] = useState<Map<string, Override>>(new Map());
  const [additions, setAdditions] = useState<Addition[]>([]);
  // A seq a mutation resolved with, held outside state so adding to it never itself triggers a render; a
  // render is triggered separately via `resolveTick`, and `clearResolved` always reads this ref fresh.
  const resolvedSeqsRef = useRef<Set<number>>(new Set());
  // Identity of the `slots` prop at the last clear, so the effect below can tell a refreshed tree from
  // a re-render caused by its own state.
  const prevSlotsRef = useRef(slots);
  const [resolveTick, setResolveTick] = useState(0);
  const seqRef = useRef(0);
  const draggingId = useRef<string | null>(null);
  const focusTarget = useRef<string | null>(null);
  const [moveDialog, setMoveDialog] = useState<{ id: string; weekday: Weekday; localTime: string } | null>(null);
  // `weekError` holds only what is wrong with the field's own value (an empty time), which is what
  // `Field`'s error slot and its `aria-invalid` are for. A valid time that changes nothing, and a
  // refusal from the server, go to the grid's `error` line instead — see `handleAddWeek`.
  const [weekTime, setWeekTime] = useState("09:00");
  const [weekError, setWeekError] = useState("");
  const [weekPending, setWeekPending] = useState(false);
  // Where the chip would land if released now: the column shows it will accept the drop, and the time
  // the drop would set. Without this the time a drag will produce is invisible until after it happens,
  // and a column is 30 rem of unlabelled space between hour rules.
  const [dragPreview, setDragPreview] = useState<{ weekday: Weekday; localTime: string; taken: boolean } | null>(null);

  function resolveSeq(seq: number) {
    resolvedSeqsRef.current.add(seq);
    setResolveTick((t) => t + 1);
  }

  useEffect(() => {
    // Clear an optimistic change only once a REFRESHED `slots` has actually landed, never merely because
    // the action resolved. Next.js settles the action promise before it applies the refreshed tree, so
    // clearing on resolution drops the override while `slots` is still the pre-change value: the chip
    // snaps back to its old state and then forward again a render later, which is the toggle flicker.
    const freshSlots = prevSlotsRef.current !== slots;
    prevSlotsRef.current = slots;
    if (!freshSlots) return;
    // The snapshot is a fresh Set per run — never the object a deferred state-updater closure holds — so
    // nothing here can be emptied out from under one.
    const done = new Set(resolvedSeqsRef.current);
    if (done.size === 0) return;
    setOverrides((prev) => clearResolved(prev, [], done).overrides);
    setAdditions((prev) => clearResolved(new Map(), prev, done).additions);
    for (const seq of done) resolvedSeqsRef.current.delete(seq);
  }, [slots, resolveTick]);

  useEffect(() => {
    const id = focusTarget.current;
    if (!id) return;
    const el = document.getElementById(id);
    // A target can be named before it exists: a server action resolves before Next.js applies the
    // refreshed tree, so a just-created slot's chip arrives a render or two after the add resolves.
    // Keep the target and let the render that brings the new `slots` in run this again.
    if (!el) return;
    focusTarget.current = null;
    el.focus();
  }, [slots, overrides, additions]);

  function say(message: string) {
    if (announceCtx) {
      announceCtx.announce(message);
      return;
    }
    setLocalMessage(announcedText(message, ++localCount.current));
  }

  const view = applyOverrides(slots, overrides, additions);
  const columns = slotsByWeekday(view);

  function addButtonIdFor(weekday: Weekday): string {
    return weekday === 1 && addButtonId ? addButtonId : `week-slot-grid-add-${weekday}`;
  }

  function patch(id: string, weekday: Weekday, localTime: string, paused: boolean): number {
    const seq = ++seqRef.current;
    setOverrides((prev) => new Map(prev).set(id, { kind: "patch", seq, weekday, localTime, paused }));
    return seq;
  }

  function clearIfUnresolved(id: string, seq: number) {
    setOverrides((prev) => {
      const current = prev.get(id);
      if (!current || current.seq !== seq) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }

  async function handleAdd(weekday: Weekday, localTime: string) {
    setError("");
    // Refuse a duplicate locally, as the move path does, so a click onto an occupied time costs no
    // round trip and shows no chip that flashes in and out again.
    if (conflictAt(view, { weekday, localTime })) {
      setError(DUPLICATE_REFUSAL);
      say(announceRefused(weekday, localTime, DUPLICATE_REFUSAL));
      return;
    }
    const seq = ++seqRef.current;
    const tempId = `pending-${seq}`;
    setAdditions((prev) => [...prev, { tempId, seq, weekday, localTime }]);
    focusTarget.current = `slot-${tempId}`;
    const outcome = await onAdd({ weekday, localTime });
    if (outcome.ok) {
      focusTarget.current = additionFocusId(outcome.id, addButtonIdFor(weekday));
      resolveSeq(seq);
      say(announceAdded(weekday, localTime));
    } else {
      setAdditions((prev) => prev.filter((a) => a.seq !== seq));
      setError(outcome.message);
      say(announceRefused(weekday, localTime, outcome.message));
    }
  }

  /**
   * One seq for all seven optimistic additions, so `clearResolved` drops them together and a refusal
   * rolls the whole week back rather than leaving part of it on screen.
   */
  async function handleAddWeek() {
    if (!onAddWeek || weekPending) return;
    setError("");
    // An empty `type="time"` reads back as "", which is the only way the regex fails here — a browser
    // never hands over a half-typed time. So the message names the real problem.
    if (!TIME_RE.test(weekTime)) {
      setWeekError("Pick a time");
      return;
    }
    setWeekError("");
    const missing = weekdaysMissingAt(view, weekTime);
    // Not a field error: the time is valid and the action is simply a no-op. Routed through the grid's
    // own error line and `say`, which re-announces an unchanged message where an `aria-live` node does
    // not — so pressing the button twice says it twice, and `aria-invalid` never lands on a good value.
    if (missing.length === 0) {
      setError(WEEK_ALREADY_SET);
      say(announceWeekAdded(weekTime, [], WEEKDAYS));
      return;
    }
    const seq = ++seqRef.current;
    setAdditions((prev) => [
      ...prev,
      ...missing.map((weekday) => ({ tempId: `pending-${seq}-${weekday}`, seq, weekday, localTime: weekTime })),
    ]);
    setWeekPending(true);
    try {
      const outcome = await onAddWeek({ localTime: weekTime });
      if (outcome.ok) {
        resolveSeq(seq);
        say(announceWeekAdded(weekTime, outcome.added, outcome.alreadySet));
      } else {
        setAdditions((prev) => prev.filter((a) => a.seq !== seq));
        setError(outcome.message);
        say(outcome.message);
      }
    } finally {
      setWeekPending(false);
    }
  }

  async function handleToggle(slot: GridSlotState, weekday: Weekday) {
    setError("");
    const next = !slot.paused;
    const seq = patch(slot.id, weekday, slot.localTime, next);
    const outcome = await onToggle({ id: slot.id, paused: next });
    if (outcome.ok) {
      resolveSeq(seq);
      say(next ? announcePaused(weekday, slot.localTime) : announceResumed(weekday, slot.localTime));
    } else {
      clearIfUnresolved(slot.id, seq);
      setError(outcome.message);
      say(announceRefused(weekday, slot.localTime, outcome.message));
    }
  }

  async function handleDelete(slot: GridSlotState, weekday: Weekday) {
    setError("");
    const seq = ++seqRef.current;
    const column = columns[weekday - 1]!;
    const index = column.findIndex((s) => s.id === slot.id);
    const next = column[index + 1] ?? column[index - 1];
    focusTarget.current = next ? `slot-${next.id}` : addButtonIdFor(weekday);
    setOverrides((prev) => new Map(prev).set(slot.id, { kind: "deleted", seq }));
    const outcome = await onDelete({ id: slot.id });
    if (outcome.ok) {
      resolveSeq(seq);
      say(announceDeleted(weekday, slot.localTime));
    } else {
      clearIfUnresolved(slot.id, seq);
      setError(outcome.message);
      say(announceRefused(weekday, slot.localTime, outcome.message));
    }
  }

  async function handleMove(intent: MoveIntent, originalWeekday: Weekday, current: GridSlotState, exact = false) {
    if (isNoOpMove(current, intent, exact)) return;
    const conflict = conflictAt(view, intent, intent.id);
    if (conflict) {
      setError(DUPLICATE_REFUSAL);
      say(announceRefused(intent.weekday, intent.localTime, DUPLICATE_REFUSAL));
      return;
    }
    setError("");
    const seq = patch(intent.id, intent.weekday, intent.localTime, current.paused);
    const outcome = await onMove(intent);
    const describe = intent.weekday === originalWeekday ? announceRetimed : announceMoved;
    if (outcome.ok) {
      resolveSeq(seq);
      say(describe(intent.weekday, intent.localTime));
    } else {
      clearIfUnresolved(intent.id, seq);
      setError(outcome.message);
      say(announceRefused(intent.weekday, intent.localTime, outcome.message));
    }
  }

  function columnClickHandler(weekday: Weekday) {
    if (!canManage) return undefined;
    return (e: MouseEvent<HTMLDivElement>) => {
      // A click on the column's own empty space places a slot, wherever in that space it lands —
      // matching the drop path, which is honoured anywhere in the column. A chip is not empty space:
      // bail for anything inside an `<li>` (its padding as well as its controls, and a pending chip
      // whose own handler is absent and would otherwise bubble to here) and for any control.
      if (e.target instanceof Element && e.target.closest("li, button, a, input, select, textarea")) return;
      const rect = e.currentTarget.getBoundingClientRect();
      void handleAdd(weekday, timeAtPosition(e.clientY - rect.top, rect.height));
    };
  }

  function columnDragOverHandler(weekday: Weekday) {
    if (!canManage) return undefined;
    return (e: DragEvent<HTMLDivElement>) => {
      const id = draggingId.current;
      if (!id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      // Calling preventDefault is what makes this a valid drop target, so say so on screen: without it
      // the only feedback that a day will accept the chip is the cursor. The time comes from the same
      // `timeAtPosition` the drop itself will use, so the preview cannot promise a different time.
      const rect = e.currentTarget.getBoundingClientRect();
      const localTime = timeAtPosition(e.clientY - rect.top, rect.height);
      const taken = conflictAt(view, { weekday, localTime }, id) !== null;
      setDragPreview((prev) =>
        prev && prev.weekday === weekday && prev.localTime === localTime && prev.taken === taken
          ? prev // same position: keep the object so dragover, which fires continuously, renders nothing new
          : { weekday, localTime, taken },
      );
    };
  }

  function columnDragLeaveHandler(weekday: Weekday) {
    if (!canManage) return undefined;
    return (e: DragEvent<HTMLDivElement>) => {
      // Leaving for a child of the same column is not leaving the column.
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setDragPreview((prev) => (prev?.weekday === weekday ? null : prev));
    };
  }

  function columnDropHandler(weekday: Weekday) {
    if (!canManage) return undefined;
    return (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragPreview(null);
      const id = draggingId.current;
      draggingId.current = null;
      if (!id) return;
      const current = view.find((s) => s.id === id);
      if (!current) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const localTime = timeAtPosition(e.clientY - rect.top, rect.height);
      void handleMove({ id, weekday, localTime }, current.weekday, current);
    };
  }

  function readOnlyChip(slot: GridSlotState, weekday: Weekday) {
    return (
      <li
        key={slot.id}
        aria-label={chipName(weekday, slot.localTime, slot.paused)}
        className={`absolute inset-x-0 ${slot.paused ? pausedChipStyles : activeChipStyles}`}
        style={{ top: `${topPercentOf(slot.localTime)}%` }}
      >
        <span className="font-medium">{hhmm(slot.localTime)}</span>
        <span>{slot.paused ? "Paused" : "Active"}</span>
      </li>
    );
  }

  function managedChip(slot: GridSlotState, weekday: Weekday) {
    const name = chipName(weekday, slot.localTime, slot.paused);
    // An addition's id is a temp `pending-N` id until the server confirms it; the controls below send `id`
    // straight to actions that validate `z.uuid()`, so none of them may fire against a temp id.
    const confirmed = !slot.id.startsWith("pending-");
    return (
      <li
        key={slot.id}
        // The row keeps the plain day/time/state name (G3), as the read-only chip does; the body
        // button inside it is named for the action it performs instead.
        aria-label={name}
        className="group absolute inset-x-0"
        style={{ top: `${topPercentOf(slot.localTime)}%` }}
        draggable={confirmed}
        aria-busy={slot.pending || undefined}
        onDragStart={
          confirmed
            ? (e) => {
                draggingId.current = slot.id;
                e.dataTransfer.setData("text/plain", slot.id);
                e.dataTransfer.effectAllowed = "move";
              }
            : undefined
        }
        onDragEnd={
          confirmed
            ? () => {
                draggingId.current = null;
                setDragPreview(null);
              }
            : undefined
        }
      >
        <button
          type="button"
          id={`slot-${slot.id}`}
          aria-label={chipToggleName(weekday, slot.localTime, slot.paused)}
          className={slot.paused ? pausedChipStyles : activeChipStyles}
          aria-disabled={!confirmed || undefined}
          onClick={
            confirmed
              ? (e) => {
                  e.stopPropagation();
                  void handleToggle(slot, weekday);
                }
              : undefined
          }
        >
          <span className="font-medium">{hhmm(slot.localTime)}</span>
          <span>{slot.paused ? "Paused" : "Active"}</span>
        </button>
        {confirmed ? (
          <span className="absolute top-1 right-1 flex gap-1">
            <button
              type="button"
              aria-label={`Move ${name}`}
              className={controlRevealStyles}
              onClick={(e) => {
                e.stopPropagation();
                setMoveDialog({ id: slot.id, weekday, localTime: hhmm(slot.localTime) });
              }}
            >
              <Icon name="clock" size={14} />
              <span className="sr-only">Move…</span>
            </button>
            <button
              type="button"
              aria-label={`Delete ${name}`}
              className={controlRevealStyles}
              onClick={(e) => {
                e.stopPropagation();
                void handleDelete(slot, weekday);
              }}
            >
              <Icon name="trash" size={14} />
              <span className="sr-only">Delete</span>
            </button>
          </span>
        ) : null}
      </li>
    );
  }

  const dialogSlot = moveDialog ? view.find((s) => s.id === moveDialog.id) : undefined;

  return (
    <div className="flex flex-col gap-2">
      {!announceCtx ? <LiveRegion message={localMessage} /> : null}
      {/* Visible text only. Every refusal is already announced politely through `say`, with the day
          and time included; a `role="alert"` here would interrupt and then repeat it. */}
      {error ? <p className="text-xs text-danger">{error}</p> : null}
      <p className="text-xs text-muted-foreground">Times are shown in {timeZoneLabel}.</p>
      {canManage && onAddWeek ? (
        <form
          className={`${cardStyles} flex w-fit flex-wrap items-end gap-3 p-3`}
          // The browser must not refuse an off-step time with a native bubble: `step` is here so the
          // picker's arrows move in half hours, not as validation. An exact typed time is allowed, as
          // the Move dialog allows one.
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void handleAddWeek();
          }}
          aria-label="Add a time to every day"
        >
          <div className="w-48">
            <Field
              id={weekFieldId}
              type="time"
              step={STEP_MINUTES * 60}
              required
              label="Add a time to every day"
              hint="Days that already have it are left alone."
              value={weekTime}
              error={weekError}
              onChange={(e) => {
                setWeekTime(e.target.value);
                setWeekError("");
              }}
            />
          </div>
          {/* `mb-5` clears `Field`'s always-rendered error paragraph, as ConnectMockForm does. */}
          <Button type="submit" variant="secondary" className="mb-5" pending={weekPending} pendingLabel="Adding…">
            Add to every day
          </Button>
        </form>
      ) : null}
      {/* Keyed on the rendered view, not the `slots` prop: an optimistic addition must clear the
          empty line immediately, and deleting the last slot must keep it until the server confirms. */}
      {view.length === 0 ? <p className="text-xs text-muted-foreground">{emptyMessage}</p> : null}
      <div role="group" aria-label={label} className="grid grid-cols-1 items-stretch gap-2 md:grid-cols-7">
        {columns.map((dayItems, i) => {
          const weekday = (i + 1) as Weekday;
          const dayName = WEEKDAY_NAMES[i];
          const addTime = nextFreeTime(dayItems);
          return (
            <section key={weekday} aria-label={dayName} className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-2 shadow-card">
              <h3 className="text-xs font-semibold text-muted-foreground">{dayName}</h3>
              {/* A day runs top to bottom over the column's height, so a chip sits at its own time and a
                  drop lands where it was dropped. `timeAtPosition` and `topPercentOf` both measure this
                  one element, so the position a click maps to is the position the chip renders at. */}
              {/* `min-h`, not `h` plus `flex-1`: inside this flex column `flex-1` resolves to a zero
                  flex-basis and collapses the track, which `overflow-hidden` then clips the chips out of. */}
              <div className="relative min-h-[30rem] overflow-hidden rounded-lg bg-muted/15">
                {hourTicks().map(({ hour, topPercent }) => (
                  <div key={hour} aria-hidden className="pointer-events-none absolute inset-x-0 border-t border-border/40" style={{ top: `${topPercent}%` }}>
                    {hour % 6 === 0 ? <span className="pl-1 text-[0.625rem] leading-none text-muted-foreground">{String(hour).padStart(2, "0")}</span> : null}
                  </div>
                ))}
                <div
                  className={`absolute inset-x-1 top-0 bottom-6 transition-colors ${
                    dragPreview?.weekday === weekday
                      ? dragPreview.taken
                        ? "rounded-md bg-danger/10 ring-2 ring-danger/50"
                        : "rounded-md bg-primary/10 ring-2 ring-primary/50"
                      : ""
                  }`}
                  onClick={columnClickHandler(weekday)}
                  onDragOver={columnDragOverHandler(weekday)}
                  onDragLeave={columnDragLeaveHandler(weekday)}
                  onDrop={columnDropHandler(weekday)}
                >
                  <ul className="absolute inset-0">
                    {dayItems.map((slot) => (canManage ? managedChip(slot, weekday) : readOnlyChip(slot, weekday)))}
                  </ul>
                  {/* The time the drop would set, at the position it would set it. Pointer-only and
                      decorative — `aria-hidden`, since the keyboard path goes through the move dialog,
                      which shows and edits the same time as a real field. */}
                  {dragPreview?.weekday === weekday ? (
                    <div
                      aria-hidden
                      className="pointer-events-none absolute inset-x-0 z-10"
                      style={{ top: `${topPercentOf(dragPreview.localTime)}%` }}
                    >
                      <div className={`border-t-2 ${dragPreview.taken ? "border-danger" : "border-primary"}`} />
                      <span
                        className={`absolute left-0 top-0 -translate-y-1/2 rounded border px-1 py-px text-[0.625rem] font-medium leading-tight tabular-nums ${
                          // The danger trio flips together between themes, as Alert and Badge use it;
                          // `text-danger` on its own background is the only pairing that stays legible in both.
                          dragPreview.taken
                            ? "border-danger-border bg-danger-bg text-danger"
                            : "border-primary bg-primary text-primary-foreground"
                        }`}
                      >
                        {hhmm(dragPreview.localTime)}
                        {dragPreview.taken ? " · taken" : ""}
                      </span>
                    </div>
                  ) : null}
                </div>
              </div>
              {canManage ? (
                <Button
                  id={addButtonIdFor(weekday)}
                  aria-label={`Add a slot on ${dayName}`}
                  variant="secondary"
                  size="sm"
                  disabled={addTime === null}
                  title={addTime === null ? "No free time left in the day" : undefined}
                  onClick={() => addTime !== null && void handleAdd(weekday, addTime)}
                >
                  Add slot
                </Button>
              ) : null}
            </section>
          );
        })}
      </div>

      {moveDialog && dialogSlot ? (
        <MoveSlotDialog
          weekday={moveDialog.weekday}
          localTime={moveDialog.localTime}
          onCancel={() => setMoveDialog(null)}
          onMove={(weekday, localTime) => {
            const { id, weekday: originalWeekday } = moveDialog;
            const slot = dialogSlot;
            setMoveDialog(null);
            void handleMove({ id, weekday, localTime }, originalWeekday, slot, true);
          }}
        />
      ) : null}
    </div>
  );
}

function MoveSlotDialog({
  weekday,
  localTime,
  onCancel,
  onMove,
}: {
  weekday: Weekday;
  localTime: string;
  onCancel: () => void;
  onMove: (weekday: Weekday, localTime: string) => void;
}) {
  const [day, setDay] = useState(String(weekday));
  const [time, setTime] = useState(localTime);
  const [error, setError] = useState("");

  function submit() {
    if (!TIME_RE.test(time)) {
      setError("Use 24-hour time as HH:MM");
      return;
    }
    onMove(Number(day) as Weekday, time);
  }

  return (
    <Dialog open onClose={onCancel} title="Move slot">
      <div className="flex flex-col gap-4">
        <SegmentedControl
          name="move-slot-weekday"
          label="Weekday"
          value={day}
          onChange={setDay}
          options={WEEKDAY_NAMES.map((d, i) => ({ value: String(i + 1), label: d.slice(0, 3) }))}
        />
        <Field id="move-slot-time" type="time" label="Time" value={time} onChange={(e) => setTime(e.target.value)} error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={submit}>Move</Button>
        </div>
      </div>
    </Dialog>
  );
}
