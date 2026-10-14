"use client";

import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { CsvProblemList } from "@/components/ui/CsvProblemList";
import { Dialog } from "@/components/ui/Dialog";
import { LiveRegion } from "@/components/ui/LiveRegion";
import { importDatedListAction } from "./actions";

/** The file input, the replace-confirmation `Dialog`, and the pending/refusal/success states (ui.md §6). */
export function DatedListImport({ slug, seriesId }: { slug: string; seriesId: string }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [refusal, setRefusal] = useState<{ line: number | null; message: string }[] | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pending, start] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  function onChoose(next: File | null) {
    setFile(next);
    setRefusal(null);
    setError("");
    if (next) setOpen(true);
  }

  function runImport() {
    if (!file) return;
    setError("");
    setRefusal(null);
    start(async () => {
      const body = new FormData();
      body.set("file", file);
      const res = await importDatedListAction(slug, seriesId, body);
      if (!res.ok) {
        if (res.error === "validation" && Array.isArray(res.issues)) setRefusal(res.issues.map((i) => ({ line: null, message: i.message })));
        else setError(res.message);
        return;
      }
      setOpen(false);
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      setMessage(
        res.data.problems.length > 0
          ? `${res.data.rowCount} rows imported, ${res.data.problems.length} could not be used.`
          : `${res.data.rowCount} rows imported.`,
      );
    });
  }

  return (
    <div>
      <label htmlFor="dated-list-file" className="block text-sm font-medium">
        Import a list
      </label>
      <input
        ref={inputRef}
        id="dated-list-file"
        type="file"
        accept=".csv,text/csv"
        aria-describedby="dated-list-file-hint"
        className="mt-1.5 block w-full text-sm text-muted-foreground file:mr-3 file:cursor-pointer file:rounded-lg file:border file:border-primary/60 file:bg-surface file:px-4 file:py-2 file:text-sm file:font-medium file:text-primary hover:file:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        onChange={(e) => onChoose(e.target.files?.[0] ?? null)}
      />
      <p id="dated-list-file-hint" className="mt-1 text-sm text-muted-foreground">
        The first row names the columns. <code>date</code> is required, <code>media</code> is optional, every other column becomes a
        field. Up to 500 rows and 1 MB.
      </p>
      <LiveRegion message={message} />
      <Dialog open={open} onClose={() => setOpen(false)} title="Replace the list?">
        <p className="mb-3 text-sm">
          Importing replaces the whole list. Rows that are still in the file keep their history; rows that are gone are removed.
        </p>
        {error ? (
          <p role="alert" className="mb-2 text-sm text-danger">
            {error}
          </p>
        ) : null}
        {refusal ? <CsvProblemList problems={refusal} /> : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={runImport} pending={pending} pendingLabel="Importing…">
            Import
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
