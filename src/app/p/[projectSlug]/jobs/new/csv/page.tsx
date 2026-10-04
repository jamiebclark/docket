import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { forProject, NotFoundError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import { loadJobFormData } from "../form-data";
import { CsvJobForm } from "./CsvJobForm";

export const metadata: Metadata = { title: "New job from CSV" };
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ projectSlug: string }> };

export default async function CsvJobPage({ params }: Props) {
  const { projectSlug } = await params;
  let form;
  try {
    const scope = await forProject(await getSession(), projectSlug);
    if (!scope.can({ generation: ["run"] })) notFound();
    form = await loadJobFormData(scope);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">New job from CSV</h1>
      <CsvJobForm slug={projectSlug} form={form} />
    </div>
  );
}
