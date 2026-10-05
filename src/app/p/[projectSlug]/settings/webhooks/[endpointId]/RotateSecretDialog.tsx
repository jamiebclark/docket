"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { ShowOnceDialog } from "@/components/ui/ShowOnceDialog";
import { rotateSecretAction } from "../actions";

export function RotateSecretDialog({ slug, id, onDone }: { slug: string; id: string; onDone: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  function rotate() {
    start(async () => {
      const result = await rotateSecretAction(slug, id);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setOpen(false);
      setSecret(result.data.secret);
    });
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Rotate secret…
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Rotate the signing secret?">
        <p className="mb-4 text-sm">
          A new secret is created now. For the next 24 hours deliveries are signed with both the new and the old secret, so you can
          update the receiver without missing events.
        </p>
        {error ? (
          <p role="alert" className="mb-2 text-sm text-danger">
            {error}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button pending={pending} pendingLabel="Rotating…" onClick={rotate}>
            Rotate secret
          </Button>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </Dialog>
      <ShowOnceDialog
        open={secret !== null}
        onClose={() => {
          setSecret(null);
          onDone("Rotated the signing secret.");
        }}
        title="Copy the signing secret"
        fieldLabel="Signing secret"
        value={secret ?? ""}
        closeLabel="I have stored this secret"
      />
    </>
  );
}
