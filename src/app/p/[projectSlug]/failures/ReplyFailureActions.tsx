"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, ButtonGroup } from "@/components/ui/Button";
import { LiveRegion } from "@/components/ui/LiveRegion";
import { markReplyNotSentAction, markReplySentAction } from "./actions";

/** Both actions are `engagement: ["reply"]` (contracts/services.md §5). */
export function ReplyFailureActions({ slug, draftId }: { slug: string; draftId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState("");

  function markSent() {
    start(async () => {
      const r = await markReplySentAction(slug, { draftId });
      if (!r.ok) return setMessage(`Error: ${r.message}`);
      setMessage("Marked sent.");
      router.refresh();
    });
  }

  function markNotSent() {
    start(async () => {
      const r = await markReplyNotSentAction(slug, { draftId });
      if (!r.ok) return setMessage(`Error: ${r.message}`);
      setMessage("Marked not sent. It's back in Review.");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <ButtonGroup label="Reply decision">
        <Button variant="secondary" onClick={markSent} pending={pending} pendingLabel="Marking…">
          It did arrive
        </Button>
        <Button variant="secondary" onClick={markNotSent} pending={pending} pendingLabel="Marking…">
          It did not arrive
        </Button>
      </ButtonGroup>
      <LiveRegion message={message} />
      {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}
    </div>
  );
}
