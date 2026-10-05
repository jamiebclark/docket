"use client";

import { useState } from "react";
import { buttonStyles } from "./Button";
import { controlStyles, labelStyles } from "./controls";

/** Read-only value with a copy button; announces the result through a live region. */
export function CopyField({ id, label, value }: { id: string; label: string; value: string }) {
  const [status, setStatus] = useState("");

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setStatus("Copied to clipboard");
    } catch {
      setStatus("Copy failed. Select the text and copy it manually.");
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className={labelStyles}>
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className={`${controlStyles} min-w-0 flex-1 font-mono`}
        />
        <button
          type="button"
          onClick={copy}
          className={buttonStyles({ variant: "secondary" })}
        >
          Copy
        </button>
      </div>
      <p role="status" aria-live="polite" className="min-h-4 text-xs text-muted-foreground">
        {status}
      </p>
    </div>
  );
}
