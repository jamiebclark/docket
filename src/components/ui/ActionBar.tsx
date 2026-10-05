import type { ReactNode } from "react";
import { cardStyles } from "./Card";

/**
 * The commit row of a long form or a selection: actions right-aligned (primary last), an optional
 * status message on the left. It floats at the bottom (`edge="bottom"`) or just under the app
 * header (`edge="top"`) while the content scrolls, so the main action is always in reach.
 * `stickyFrom="md"` keeps it in the page flow on phones, where a floating bar would cover the form.
 */
export function ActionBar({
  children,
  message,
  label,
  edge = "bottom",
  stickyFrom = "always",
}: {
  children: ReactNode;
  message?: ReactNode;
  /** Names the bar as a region for screen readers (e.g. "Bulk actions"). */
  label?: string;
  edge?: "top" | "bottom";
  stickyFrom?: "always" | "md";
}) {
  const position =
    edge === "bottom"
      ? stickyFrom === "md"
        ? "md:sticky md:bottom-4"
        : "sticky bottom-4"
      : stickyFrom === "md"
        ? "md:sticky md:top-[calc(var(--sticky-top)+0.5rem)]"
        : "sticky top-[calc(var(--sticky-top)+0.5rem)]";
  return (
    <div
      role={label ? "region" : undefined}
      aria-label={label}
      className={`${cardStyles} ${position} z-20 flex flex-wrap items-center justify-end gap-2 px-4 py-3`}
    >
      {message ? <div className="mr-auto text-sm text-muted-foreground">{message}</div> : null}
      {children}
    </div>
  );
}
