import { InvitationBadge } from "@/components/shell/InvitationBadge";
import { UserMenu } from "@/components/shell/UserMenu";
import { signOut } from "@/components/shell/actions";
import * as invitations from "@/server/services/invitations";

/**
 * The signed-in header shared by the project shell and the pages outside it: invitations link with
 * its pending count, and the user menu with sign-out. `left` holds anything shell-specific
 * (the project switcher).
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
    <header className="flex items-center justify-between gap-4 border-b border-foreground/20 px-4 py-2">
      <div>{left}</div>
      <div className="flex items-center gap-3">
        <InvitationBadge count={pending} />
        <UserMenu name={user.name} signOut={signOut} />
      </div>
    </header>
  );
}
