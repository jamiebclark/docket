import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { forProject, NotFoundError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import { SettingsForm } from "./settings-form";

export const metadata: Metadata = { title: "Project settings" };
export const dynamic = "force-dynamic";

export default async function ProjectSettingsPage({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  let scope;
  try {
    scope = await forProject(await getSession(), projectSlug);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const p = scope.project;
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Project settings</h1>
      <SettingsForm
        canEdit={scope.can({ project: ["update"] })}
        values={{
          name: p.name,
          slug: p.slug,
          timezone: p.timezone,
          defaultApprovalPolicy: p.defaultApprovalPolicy,
          defaultSchedulingPolicy: p.defaultSchedulingPolicy,
        }}
      />
    </div>
  );
}
