import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/brand/AuthShell";
import { Alert } from "@/components/ui/Alert";
import { linkStyles } from "@/components/ui/controls";
import { getSession } from "@/server/auth/session";
import { emailAvailable } from "@/server/services/email";
import * as setup from "@/server/services/setup";
import { decideAnonymousRedirect } from "../root-redirect";
import { ForgotPasswordForm } from "./forgot-password-form";

export const metadata: Metadata = { title: "Forgot your password" };

export default async function ForgotPasswordPage() {
  // Same two guards the sign-in page keeps: someone already signed in has no use for this, and a
  // first-run install sends everyone to setup before anything else.
  if (await getSession()) redirect("/");
  const first = decideAnonymousRedirect(await setup.isAvailable());
  if (first) redirect(first);

  const canEmail = emailAvailable();

  return (
    <AuthShell>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Forgot your password</h1>
        <p className="text-sm text-muted-foreground">
          {canEmail
            ? "Give us the address you log in with and we will email you a link to choose a new password."
            : "This install cannot send email, so Docket cannot email you a reset link."}
        </p>
      </div>
      {canEmail ? (
        <ForgotPasswordForm />
      ) : (
        // No form at all rather than one that posts into the void: with no SMTP group configured the
        // request would succeed, send nothing, and leave the person waiting on an email that is never
        // coming. An administrator with database access can reset the password instead.
        <div className="flex flex-col gap-4">
          <Alert tone="warning" title="Email is not configured">
            Ask whoever runs this Docket install to set a password for you, or to configure SMTP so reset
            emails can be sent.
          </Alert>
          <Link href="/login" className={linkStyles}>
            Back to log in
          </Link>
        </div>
      )}
    </AuthShell>
  );
}
