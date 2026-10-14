"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Button, buttonStyles } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { LiveRegion } from "@/components/ui/LiveRegion";
import { formatLocal } from "@/components/ui/LocalTime";
import { pauseStandingSeriesAction, resumeStandingSeriesAction, deleteStandingSeriesAction } from "./actions";

/**
 * Pause/resume as one-button forms (mutually exclusive — one control whose label is the verb that
 * applies) and delete via a confirming `Dialog` that names the series (ui.md §5, FR-062).
 */
export function SeriesRowActions({
  slug,
  seriesId,
  name,
  enabled,
  postCount,
  timezone,
  canManage,
}: {
  slug: string;
  seriesId: string;
  name: string;
  enabled: boolean;
  postCount: number;
  timezone: string;
  canManage: boolean;
}) {
  const [message, setMessage] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [pending, start] = useTransition();
  const [deletePending, startDelete] = useTransition();

  function toggle() {
    setMessage("");
    start(async () => {
      if (enabled) {
        const r = await pauseStandingSeriesAction(slug, seriesId);
        setMessage(r.ok ? "Paused." : r.message);
      } else {
        const r = await resumeStandingSeriesAction(slug, seriesId);
        setMessage(r.ok ? `Resumed. Next due ${formatLocal(r.data.nextRunAt, timezone)}.` : r.message);
      }
    });
  }

  function runDelete() {
    setDeleteError("");
    startDelete(async () => {
      const r = await deleteStandingSeriesAction(slug, seriesId);
      if (!r.ok) setDeleteError(r.message);
    });
  }

  if (!canManage) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="secondary" size="sm" onClick={toggle} pending={pending} pendingLabel={enabled ? "Pausing…" : "Resuming…"}>
        {enabled ? "Pause" : "Resume"}
      </Button>
      <Link href={`/p/${slug}/jobs/series/${seriesId}/edit`} className={buttonStyles({ variant: "secondary", size: "sm" })}>
        Edit
      </Link>
      <Button variant="secondary" size="sm" onClick={() => setDeleteOpen(true)}>
        Delete
      </Button>
      <LiveRegion message={message} />
      <Dialog open={deleteOpen} onClose={() => setDeleteOpen(false)} title={`Delete "${name}"?`}>
        <p className="mb-3 text-sm">
          Its run history goes with it. The {postCount} post{postCount === 1 ? "" : "s"} it has already produced stay in this
          project. This cannot be undone.
        </p>
        {deleteError ? (
          <p role="alert" className="mb-2 text-sm text-danger">
            Error: {deleteError}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setDeleteOpen(false)} disabled={deletePending}>
            Cancel
          </Button>
          <Button onClick={runDelete} pending={deletePending} pendingLabel="Deleting…">
            Delete
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
