import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { DecisionForm } from "@/components/invitations/DecisionForm";
import { EmptyState } from "@/components/ui/EmptyState";
import { getSession } from "@/server/auth/session";
import * as invitations from "@/server/services/invitations";
import { acceptInvitation, declineInvitation } from "./actions";

export const metadata: Metadata = { title: "Invitations" };
export const dynamic = "force-dynamic";

export default async function InvitationsPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/invitations");
  const mine = await invitations.listMine({ user: { id: session.user.id, email: session.user.email } });

  return (
    <main id="main" className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-12">
      <h1 className="text-2xl font-semibold">Invitations</h1>
      {mine.length === 0 ? (
        <EmptyState message="You have no pending invitations." action={<Link href="/" className="text-sm underline">Back to your projects</Link>} />
      ) : (
        <ul className="flex flex-col gap-4">
          {mine.map((inv) => (
            <li key={inv.id} className="flex flex-col gap-3 rounded-lg border border-foreground/20 p-4">
              <div>
                <p className="font-medium">{inv.projectName}</p>
                <p className="text-sm">
                  Join as <strong>{inv.role}</strong>. Invited by {inv.inviterName}. Expires{" "}
                  <time dateTime={inv.expiresAt.toISOString()}>{inv.expiresAt.toUTCString()}</time>.
                </p>
              </div>
              <DecisionForm
                hidden={{ name: "invitationId", value: inv.id }}
                accept={acceptInvitation}
                decline={declineInvitation}
                subject={inv.projectName}
              />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
