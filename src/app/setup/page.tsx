import type { Metadata } from "next";
import { redirect } from "next/navigation";
import * as setup from "@/server/services/setup";
import { SetupForm } from "./setup-form";
import { AuthShell } from "@/components/brand/AuthShell";

export const metadata: Metadata = { title: "Set up" };
export const dynamic = "force-dynamic";

export default async function SetupPage() {
  if (!(await setup.isAvailable())) redirect("/login");
  return (
    <AuthShell>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Welcome to Docket</h1>
        <p className="text-sm text-muted-foreground">Create the first account. It becomes the owner of your first project.</p>
      </div>
      <SetupForm />
    </AuthShell>
  );
}
