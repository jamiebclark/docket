"use client";

import { Button } from "./Button";
import { CopyField } from "./CopyField";
import { Dialog } from "./Dialog";

/**
 * Shows a secret exactly once (API key, signing secret). The value lives only in the caller's state and is
 * dropped when the caller closes the dialog; it is never put in a URL, cookie or the rendered list.
 */
export function ShowOnceDialog({
  open,
  onClose,
  title,
  value,
  fieldLabel,
  closeLabel,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  value: string;
  fieldLabel: string;
  closeLabel: string;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <div className="flex flex-col gap-3">
        <CopyField id="show-once-value" label={fieldLabel} value={value} />
        <p className="text-sm">
          This is the only time it is shown. Store it somewhere safe, such as an n8n credential.
        </p>
        <Button className="self-end" onClick={onClose}>
          {closeLabel}
        </Button>
      </div>
    </Dialog>
  );
}
