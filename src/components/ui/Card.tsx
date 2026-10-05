import type { HTMLAttributes, ReactNode } from "react";

/** Class string for a card surface, for elements that cannot be a `<Card>` (e.g. a `<form>` or `<fieldset>`). */
export const cardStyles = "rounded-xl border border-border bg-surface shadow-card";

/**
 * White surface with a hairline border and soft shadow; groups one topic on a page.
 * `title` renders an `<h2>` header row with optional `actions`; `as` picks the element.
 */
export function Card({
  title,
  description,
  actions,
  as: Tag = "section",
  padded = true,
  className = "",
  children,
  ...rest
}: Omit<HTMLAttributes<HTMLElement>, "title"> & {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  as?: "section" | "div" | "article" | "aside";
  padded?: boolean;
}) {
  return (
    <Tag className={`${cardStyles} ${className}`} {...rest}>
      {title ? (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-base font-semibold text-heading">{title}</h2>
            {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
          </div>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={padded ? "p-5" : ""}>{children}</div>
    </Tag>
  );
}
