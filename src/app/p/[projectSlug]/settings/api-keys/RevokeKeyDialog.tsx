"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { revokeApiKeyAction } from "./actions";

export function RevokeKeyDialog({
  slug,
  id,
  name,
  onDone,
}: {
  slug: string;
  id: string;
  name: string;
  onDone: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function revoke() {
    start(async () => {
      const result = await revokeApiKeyAction(slug, id);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setOpen(false);
      onDone(result.data.revoked ? `Revoked the key "${name}".` : (result.data.message ?? "This key was already revoked."));
    });
  }

  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)} aria-label={`Revoke the key ${name}`}>
        Revoke…
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Revoke the key "${name}"?`}>
        <p className="mb-4 text-sm">Anything using it stops working on its next request. This cannot be undone.</p>
        {error ? (
          <p role="alert" className="mb-2 text-sm text-red-700 dark:text-red-400">
            {error}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button variant="danger" pending={pending} pendingLabel="Revoking…" onClick={revoke}>
            Revoke key
          </Button>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </Dialog>
    </>
  );
}
