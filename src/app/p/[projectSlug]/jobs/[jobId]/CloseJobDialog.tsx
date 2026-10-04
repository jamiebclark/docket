"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { closeJobAction } from "../actions";

export function CloseJobDialog({ slug, jobId, summary }: { slug: string; jobId: string; summary: string }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();

  function run() {
    setError("");
    start(async () => {
      const r = await closeJobAction(slug, { jobId });
      if (!r.ok) return setError(r.message);
      setOpen(false);
    });
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Close job
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Close the job “${summary}”?`}>
        <p className="mb-3 text-sm">No more items can be added. It finishes once every item is done.</p>
        {error ? (
          <p role="alert" className="mb-2 text-sm text-red-700 dark:text-red-400">
            Error: {error}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
            Keep open
          </Button>
          <Button onClick={run} pending={pending} pendingLabel="Closing…">
            Close job
          </Button>
        </div>
      </Dialog>
    </>
  );
}
