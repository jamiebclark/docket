import type { ReactNode } from "react";

/**
 * Page title row: the route's single `<h1>`, an optional one-line `description`, and `actions`
 * (the page's primary action goes last, so it sits rightmost). Stacks on narrow screens.
 */
export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  titleId,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
  /** Gives the `<h1>` an id and makes it programmatically focusable, as a focus fallback after a dialog closes. */
  titleId?: string;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        {eyebrow ? <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{eyebrow}</div> : null}
        <h1 id={titleId} tabIndex={titleId ? -1 : undefined} className="text-2xl font-semibold sm:text-[1.75rem]">{title}</h1>
        {description ? <p className="max-w-2xl text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
