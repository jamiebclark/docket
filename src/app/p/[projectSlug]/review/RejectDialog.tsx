"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { counterLabel } from "../generate/generate-logic";
import { rejectAction } from "./actions";
import { REJECT_NAME_MAX, truncate } from "./review-logic";
import { TextareaField } from "@/components/ui/TextareaField";

export const REJECT_REASON_MAX = 500;

export function RejectDialog({ slug, postId, text }: { slug: string; postId: string; text: string }) {
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [pending, start] = useTransition();

  function run() {
    setError("");
    start(async () => {
      const r = await rejectAction(slug, { postId, reason: reason.trim() || null });
      if (!r.ok) return setError(r.message);
      if (!r.data.ok) return setError(r.data.message);
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Reject…
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Reject this post">
        <p className="mb-3 text-sm">
          Reject “{truncate(text, REJECT_NAME_MAX)}”? It stays in Posts as rejected and will not be scheduled.
        </p>
        <TextareaField
          id={id}
          label="Reason (optional)"
          minRows={3}
          maxRows={10}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          counter={counterLabel(reason.length, REJECT_REASON_MAX)}
        />
        {error ? (
          <p role="alert" className="mt-2 text-sm text-danger">
            Error: {error}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={run}
            pending={pending}
            pendingLabel="Rejecting…"
            disabled={reason.length > REJECT_REASON_MAX}
          >
            Reject post
          </Button>
        </div>
      </Dialog>
    </>
  );
}
