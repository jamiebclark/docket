"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { DatedRowDialog } from "./DatedRowDialog";

/** The "Add a row" control beside the Import button (ui.md §3.4). */
export function AddDatedRowButton({ slug, seriesId, templateFields }: { slug: string; seriesId: string; templateFields: readonly string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Add a row
      </Button>
      <DatedRowDialog slug={slug} seriesId={seriesId} templateFields={templateFields} open={open} onClose={() => setOpen(false)} row={null} />
    </>
  );
}
