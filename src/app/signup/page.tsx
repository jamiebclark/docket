import type { Metadata } from "next";
import Link from "next/link";
import { DecisionForm } from "@/components/invitations/DecisionForm";
import { signOut } from "@/components/shell/actions";
import { getSession } from "@/server/auth/session";
import * as invitations from "@/server/services/invitations";
import { acceptInvitationByToken, declineInvitationByToken } from "./actions";
import { SignupForm } from "./signup-form";

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
        <p className="text-sm">This invitation is no longer valid. Ask the person who invited you for a new one.</p>
        <Link href="/login" className="text-sm underline">Go to log in</Link>
      </>
    );
  } else {
    const { invitation } = resolved;
    const summary = (
      <p className="text-sm">
        {invitation.inviterName} invited you to <strong>{invitation.projectName}</strong> as <strong>{invitation.role}</strong>.
      </p>
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
            className="self-start rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-foreground"
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
          <p className="text-sm">You are signed in with a different account. Sign out and open the link again with the invited address.</p>
          <form action={signOut}>
            <button type="submit" className="rounded-md border border-foreground/30 px-3 py-1.5 text-sm font-medium hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground">
              Sign out
            </button>
          </form>
        </>
      );
    }
  }

  return (
    <main id="main" className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-4 px-4 py-16">
      {body}
    </main>
  );
}
