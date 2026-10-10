import { PageHeader } from "@/components/ui/PageHeader";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Checklist } from "@/components/ui/Checklist";
import { PREREQUISITES_TITLE } from "@/lib/roles/prerequisites";
import { loadPrerequisites } from "../../../generate/prerequisites";
import { forProject, NotFoundError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import { loadJobFormData } from "../form-data";
import { CsvJobForm } from "./CsvJobForm";

export const metadata: Metadata = { title: "New batch job from CSV" };
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ projectSlug: string }> };

export default async function CsvJobPage({ params }: Props) {
  const { projectSlug } = await params;
  let form;
  let prerequisites;
  try {
    const scope = await forProject(await getSession(), projectSlug);
    if (!scope.can({ generation: ["run"] })) notFound();
    prerequisites = await loadPrerequisites(scope, projectSlug);
    if (!prerequisites) form = await loadJobFormData(scope);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  return (
    <div className="space-y-4">
      <PageHeader title="New batch job from CSV" description="Generate one post for each row of a CSV file." />
      {prerequisites || !form ? (
        <Checklist title={PREREQUISITES_TITLE} items={prerequisites ?? []} />
      ) : (
        <CsvJobForm slug={projectSlug} form={form} />
      )}
    </div>
  );
}
