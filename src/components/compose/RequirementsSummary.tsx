"use client";

import { useState } from "react";
import type { RequirementsSummary as Summary } from "@/providers/requirements";
import { detailRows, summaryLine } from "./requirements-ui";

/**
 * What one account accepts: a one-line gist and a `<details>` with every rule. Every value comes from the
 * check's `requirements`; nothing is hardcoded here. `openInitially` is read once, so the person controls it after.
 */
export function RequirementsSummary({
  providerName,
  requirements,
  openInitially = false,
}: {
  providerName: string;
  requirements: Summary | null;
  openInitially?: boolean;
}) {
  const [open, setOpen] = useState(openInitially);
  if (!requirements) return null;
  return (
    <div className="mt-2 text-xs text-muted-foreground" data-testid="requirements-summary" aria-live="off">
      <p>{summaryLine(requirements)}</p>
      <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="mt-1">
        <summary className="cursor-pointer font-medium text-foreground">What {providerName} accepts</summary>
        <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
          {detailRows(requirements).map((row) => (
            <div key={row.term} className="contents">
              <dt className="font-medium">{row.term}</dt>
              <dd>{row.detail}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}
