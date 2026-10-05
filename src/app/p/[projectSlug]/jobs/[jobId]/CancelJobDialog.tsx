"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { cancelJobAction } from "../actions";

export function CancelJobDialog({ slug, jobId, summary }: { slug: string; jobId: string; summary: string }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();

  function run() {
    setError("");
    start(async () => {
      const r = await cancelJobAction(slug, { jobId });
      if (!r.ok) return setError(r.message);
      setOpen(false);
    });
  }

  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)}>
        Cancel job
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Cancel job “${summary}”?`}>
        <p className="mb-3 text-sm">
          Items not yet generated will not be generated, and their images become unused again. Posts already made are kept.
        </p>
        {error ? (
          <p role="alert" className="mb-2 text-sm text-danger">
            Error: {error}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
            Keep running
          </Button>
          <Button variant="danger" onClick={run} pending={pending} pendingLabel="Cancelling…">
            Cancel job
          </Button>
        </div>
      </Dialog>
    </>
  );
}
