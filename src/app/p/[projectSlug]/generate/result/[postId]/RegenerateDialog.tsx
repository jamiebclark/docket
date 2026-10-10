"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { INSTRUCTIONS_MAX } from "@/lib/validation/generation";
import { regenerateAction } from "../../actions";
import { counterLabel } from "../../generate-logic";
import { TextareaField } from "@/components/ui/TextareaField";

export function RegenerateDialog({ slug, postId }: { slug: string; postId: string }) {
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [error, setError] = useState("");
  const [pending, start] = useTransition();

  function run() {
    setError("");
    start(async () => {
      const r = await regenerateAction(slug, { postId, instruction: instruction.trim() || null });
      if (!r.ok) return setError(r.message);
      if (!r.data.ok) return setError(r.data.message);
      setOpen(false);
      setInstruction("");
      router.refresh();
    });
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Regenerate…
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Regenerate this post">
        <p className="mb-3 text-sm">The text is written again from the same brief. Your edits to the text will be replaced.</p>
        <TextareaField
          id={id}
          label="Extra instruction (optional)"
          minRows={3}
          maxRows={12}
          mono
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          counter={counterLabel(instruction.length, INSTRUCTIONS_MAX)}
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
          <Button onClick={run} pending={pending} pendingLabel="Regenerating…" disabled={instruction.length > INSTRUCTIONS_MAX}>
            Regenerate
          </Button>
        </div>
      </Dialog>
    </>
  );
}
