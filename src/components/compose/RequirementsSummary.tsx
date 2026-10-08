"use client";

import { useEffect, useRef, useState } from "react";
import type { RequirementsSummary as Summary } from "@/providers/requirements";
import { carouselLine, detailRows, summaryLine, videoLine } from "./requirements-ui";

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
  const label = requirements?.video.postType?.label ?? "";
  // Empty at first render; announces only when the shown type changes after mount.
  const [announced, setAnnounced] = useState("");
  const previous = useRef(label);
  useEffect(() => {
    if (previous.current === label) return;
    previous.current = label;
    setAnnounced(label ? `Showing requirements for ${label}` : "");
  }, [label]);
  if (!requirements) return null;
  return (
    <>
      <p aria-live="polite" className="sr-only">
        {announced}
      </p>
    <div className="mt-2 text-xs text-muted-foreground" data-testid="requirements-summary" aria-live="off">
      <p>{summaryLine(requirements)}</p>
      <p>{videoLine(requirements)}</p>
      {carouselLine(requirements) && <p>{carouselLine(requirements)}</p>}
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
    </>
  );
}
