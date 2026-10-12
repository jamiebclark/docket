import { PageHeader } from "@/components/ui/PageHeader";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ForbiddenError, forProject, NotFoundError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import { getProjectLlm } from "@/server/services/generation/credential";
import { toModelDto } from "./dto";
import { ModelPanel } from "./ModelPanel";

export const metadata: Metadata = { title: "Model & API key" };
export const dynamic = "force-dynamic";

export default async function ModelPage({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  const session = await getSession();
  let scope;
  let view;
  try {
    scope = await forProject(session, projectSlug);
    view = await getProjectLlm(scope);
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ForbiddenError) notFound();
    throw error;
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Model & API key"
        description="Which model this project generates with, and whose provider credit it spends."
      />
      <ModelPanel slug={scope.project.slug} timeZone={scope.project.timezone} view={toModelDto(view)} />
    </div>
  );
}
