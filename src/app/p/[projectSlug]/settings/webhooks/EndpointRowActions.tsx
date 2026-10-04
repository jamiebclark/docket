"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { deleteEndpointAction, setEndpointEnabledAction } from "./actions";

export function EndpointRowActions({
  slug,
  id,
  host,
  enabled,
  onDone,
  onDeleted,
}: {
  slug: string;
  id: string;
  host: string;
  enabled: boolean;
  onDone: (message: string) => void;
  /** Where to go after a delete when this is rendered on the endpoint's own page. */
  onDeleted?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggle() {
    start(async () => {
      const result = await setEndpointEnabledAction(slug, id, !enabled);
      onDone(result.ok ? (enabled ? `Disabled the webhook to ${host}.` : `Enabled the webhook to ${host}.`) : result.message);
    });
  }

  function remove() {
    start(async () => {
      const result = await deleteEndpointAction(slug, id);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setOpen(false);
      onDone(`Deleted the webhook to ${host}.`);
      onDeleted?.();
    });
  }

  return (
    <div className="flex gap-2">
      <Button variant="secondary" onClick={toggle} pending={pending && !open} aria-label={`${enabled ? "Disable" : "Enable"} the webhook to ${host}`}>
        {enabled ? "Disable" : "Enable"}
      </Button>
      <Button variant="danger" onClick={() => setOpen(true)} aria-label={`Delete the webhook to ${host}`}>
        Delete…
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Delete the webhook to ${host}?`}>
        <p className="mb-4 text-sm">Its delivery log is deleted too.</p>
        {error ? (
          <p role="alert" className="mb-2 text-sm text-red-700 dark:text-red-400">
            {error}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button variant="danger" pending={pending} pendingLabel="Deleting…" onClick={remove}>
            Delete webhook
          </Button>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
