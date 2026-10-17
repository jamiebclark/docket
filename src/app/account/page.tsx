import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SignedInHeader } from "@/components/shell/SignedInHeader";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { getSession } from "@/server/auth/session";
import { ChangePasswordForm } from "./change-password-form";

export const metadata: Metadata = { title: "Your account" };
export const dynamic = "force-dynamic";

/**
 * The only user-level account page: everything else under /p/[projectSlug]/settings belongs to a
 * project. Name and email are shown read-only — changing either is its own job, and neither is what
 * someone comes here for.
 */
export default async function AccountPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/account");

  return (
    <>
      <SignedInHeader user={session.user} />
      <main id="main" className="mx-auto w-full max-w-4xl flex-1 px-4 py-8">
        <PageHeader title="Your account" description="How you sign in to Docket." />
        <div className="flex flex-col gap-6">
          <Card title="Sign-in details">
            <dl className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <dt className="text-sm font-medium text-muted-foreground">Name</dt>
                <dd className="text-sm">{session.user.name}</dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-sm font-medium text-muted-foreground">Email</dt>
                <dd className="text-sm break-all">{session.user.email}</dd>
              </div>
            </dl>
          </Card>
          <Card
            title="Change password"
            description="Changing your password signs you out on every other device."
          >
            <ChangePasswordForm />
          </Card>
        </div>
      </main>
    </>
  );
}
