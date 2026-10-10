"use client";

import { useEffect, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { announcedText, useAnnounce } from "@/components/ui/Announce";
import { Button } from "@/components/ui/Button";
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
  applyOverrides,
  conflictAt,
  DUPLICATE_REFUSAL,
  hhmm,
  isNoOpMove,
  nextFreeTime,
  slotsByWeekday,
  timeAtPosition,
  WEEKDAY_NAMES,
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
  onMove(input: MoveIntent): Promise<SlotActionOutcome>;
  onToggle(input: { id: string; paused: boolean }): Promise<SlotActionOutcome>;
  onDelete(input: { id: string }): Promise<SlotActionOutcome>;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const activeChipStyles =
  "flex w-full flex-col items-start gap-0.5 rounded-lg border border-accent bg-accent/30 px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

const pausedChipStyles =
  "flex w-full flex-col items-start gap-0.5 rounded-lg border border-dashed border-input bg-muted/50 px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

const controlRevealStyles =
  "inline-flex size-6 items-center justify-center rounded-md border border-input bg-surface text-muted-foreground opacity-0 transition-colors pointer-coarse:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

function chipName(weekday: Weekday, localTime: string, paused: boolean): string {
  return `${WEEKDAY_NAMES[weekday - 1]} ${hhmm(localTime)}, ${paused ? "paused" : "active"}`;
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
  onMove,
  onToggle,
  onDelete,
}: WeekSlotGridProps) {
  const announceCtx = useAnnounce();
  const [localMessage, setLocalMessage] = useState("");
  const localCount = useRef(0);
  const [error, setError] = useState("");
  const [overrides, setOverrides] = useState<Map<string, Override>>(new Map());
  const [additions, setAdditions] = useState<Addition[]>([]);
  // A seq a mutation resolved with, held outside state so adding to it never itself triggers a render; a
  // render is triggered separately via `resolveTick`, and `clearResolved` always reads this ref fresh.
  const resolvedSeqsRef = useRef<Set<number>>(new Set());
  const [resolveTick, setResolveTick] = useState(0);
  const seqRef = useRef(0);
  const draggingId = useRef<string | null>(null);
  const focusTarget = useRef<string | null>(null);
  const [moveDialog, setMoveDialog] = useState<{ id: string; weekday: Weekday; localTime: string } | null>(null);

  function resolveSeq(seq: number) {
    resolvedSeqsRef.current.add(seq);
    setResolveTick((t) => t + 1);
  }

  useEffect(() => {
    // The snapshot is a fresh Set per run — never the object a deferred state-updater closure holds — so
    // nothing here can be emptied out from under one.
    const done = new Set(resolvedSeqsRef.current);
    if (done.size === 0) return;
    setOverrides((prev) => {
      const next = new Map(prev);
      for (const [id, ov] of prev) if (done.has(ov.seq)) next.delete(id);
      return next;
    });
    setAdditions((prev) => prev.filter((a) => !done.has(a.seq)));
    for (const seq of done) resolvedSeqsRef.current.delete(seq);
  }, [resolveTick, additions]);

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
      if (e.target !== e.currentTarget) return;
      const rect = e.currentTarget.getBoundingClientRect();
      void handleAdd(weekday, timeAtPosition(e.clientY - rect.top, rect.height));
    };
  }

  function columnDragOverHandler() {
    if (!canManage) return undefined;
    return (e: DragEvent<HTMLDivElement>) => {
      if (!draggingId.current) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    };
  }

  function columnDropHandler(weekday: Weekday) {
    if (!canManage) return undefined;
    return (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
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
      <li key={slot.id} aria-label={chipName(weekday, slot.localTime, slot.paused)} className={slot.paused ? pausedChipStyles : activeChipStyles}>
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
        className="group relative"
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
        onDragEnd={confirmed ? () => (draggingId.current = null) : undefined}
      >
        <button
          type="button"
          id={`slot-${slot.id}`}
          aria-label={name}
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
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">Times are shown in {timeZoneLabel}.</p>
      {slots.length === 0 ? <p className="text-xs text-muted-foreground">{emptyMessage}</p> : null}
      <div role="group" aria-label={label} className="grid grid-cols-1 items-stretch gap-2 md:grid-cols-7">
        {columns.map((dayItems, i) => {
          const weekday = (i + 1) as Weekday;
          const dayName = WEEKDAY_NAMES[i];
          const addTime = nextFreeTime(dayItems);
          return (
            <section key={weekday} aria-label={dayName} className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-2 shadow-card">
              <h3 className="text-xs font-semibold text-muted-foreground">{dayName}</h3>
              <div
                className="flex min-h-40 flex-1 flex-col gap-1.5"
                onClick={columnClickHandler(weekday)}
                onDragOver={columnDragOverHandler()}
                onDrop={columnDropHandler(weekday)}
              >
                <ul className="flex flex-col gap-1.5">{dayItems.map((slot) => (canManage ? managedChip(slot, weekday) : readOnlyChip(slot, weekday)))}</ul>
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
