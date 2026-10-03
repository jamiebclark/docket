import Link from "next/link";

/** Link to /invitations with a pending-count badge; the badge is hidden when `count` is 0. */
export function InvitationBadge({ count }: { count: number }) {
  return (
    <Link href="/invitations" className="rounded px-2 py-1 text-sm hover:bg-foreground/10 focus-visible:ring-2">
      Invitations
      {count > 0 && (
        <span className="ml-1 rounded-full bg-foreground px-2 py-0.5 text-xs text-background">
          {count}
          <span className="sr-only"> pending</span>
        </span>
      )}
    </Link>
  );
}
