import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SignedInHeader } from "@/components/shell/SignedInHeader";
import { getSession } from "@/server/auth/session";
import { NewProjectForm } from "./new-project-form";

export const metadata: Metadata = { title: "New project" };

export default async function NewProjectPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/p/new");
  return (
    <>
      <SignedInHeader user={session.user} />
      <main id="main" className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center px-4 py-12 sm:py-16">
        <div className="flex flex-col gap-6 rounded-2xl border border-border bg-surface p-6 shadow-card sm:p-8">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold">Create a project</h1>
            <p className="text-sm text-muted-foreground">Next you&apos;ll connect a social account and choose when it posts.</p>
          </div>
          <NewProjectForm />
        </div>
      </main>
    </>
  );
}
