import Link from "next/link";
import { Icon } from "@/components/ui/Icon";

/** Link to /invitations with a pending-count badge; the badge is hidden when `count` is 0. */
export function InvitationBadge({ count }: { count: number }) {
  return (
    <Link
      href="/invitations"
      className="inline-flex h-9 items-center gap-2 rounded-lg px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <Icon name="inbox" />
      <span className="hidden sm:inline">Invitations</span>
      <span className="sr-only sm:hidden">Invitations</span>
      {count > 0 && (
        <span className="rounded-full bg-cta px-1.5 py-0.5 text-xs font-semibold text-cta-foreground tabular-nums">
          {count}
          <span className="sr-only"> pending</span>
        </span>
      )}
    </Link>
  );
}
