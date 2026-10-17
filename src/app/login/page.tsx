import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { safeRedirect } from "@/lib/safe-redirect";
import { getSession } from "@/server/auth/session";
import { emailAvailable } from "@/server/services/email";
import * as setup from "@/server/services/setup";
import { decideAnonymousRedirect } from "../root-redirect";
import { LoginForm } from "./login-form";
import { AuthShell } from "@/components/brand/AuthShell";
import { Alert } from "@/components/ui/Alert";

export const metadata: Metadata = { title: "Log in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[]; reset?: string | string[] }>;
}) {
  const { next, reset } = await searchParams;
  const target = safeRedirect(Array.isArray(next) ? next[0] : next, "/");
  if (await getSession()) redirect("/");
  const first = decideAnonymousRedirect(await setup.isAvailable());
  if (first) redirect(first);
  // Set by the reset form, which does not sign the person in: without a word here, a successful reset
  // would land on a bare sign-in page and read as though it had failed.
  const justReset = (Array.isArray(reset) ? reset[0] : reset) === "1";

  return (
    <AuthShell>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Welcome back</h1>
        <p className="text-sm text-muted-foreground">Log in to Docket to plan and schedule your posts.</p>
      </div>
      {justReset ? <Alert tone="success">Your password has been changed. Log in with the new one.</Alert> : null}
      <LoginForm next={target} canReset={emailAvailable()} />
    </AuthShell>
  );
}
