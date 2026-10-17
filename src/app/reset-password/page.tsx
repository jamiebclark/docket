import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/brand/AuthShell";
import { Alert } from "@/components/ui/Alert";
import { linkStyles } from "@/components/ui/controls";
import { getSession } from "@/server/auth/session";
import * as setup from "@/server/services/setup";
import { decideAnonymousRedirect } from "../root-redirect";
import { ResetPasswordForm } from "./reset-password-form";

export const metadata: Metadata = { title: "Choose a new password" };

const first = (value: string | string[] | undefined): string => (Array.isArray(value) ? (value[0] ?? "") : (value ?? ""));

/**
 * Where Better Auth's `/api/auth/reset-password/:token` callback lands. That endpoint has already
 * checked the token exists and has not expired, then redirects here with `?token=`; a token it rejected
 * arrives as `?error=INVALID_TOKEN` instead. The token is still verified again when the form is
 * submitted, so this page's job is only to put it in the form and to say something useful when the
 * callback has already refused it.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[]; error?: string | string[] }>;
}) {
  if (await getSession()) redirect("/");
  const firstRun = decideAnonymousRedirect(await setup.isAvailable());
  if (firstRun) redirect(firstRun);

  const { token: rawToken, error: rawError } = await searchParams;
  const token = first(rawToken);
  const failed = first(rawError) !== "" || token === "";

  return (
    <AuthShell>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Choose a new password</h1>
        <p className="text-sm text-muted-foreground">
          {failed
            ? "That link cannot be used."
            : "Setting a new password signs you out everywhere else, on every device."}
        </p>
      </div>
      {failed ? (
        <div className="flex flex-col gap-4">
          <Alert tone="danger" title="This reset link has expired or has already been used">
            Reset links last an hour and work once. Ask for a new one and use the most recent email.
          </Alert>
          <Link href="/forgot-password" className={linkStyles}>
            Ask for a new reset link
          </Link>
        </div>
      ) : (
        <ResetPasswordForm token={token} />
      )}
    </AuthShell>
  );
}
