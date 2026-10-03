import { notFound, redirect } from "next/navigation";
import { LeftNav } from "@/components/shell/LeftNav";
import { ProjectSwitcher } from "@/components/shell/ProjectSwitcher";
import { SignedInHeader } from "@/components/shell/SignedInHeader";
import { NotFoundError } from "@/server/dal";
import { forProject } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import * as projects from "@/server/services/projects";

/** Project shell: resolves membership on every request; non-members see the same 404 as a missing project. */
export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ projectSlug: string }>;
}) {
  const { projectSlug } = await params;
  const session = await getSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(`/p/${projectSlug}`)}`);
  let scope;
  try {
    scope = await forProject(session, projectSlug);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const mine = await projects.listMine(session);

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <SignedInHeader user={session.user} left={<ProjectSwitcher projects={mine} currentName={scope.project.name} />} />
      <div className="flex flex-1">
        <LeftNav projectSlug={scope.project.slug} />
        <main id="main" className="flex-1 p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
