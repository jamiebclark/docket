import Link from "next/link";
import { LogoMark } from "@/components/brand/Logo";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { InvitationBadge } from "@/components/shell/InvitationBadge";
import { UserMenu } from "@/components/shell/UserMenu";
import { signOut } from "@/components/shell/actions";
import * as invitations from "@/server/services/invitations";

/**
 * The signed-in header shared by the project shell and the pages outside it: the Docket mark (home),
 * invitations link with its pending count, and the user menu with sign-out. `left` holds anything
 * shell-specific (the project switcher).
 */
export async function SignedInHeader({
  user,
  left,
}: {
  user: { id: string; email: string; name: string };
  left?: React.ReactNode;
}) {
  const pending = await invitations.countMine({ user: { id: user.id, email: user.email } });
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-4 border-b border-border bg-surface/90 px-3 backdrop-blur supports-[backdrop-filter]:bg-surface/75 sm:px-4">
      <div className="flex min-w-0 items-center gap-3">
        <Link href="/" className="flex shrink-0 items-center gap-2 rounded-lg p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
          <LogoMark size={30} />
          <span className="hidden font-heading text-lg font-bold tracking-tight text-heading sm:inline">Docket</span>
          <span className="sr-only sm:hidden">Docket home</span>
        </Link>
        {left ? (
          <>
            <span aria-hidden="true" className="hidden h-6 w-px bg-border sm:block" />
            <div className="min-w-0">{left}</div>
          </>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1 sm:gap-2">
        <InvitationBadge count={pending} />
        <NotificationBell />
        <UserMenu name={user.name} signOut={signOut} />
      </div>
    </header>
  );
}
