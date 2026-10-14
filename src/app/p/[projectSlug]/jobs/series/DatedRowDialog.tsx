"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { addDatedRowAction, updateDatedRowAction } from "./actions";

export interface DatedRowValue {
  id: string;
  date: string;
  media: string | null;
  fields: Record<string, string>;
}

type FormProps = {
  slug: string;
  seriesId: string;
  templateFields: readonly string[];
  row: DatedRowValue | null;
  onClose: () => void;
};

/** Keyed by the dialog's open state and the row's id, so each opening starts from fresh field state
 *  without an effect (React's "reset state with a key" pattern). */
function DatedRowForm({ slug, seriesId, templateFields, row, onClose }: FormProps) {
  const [date, setDate] = useState(row?.date ?? "");
  const [media, setMedia] = useState(row?.media ?? "");
  const [fields, setFields] = useState<Record<string, string>>(row?.fields ?? Object.fromEntries(templateFields.map((f) => [f, ""])));
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();

  function submit() {
    setError("");
    setFieldErrors({});
    start(async () => {
      const input = { date, media: media.trim() === "" ? null : media, fields };
      const res = row ? await updateDatedRowAction(slug, seriesId, row.id, input) : await addDatedRowAction(slug, seriesId, input);
      if (!res.ok) {
        if (res.fieldErrors) setFieldErrors(res.fieldErrors);
        else setError(res.message);
        return;
      }
      onClose();
    });
  }

  return (
    <>
      <fieldset className="flex flex-col gap-3">
        <legend className="sr-only">Row details</legend>
        <Field
          id="dated-row-date"
          label="Date"
          hint="MM-DD for every year, or YYYY-MM-DD for one year only"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          error={fieldErrors.date}
        />
        {templateFields.map((f) => (
          <Field
            key={f}
            id={`dated-row-field-${f}`}
            label={f}
            value={fields[f] ?? ""}
            onChange={(e) => setFields((prev) => ({ ...prev, [f]: e.target.value }))}
            error={fieldErrors[f]}
          />
        ))}
        <Field
          id="dated-row-media"
          label="Image"
          hint="The filename of an image already in the library. Leave blank to use the series' own image source."
          value={media}
          onChange={(e) => setMedia(e.target.value)}
          error={fieldErrors.media}
        />
      </fieldset>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button onClick={submit} pending={pending} pendingLabel="Saving…">
          Save
        </Button>
      </div>
    </>
  );
}

/** Add/edit one row's date, fields and image in a `Dialog`, with the import's own validation and messages
 *  attached to the field rather than a line (ui.md §7, A22, FR-028). */
export function DatedRowDialog({
  slug,
  seriesId,
  templateFields,
  open,
  onClose,
  row,
}: {
  slug: string;
  seriesId: string;
  templateFields: readonly string[];
  open: boolean;
  onClose: () => void;
  row: DatedRowValue | null;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={row ? "Edit row" : "Add a row"} dismissOnBackdrop={false}>
      {open ? (
        <DatedRowForm key={row?.id ?? "new"} slug={slug} seriesId={seriesId} templateFields={templateFields} row={row} onClose={onClose} />
      ) : null}
    </Dialog>
  );
}
