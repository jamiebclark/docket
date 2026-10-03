"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { formatLocal } from "@/components/ui/LocalTime";
import { addToQueueAction, previewQueueAction } from "./actions";

export interface QueueTarget {
  targetId: string;
  accountId: string;
  ok: boolean;
  scheduledAt?: string;
  message?: string;
  changedFromPreview?: boolean;
}

type Phase =
  | { kind: "loading" }
  | { kind: "preview"; rows: QueueTarget[] }
  | { kind: "done"; rows: QueueTarget[] }
  | { kind: "error"; message: string };

/**
 * "Add to queue…": shows the time each account would get (nothing is reserved), then, after confirming,
 * the times actually assigned. `changedFromPreview` flags a slot someone else took in between.
 */
export function AddToQueueDialog({
  open,
  onClose,
  slug,
  postId,
  timeZone,
  names,
  onQueued,
}: {
  open: boolean;
  onClose: () => void;
  slug: string;
  postId: string;
  timeZone: string;
  /** accountId → display name. */
  names: Record<string, string>;
  onQueued: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    previewQueueAction(slug, { postId }).then((res) => {
      if (!live) return;
      setPhase(
        res.ok
          ? { kind: "preview", rows: res.data.map((r) => ({ ...r, ...(r.ok ? { scheduledAt: r.scheduledAt } : {}) })) }
          : { kind: "error", message: res.message },
      );
    });
    return () => {
      live = false;
    };
  }, [open, slug, postId]);

  async function confirm(rows: QueueTarget[]) {
    setPending(true);
    const expected = Object.fromEntries(rows.filter((r) => r.ok && r.scheduledAt).map((r) => [r.targetId, r.scheduledAt!]));
    const res = await addToQueueAction(slug, { postId, expected });
    setPending(false);
    if (!res.ok) return setPhase({ kind: "error", message: res.message });
    setPhase({ kind: "done", rows: res.data });
    onQueued();
  }

  const rows = phase.kind === "preview" || phase.kind === "done" ? phase.rows : [];
  const anyQueueable = rows.some((r) => r.ok);
  return (
    <Dialog
      open={open}
      onClose={() => {
        setPhase({ kind: "loading" });
        onClose();
      }}
      title={phase.kind === "done" ? "Added to the queue" : "Add to queue"}
    >
      <div aria-live="polite" className="flex flex-col gap-3 text-sm">
        {phase.kind === "loading" ? <p>Finding the next free slots…</p> : null}
        {phase.kind === "error" ? <p role="alert">{phase.message}</p> : null}
        {rows.length > 0 ? (
          <>
            <p>
              {phase.kind === "done" ? "Scheduled for" : "Each account takes its next free slot"} · times in {timeZone}
            </p>
            <ul className="flex flex-col gap-2">
              {rows.map((r) => (
                <li key={r.targetId} className="rounded-md border border-foreground/20 p-2">
                  <strong>{names[r.accountId] ?? "Account"}</strong>:{" "}
                  {r.ok && r.scheduledAt ? formatLocal(r.scheduledAt, timeZone) : (r.message ?? "Can't be queued.")}
                  {r.changedFromPreview ? (
                    <p className="mt-1 text-amber-800 dark:text-amber-300">Changed: another post took the previewed slot</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          {phase.kind === "done" ? "Close" : "Cancel"}
        </Button>
        {phase.kind === "preview" ? (
          <Button pending={pending} pendingLabel="Adding…" disabled={!anyQueueable} onClick={() => confirm(phase.rows)}>
            Add to queue
          </Button>
        ) : null}
      </div>
    </Dialog>
  );
}
