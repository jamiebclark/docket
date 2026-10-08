import Link from "next/link";
import { buttonStyles } from "./Button";

/**
 * Newer/Older links over opaque cursors. `newerHref` / `olderHref` are `null` when that direction has
 * nothing more, which renders a disabled span. Renders nothing when both are missing.
 */
export function CursorPagination({ newerHref, olderHref }: { newerHref: string | null; olderHref: string | null }) {
  if (!newerHref && !olderHref) return null;
  const link = buttonStyles({ variant: "secondary", size: "sm" });
  const off = buttonStyles({ variant: "secondary", size: "sm", className: "opacity-50" });
  return (
    <nav aria-label="Pagination" className="mt-4 flex items-center justify-between gap-3">
      {newerHref ? (
        <Link href={newerHref} rel="prev" className={link}>
          Newer
        </Link>
      ) : (
        <span aria-disabled="true" className={off}>
          Newer
        </span>
      )}
      {olderHref ? (
        <Link href={olderHref} rel="next" className={link}>
          Older
        </Link>
      ) : (
        <span aria-disabled="true" className={off}>
          Older
        </span>
      )}
    </nav>
  );
}
