import type { Metadata } from "next";
import Link from "next/link";
import { DecisionForm } from "@/components/invitations/DecisionForm";
import { signOut } from "@/components/shell/actions";
import { getSession } from "@/server/auth/session";
import * as invitations from "@/server/services/invitations";
import { acceptInvitationByToken, declineInvitationByToken } from "./actions";
import { SignupForm } from "./signup-form";
import { buttonStyles } from "@/components/ui/Button";
import { roleDescription, roleLabel } from "@/lib/roles/roles";
import { AuthShell } from "@/components/brand/AuthShell";

// The token is a credential: no referrer, no caching. The matching header is set in next.config.ts.
export const metadata: Metadata = { title: "Join a project", referrer: "no-referrer" };
export const dynamic = "force-dynamic";

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const { token: raw } = await searchParams;
  const token = Array.isArray(raw) ? raw[0] : raw;
  const session = await getSession();
  const resolved = await invitations.resolveToken(
    token,
    session ? { user: { id: session.user.id, email: session.user.email } } : null,
  );

  let body: React.ReactNode;
  if (resolved.state === "invalid" || !token) {
    body = (
      <>
        <h1 className="text-2xl font-semibold">Invitation not valid</h1>
        <p className="text-sm text-muted-foreground">This invitation is no longer valid. Ask the person who invited you for a new one.</p>
        <Link href="/login" className={buttonStyles({ variant: "secondary", className: "self-start" })}>Go to log in</Link>
      </>
    );
  } else {
    const { invitation } = resolved;
    const summary = (
      <>
        <p className="text-sm">
          {invitation.inviterName} invited you to <strong>{invitation.projectName}</strong> as <strong>{roleLabel(invitation.role)}</strong>.
        </p>
        <p className="text-sm text-muted-foreground">{roleDescription(invitation.role)}</p>
      </>
    );
    if (resolved.state === "signup") {
      body = (
        <>
          <h1 className="text-2xl font-semibold">Join {invitation.projectName}</h1>
          {summary}
          <SignupForm token={token} email={invitation.email} />
        </>
      );
    } else if (resolved.state === "login_required") {
      body = (
        <>
          <h1 className="text-2xl font-semibold">Log in to accept</h1>
          {summary}
          <p className="text-sm">You already have an account for {invitation.email}.</p>
          <Link
            href={`/login?next=${encodeURIComponent(`/signup?token=${token}`)}`}
            className={buttonStyles({ variant: "primary", className: "self-start" })}
          >
            Log in to accept
          </Link>
        </>
      );
    } else if (resolved.state === "accept") {
      body = (
        <>
          <h1 className="text-2xl font-semibold">Join {invitation.projectName}</h1>
          {summary}
          <DecisionForm
            hidden={{ name: "token", value: token }}
            accept={acceptInvitationByToken}
            decline={declineInvitationByToken}
            subject={invitation.projectName}
          />
        </>
      );
    } else {
      body = (
        <>
          <h1 className="text-2xl font-semibold">This invitation is for another email address</h1>
          <p className="text-sm text-muted-foreground">You are signed in with a different account. Sign out and open the link again with the invited address.</p>
          <form action={signOut}>
            <button type="submit" className={buttonStyles({ variant: "secondary" })}>
              Sign out
            </button>
          </form>
        </>
      );
    }
  }

  return (
    <AuthShell>{body}</AuthShell>
  );
}
