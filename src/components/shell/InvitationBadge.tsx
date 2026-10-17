import Link from "next/link";
import { iconControlStyles } from "@/components/ui/controls";
import { Icon } from "@/components/ui/Icon";

/** Link to /invitations with a pending-count badge; the badge is hidden when `count` is 0. */
export function InvitationBadge({ count }: { count: number }) {
  return (
    <Link href="/invitations" title="Invitations" className={iconControlStyles}>
      <Icon name="inbox" />
      <span className="sr-only">Invitations</span>
      {count > 0 && (
        <span className="rounded-full bg-cta px-1.5 py-0.5 text-xs font-semibold text-cta-foreground tabular-nums">
          {count}
          <span className="sr-only"> pending</span>
        </span>
      )}
    </Link>
  );
}
