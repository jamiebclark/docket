import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { safeRedirect } from "@/lib/safe-redirect";
import { getSession } from "@/server/auth/session";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Log in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next } = await searchParams;
  const target = safeRedirect(Array.isArray(next) ? next[0] : next, "/");
  if (await getSession()) redirect("/");

  return (
    <main id="main" className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-16">
      <h1 className="text-2xl font-semibold">Log in to Docket</h1>
      <LoginForm next={target} />
    </main>
  );
}
