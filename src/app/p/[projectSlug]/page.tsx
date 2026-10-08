import type { Metadata } from "next";
import { ProblemsCallout } from "@/components/notifications/ProblemsCallout";
import { forProject } from "@/server/dal";
import { getSession } from "@/server/auth/session";

type Props = { params: Promise<{ projectSlug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { projectSlug } = await params;
  return { title: projectSlug };
}

export default async function ProjectHome({ params }: Props) {
  const { projectSlug } = await params;
  const scope = await forProject(await getSession(), projectSlug);
  return (
    <section>
      <ProblemsCallout scope={scope} />
      <h1 className="text-2xl font-semibold">{scope.project.name}</h1>
      <p className="mt-2 text-sm">Pick a section from the navigation to get started.</p>
    </section>
  );
}
