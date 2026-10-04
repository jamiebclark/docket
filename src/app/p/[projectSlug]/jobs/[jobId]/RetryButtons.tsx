"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { LiveRegion } from "@/components/ui/LiveRegion";
import { retryFailedAction, retryItemAction } from "../actions";

/** Retry one failed item (`itemId`) or every failed item of the job (`count`). */
export function RetryButton({ slug, jobId, itemId, count }: { slug: string; jobId: string; itemId?: string; count?: number }) {
  const [message, setMessage] = useState("");
  const [pending, start] = useTransition();
  const all = itemId === undefined;

  function run() {
    setMessage("");
    start(async () => {
      const r = all ? await retryFailedAction(slug, { jobId }) : await retryItemAction(slug, { jobId, itemId });
      setMessage(r.ok ? r.data.message : r.message);
    });
  }

  return (
    <>
      <Button variant="secondary" onClick={run} pending={pending} pendingLabel="Retrying…">
        {all ? `Retry all failed (${count ?? 0})` : "Retry"}
      </Button>
      <LiveRegion message={message} />
    </>
  );
}
