"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { useAnnounce } from "@/components/ui/Announce";
import type { RetryAllPreview, RetryAllResult } from "@/server/services/posts";
import { previewRetryAllAction, retryAllFailedAction } from "@/app/p/[projectSlug]/failures/actions";
import {
  UNEXPECTED_ERROR,
  canConfirmAll,
  confirmAllLabel,
  controlRemains,
  previewLines,
  retryAllTitle,
  type RetryAllMode,
} from "./retry-all-ui";

/** Retry every failed post in scope, now or requeued into free slots (FR-016 to FR-020). */
export function RetryAllDialog({
  open,
  onClose,
  onDone,
  slug,
  accountId,
  accountName,
}: {
  open: boolean;
  onClose: () => void;
  onDone: (result: RetryAllResult) => void;
  slug: string;
  accountId: string | null;
  accountName: string | null;
}) {
  const ctx = useAnnounce();
  const [mode, setMode] = useState<RetryAllMode>("now");
  const [preview, setPreview] = useState<RetryAllPreview | "loading" | null>("loading");
  const [previewError, setPreviewError] = useState("");
  const [error, setError] = useState("");
  // Whether the opener survives the refresh; if not, focus goes to the page heading instead.
  const [returnFocus, setReturnFocus] = useState(true);
  const [closedAfterRun, setClosedAfterRun] = useState(false);
  const [pending, start] = useTransition();
  // The preview load has its own transition so it never reads as the confirm button's `pending`.
  const [, startPreview] = useTransition();
  const submitting = useRef(false);

  useEffect(() => {
    if (!open) return;
    startPreview(async () => {
      const res = await previewRetryAllAction(slug, accountId ? { account: accountId } : {});
      if (res.ok) setPreview(res.data);
      else {
        setPreview(null);
        setPreviewError(res.message);
      }
    });
    // Mounted per open (see RetryAllFailed), so state starts fresh: mode "now", no error.
  }, [open, slug, accountId]);

  useEffect(() => {
    // Child effects run first, so the dialog has already closed and its native focus return is done.
    if (closedAfterRun && !open && !returnFocus) ctx?.focusFallback();
  }, [closedAfterRun, open, returnFocus, ctx]);

  function confirm() {
    if (submitting.current) return;
    submitting.current = true;
    setError("");
    start(async () => {
      try {
        const res = await retryAllFailedAction(slug, { ...(accountId ? { account: accountId } : {}), mode });
        if (res.ok) {
          setReturnFocus(controlRemains(res.data));
          setClosedAfterRun(true);
          onDone(res.data);
          ctx?.announce(res.data.message);
          onClose();
        } else {
          setError(res.message);
          ctx?.announce(res.message);
        }
      } catch {
        setError(UNEXPECTED_ERROR);
        ctx?.announce(UNEXPECTED_ERROR);
      } finally {
        submitting.current = false;
      }
    });
  }

  const loaded = typeof preview === "object" && preview !== null ? preview : null;
  const lines = loaded ? previewLines(loaded) : null;

  return (
    <Dialog open={open} onClose={onClose} title={retryAllTitle(accountName)} returnFocus={returnFocus}>
      <div aria-live="polite" className="flex flex-col gap-1 text-sm">
        {preview === "loading" ? <p>Counting failed posts…</p> : null}
        {lines?.counts.map((line) => <p key={line}>{line}</p>)}
        {lines && lines.blocked.length > 0 ? (
          <ul className="list-disc pl-5">
            {lines.blocked.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
        {loaded && loaded.willAttempt === 0 ? (
          <p>None of these posts can be retried until their accounts are fixed.</p>
        ) : null}
      </div>
      <div className="mt-3">
        <SegmentedControl
          name="retry-all-mode"
          label="How should they be retried?"
          layout="cards"
          value={mode}
          onChange={(v) => setMode(v as RetryAllMode)}
          options={[
            {
              value: "now",
              label: "Retry now",
              description: "Each post goes back for the next scheduler pass. Each account's usual spacing still applies.",
            },
            {
              value: "requeue",
              label: "Requeue into next free slots",
              description:
                "Each post takes its account's next free posting slot. Posts meant to go out earlier get earlier slots. Content is checked first.",
            },
          ]}
        />
      </div>
      <p role="alert" className="min-h-4 text-xs text-danger">
        {error || previewError}
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Back
        </Button>
        <Button pending={pending} pendingLabel="Retrying…" disabled={!canConfirmAll(preview)} onClick={confirm}>
          {confirmAllLabel(mode)}
        </Button>
      </div>
    </Dialog>
  );
}
