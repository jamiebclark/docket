"use client";

import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { explicitTimeText } from "@/components/schedule/explicit-time-text";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { useAnnounce } from "@/components/ui/Announce";
import type { RequeuePreview } from "@/server/services/failures";
import type { ExplicitTimePreview, RetryResult } from "@/server/services/posts";
import { previewExplicitTimeAction } from "@/app/p/[projectSlug]/compose/actions";
import { previewRequeueAction, retryTargetAction } from "@/app/p/[projectSlug]/posts/actions";
import { canConfirm, confirmLabel, retryAnnouncement, type RetryMode } from "./retry-ui";

/** Retry a failed target now, in the next free slot, or at a picked time (FR-015). */
export function RetryDialog({
  open,
  onClose,
  onDone,
  slug,
  targetId,
  accountId,
  accountName,
  timeZone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: (result: Extract<RetryResult, { status: "scheduled" }>) => void;
  slug: string;
  targetId: string;
  accountId: string;
  accountName: string;
  timeZone: string;
}) {
  const ctx = useAnnounce();
  const [mode, setMode] = useState<RetryMode>("now");
  const [preview, setPreview] = useState<RequeuePreview | "loading" | null>("loading");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [fetched, setFetched] = useState<ExplicitTimePreview | null>(null);
  const timePreview = date && time ? fetched : null;
  const [error, setError] = useState("");
  const [pending, start] = useTransition();

  function loadPreview() {
    start(async () => {
      const res = await previewRequeueAction(slug, { targetId });
      setPreview(res.ok ? res.data : { ok: false, code: "account_unavailable", message: res.message });
    });
  }

  useEffect(() => {
    if (!open) return;
    loadPreview();
    // Mounted per open (see TargetResolution), so state starts fresh: mode "now", no error.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, targetId]);

  useEffect(() => {
    if (!open || mode !== "at" || !date || !time) return;
    let live = true;
    previewExplicitTimeAction(slug, { local: `${date}T${time}`, accountIds: [accountId] }).then((res) => {
      if (!live) return;
      if (res.ok) {
        setFetched(res.data);
        setError("");
      } else {
        setFetched(null);
        setError(res.message);
      }
    });
    return () => {
      live = false;
    };
  }, [open, mode, slug, accountId, date, time]);

  const loading = preview === "loading" || preview === null;
  const requeueDescription = loading
    ? "Finding the next free slot…"
    : preview.ok
      ? `${preview.localTime} — the next free slot for ${accountName}.`
      : preview.message;

  function confirm() {
    setError("");
    start(async () => {
      const input =
        mode === "now"
          ? { targetId }
          : mode === "requeue"
            ? { targetId, mode: "requeue" as const, expected: typeof preview === "object" && preview?.ok ? preview.scheduledAt : undefined }
            : { targetId, mode: "at" as const, at: timePreview?.instant ?? "" };
      const res = await retryTargetAction(slug, input);
      if (res.ok && res.data.status === "scheduled") {
        onClose();
        ctx?.announce(retryAnnouncement(res.data));
        onDone(res.data);
        ctx?.restoreFocus();
        return;
      }
      const message = res.ok ? (res.data as Extract<RetryResult, { status: "failed" }>).message : res.message;
      setError(message);
      ctx?.announce(message);
      if (res.ok && mode === "requeue") {
        setPreview("loading");
        loadPreview();
      }
    });
  }

  return (
    <Dialog open={open} onClose={onClose} title={`Retry the post to ${accountName}`}>
      <SegmentedControl
        name={`retry-mode-${targetId}`}
        label="When should it go out?"
        layout="cards"
        value={mode}
        onChange={(v) => setMode(v as RetryMode)}
        options={[
          { value: "now", label: "Now", description: "Tries again on the next scheduler pass." },
          {
            value: "requeue",
            label: "Next free slot",
            description: requeueDescription,
            disabled: loading || !preview.ok,
          },
          { value: "at", label: "Pick a time", description: `Choose a date and time in ${timeZone}.` },
        ]}
      />
      {mode === "at" ? (
        <div className="mt-3 flex flex-col gap-3 text-sm">
          <Field id={`retry-date-${targetId}`} label={`Date (${timeZone})`} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <Field id={`retry-time-${targetId}`} label={`Time (${timeZone})`} type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          <div aria-live="polite" className="flex flex-col gap-1">
            {timePreview?.inPast ? <p role="alert">That time has passed. Pick a later time, or use Retry now.</p> : null}
            {timePreview && !timePreview.inPast ? <p>{explicitTimeText(timePreview, timeZone)}</p> : null}
            {timePreview?.warnings.map((w, n) => (
              <p key={n} className="text-warning">
                {w.message}
              </p>
            ))}
          </div>
        </div>
      ) : null}
      <p role="alert" className="min-h-4 text-xs text-danger">
        {error}
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Back
        </Button>
        <Button pending={pending} pendingLabel="Retrying…" disabled={!canConfirm(mode, preview, timePreview)} onClick={confirm}>
          {confirmLabel(mode)}
        </Button>
      </div>
    </Dialog>
  );
}
