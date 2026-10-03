"use client";

import { useState } from "react";

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
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 rounded-md border border-foreground/40 bg-background px-3 py-1.5 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground"
        />
        <button
          type="button"
          onClick={copy}
          className="rounded-md border border-foreground/30 px-3 py-1.5 text-sm font-medium hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground"
        >
          Copy
        </button>
      </div>
      <p role="status" aria-live="polite" className="min-h-4 text-xs">
        {status}
      </p>
    </div>
  );
}
