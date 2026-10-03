import { notFound, redirect } from "next/navigation";
import { InvitationBadge } from "@/components/shell/InvitationBadge";
import { LeftNav } from "@/components/shell/LeftNav";
import { ProjectSwitcher } from "@/components/shell/ProjectSwitcher";
import { UserMenu } from "@/components/shell/UserMenu";
import { signOut } from "@/components/shell/actions";
import { NotFoundError } from "@/server/dal";
import { forProject } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import * as invitations from "@/server/services/invitations";
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
  const [mine, pending] = await Promise.all([
    projects.listMine(session),
    invitations.countMine({ user: { id: session.user.id, email: session.user.email } }),
  ]);

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-foreground/20 px-4 py-2">
        <ProjectSwitcher projects={mine} currentName={scope.project.name} />
        <div className="flex items-center gap-3">
          <InvitationBadge count={pending} />
          <UserMenu name={session.user.name} signOut={signOut} />
        </div>
      </header>
      <div className="flex flex-1">
        <LeftNav projectSlug={scope.project.slug} />
        <main id="main" className="flex-1 p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
