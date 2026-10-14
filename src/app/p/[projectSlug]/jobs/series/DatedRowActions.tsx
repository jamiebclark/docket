"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { deleteDatedRowAction } from "./actions";
import { DatedRowDialog, type DatedRowValue } from "./DatedRowDialog";

/** Edit / Delete for one row, with a row-naming confirmation `Dialog` for delete (ui.md §7). */
export function DatedRowActions({
  slug,
  seriesId,
  templateFields,
  row,
  label,
}: {
  slug: string;
  seriesId: string;
  templateFields: readonly string[];
  row: DatedRowValue;
  label: string;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [pending, start] = useTransition();

  function runDelete() {
    setDeleteError("");
    start(async () => {
      const res = await deleteDatedRowAction(slug, seriesId, row.id);
      if (!res.ok) setDeleteError(res.message);
      else setDeleteOpen(false);
    });
  }

  return (
    <div className="flex items-center gap-2">
      <Button variant="secondary" size="sm" onClick={() => setEditOpen(true)}>
        Edit
      </Button>
      <Button variant="secondary" size="sm" onClick={() => setDeleteOpen(true)}>
        Delete
      </Button>
      <DatedRowDialog slug={slug} seriesId={seriesId} templateFields={templateFields} open={editOpen} onClose={() => setEditOpen(false)} row={row} />
      <Dialog open={deleteOpen} onClose={() => setDeleteOpen(false)} title={`Delete ${label}?`}>
        <p className="mb-3 text-sm">Its posting history goes with it. Posts it already produced are kept.</p>
        {deleteError ? (
          <p role="alert" className="mb-2 text-sm text-danger">
            {deleteError}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setDeleteOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={runDelete} pending={pending} pendingLabel="Deleting…">
            Delete
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
