import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { safeRedirect } from "@/lib/safe-redirect";
import { getSession } from "@/server/auth/session";
import * as setup from "@/server/services/setup";
import { decideAnonymousRedirect } from "../root-redirect";
import { LoginForm } from "./login-form";
import { AuthShell } from "@/components/brand/AuthShell";

export const metadata: Metadata = { title: "Log in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next } = await searchParams;
  const target = safeRedirect(Array.isArray(next) ? next[0] : next, "/");
  if (await getSession()) redirect("/");
  if (await setup.isAvailable()) redirect(decideAnonymousRedirect(true));

  return (
    <AuthShell>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Welcome back</h1>
        <p className="text-sm text-muted-foreground">Log in to Docket to plan and schedule your posts.</p>
      </div>
      <LoginForm next={target} />
    </AuthShell>
  );
}
