"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import type { ActionResult } from "@/lib/action-result";
import type { EmptySlot, PullExpected, PullMove, QueuedItem } from "@/server/services/queue";
import { formatPlanned } from "./calendar-logic";

type Loaded<T> = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; data: T };

/** Loads when the dialog opens (the board mounts it only while open); a failure is shown inside the dialog. */
function useLoaded<T>(open: boolean, load: () => Promise<ActionResult<T>>): Loaded<T> {
  const [value, setValue] = useState<Loaded<T>>({ state: "loading" });
  useEffect(() => {
    if (!open) return;
    let live = true;
    load().then(
      (r) => live && setValue(r.ok ? { state: "ready", data: r.data } : { state: "error", message: r.message }),
      () => live && setValue({ state: "error", message: "That could not be loaded. Close this and try again." }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return value;
}

function Status({ loaded, empty }: { loaded: Loaded<unknown[]>; empty: string }) {
  if (loaded.state === "loading") return <p role="status" className="text-sm">Loading…</p>;
  if (loaded.state === "error") return <p role="alert" className="text-sm text-red-700 dark:text-red-400">{loaded.message}</p>;
  if (loaded.data.length === 0) return <p className="text-sm">{empty}</p>;
  return null;
}

export interface MoveToSlotProps {
  open: boolean;
  onClose: () => void;
  accountName: string;
  listSlots: () => Promise<ActionResult<EmptySlot[]>>;
  onPick: (slot: EmptySlot) => void;
}

/** "Move to slot…": the account's upcoming empty slots, the keyboard route to what drag and drop does. */
export function MoveToSlotDialog({ open, onClose, accountName, listSlots, onPick }: MoveToSlotProps) {
  const loaded = useLoaded(open, listSlots);
  return (
    <Dialog open={open} onClose={onClose} title={`Move to a slot on ${accountName}`}>
      <Status loaded={loaded as Loaded<unknown[]>} empty="No empty slots in the coming weeks. Add or resume a posting slot on the Accounts page." />
      {loaded.state === "ready" && loaded.data.length > 0 ? (
        <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {loaded.data.map((s) => (
            <li key={`${s.slotId}-${s.scheduledAt}`}>
              <button
                type="button"
                onClick={() => onPick(s)}
                className="w-full rounded border border-dashed border-foreground/40 px-3 py-1.5 text-left text-sm hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground"
              >
                {formatPlanned(s.localTime)}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-4 flex justify-end">
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
    </Dialog>
  );
}

export interface SwapProps {
  open: boolean;
  onClose: () => void;
  /** The chip being swapped is not offered. */
  exceptTargetId: string;
  listQueued: () => Promise<ActionResult<QueuedItem[]>>;
  onPick: (item: QueuedItem) => void;
}

/** "Swap with…": the account's other queued posts. */
export function SwapDialog({ open, onClose, exceptTargetId, listQueued, onPick }: SwapProps) {
  const loaded = useLoaded(open, listQueued);
  const items = loaded.state === "ready" ? loaded.data.filter((i) => i.targetId !== exceptTargetId) : [];
  return (
    <Dialog open={open} onClose={onClose} title="Swap with another queued post">
      <Status loaded={loaded.state === "ready" ? { state: "ready", data: items } : (loaded as Loaded<unknown[]>)} empty="No other queued posts on this account." />
      {items.length > 0 ? (
        <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {items.map((i) => (
            <li key={i.targetId}>
              <button
                type="button"
                onClick={() => onPick(i)}
                className="w-full rounded border border-foreground/30 px-3 py-1.5 text-left text-sm hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground"
              >
                <span className="block font-medium">{formatPlanned(i.localTime)}</span>
                <span className="block truncate text-foreground/70">{i.excerpt || "(no text)"}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-4 flex justify-end">
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
    </Dialog>
  );
}

export interface PullProps {
  open: boolean;
  onClose: () => void;
  accountName: string;
  preview: () => Promise<ActionResult<{ moved: PullMove[] }>>;
  confirm: (expected: PullExpected[]) => Promise<ActionResult<{ moved: PullMove[] }>>;
  onDone: (moved: PullMove[]) => void;
}

/** "Pull queue forward…": lists what would move before anything does. */
export function PullForwardDialog({ open, onClose, accountName, preview, confirm, onDone }: PullProps) {
  const loaded = useLoaded(open, preview);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const moves = loaded.state === "ready" ? loaded.data.moved : [];
  return (
    <Dialog open={open} onClose={onClose} title={`Pull ${accountName}'s queue forward`}>
      <Status loaded={loaded.state === "ready" ? { state: "ready", data: moves } : (loaded as Loaded<unknown[]>)} empty="Nothing to move: the queue has no gaps." />
      {moves.length > 0 ? (
        <ul className="mb-2 flex max-h-72 flex-col gap-1 overflow-y-auto text-sm">
          {moves.map((m) => (
            <li key={m.targetId}>
              {formatPlanned(m.fromLocal)} → {formatPlanned(m.toLocal)}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p> : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        {moves.length > 0 ? (
          <Button
            pending={pending}
            pendingLabel="Moving…"
            onClick={async () => {
              setPending(true);
              setError("");
              const r = await confirm(moves.map((m) => ({ targetId: m.targetId, to: m.to })));
              setPending(false);
              if (r.ok) onDone(r.data.moved);
              else setError(r.message);
            }}
          >
            Pull forward
          </Button>
        ) : null}
      </div>
    </Dialog>
  );
}
