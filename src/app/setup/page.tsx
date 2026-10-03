import type { Metadata } from "next";
import { redirect } from "next/navigation";
import * as setup from "@/server/services/setup";
import { SetupForm } from "./setup-form";

export const metadata: Metadata = { title: "Set up" };
export const dynamic = "force-dynamic";

export default async function SetupPage() {
  if (!(await setup.isAvailable())) redirect("/login");
  return (
    <main id="main" className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-16">
      <h1 className="text-2xl font-semibold">Welcome to Docket</h1>
      <p className="text-sm">Create the first account. It becomes the owner of your first project.</p>
      <SetupForm />
    </main>
  );
}
