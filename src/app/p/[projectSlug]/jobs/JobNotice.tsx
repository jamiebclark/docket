import type { ReactNode } from "react";

/**
 * The shape the job page's existing notices use: a `role="note"` paragraph with a warning border.
 * Deliberately not `Alert`, whose `warning` tone defaults to `role="alert"` and would be announced more
 * aggressively than today's notices (FR-026).
 */
export function JobNotice({ children }: { children: ReactNode }) {
  return <p role="note" className="rounded-md border border-warning-border p-3 text-sm">{children}</p>;
}
