import Link from "next/link";
import { buttonStyles } from "./Button";

/** Number of pages for `total` items; at least 1. */
export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/**
 * Previous/next links over a search-param `page`. `hrefFor(page)` builds the URL so filters survive.
 * Renders nothing when everything fits on one page.
 */
export function Pagination({
  page,
  pageSize,
  total,
  hrefFor,
}: {
  page: number;
  pageSize: number;
  total: number;
  hrefFor: (page: number) => string;
}) {
  const pages = pageCount(total, pageSize);
  if (pages <= 1) return null;
  const link = buttonStyles({ variant: "secondary", size: "sm" });
  const off = buttonStyles({ variant: "secondary", size: "sm", className: "opacity-50" });
  return (
    <nav aria-label="Pagination" className="mt-4 flex items-center justify-between gap-3">
      {page > 1 ? (
        <Link href={hrefFor(page - 1)} rel="prev" className={link}>
          Previous
        </Link>
      ) : (
        <span aria-disabled="true" className={off}>
          Previous
        </span>
      )}
      <span className="text-sm text-muted-foreground tabular-nums">
        Page {page} of {pages}
      </span>
      {page < pages ? (
        <Link href={hrefFor(page + 1)} rel="next" className={link}>
          Next
        </Link>
      ) : (
        <span aria-disabled="true" className={off}>
          Next
        </span>
      )}
    </nav>
  );
}
