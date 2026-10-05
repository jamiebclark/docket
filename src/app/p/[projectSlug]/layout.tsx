import { notFound, redirect } from "next/navigation";
import { LeftNav } from "@/components/shell/LeftNav";
import { ProjectSwitcher } from "@/components/shell/ProjectSwitcher";
import { ReauthBanner } from "@/components/shell/ReauthBanner";
import { SchedulerHealth } from "@/components/shell/SchedulerHealth";
import { SignedInHeader } from "@/components/shell/SignedInHeader";
import { NotFoundError } from "@/server/dal";
import { forProject } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import { now } from "@/server/dal/clock";
import { countNeedsDecision } from "@/server/services/failures";
import { listAccountsNeedingReauth } from "@/server/services/accounts";
import * as projects from "@/server/services/projects";
import { countReviewQueue } from "@/server/services/review";
import { getSchedulerHealth } from "@/server/services/scheduler-health";

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
  const health = await getSchedulerHealth(scope);
  const reauth = await listAccountsNeedingReauth(scope);
  const reviewCount = await countReviewQueue(scope);
  const failuresCount = await countNeedsDecision(scope);
  const at = await now();
  const timezone = scope.project.timezone;

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <SignedInHeader
        user={session.user}
        left={
          <div className="flex items-center gap-3">
            <ProjectSwitcher projects={mine} currentName={scope.project.name} />
            <SchedulerHealth variant="quiet" health={health} now={at} timezone={timezone} />
          </div>
        }
      />
      <SchedulerHealth variant="banner" health={health} now={at} timezone={timezone} />
      <ReauthBanner accounts={reauth} projectSlug={scope.project.slug} canManage={scope.can({ account: ["manage"] })} />
      <div className="flex flex-1 flex-col md:flex-row">
        <LeftNav projectSlug={scope.project.slug} reviewCount={reviewCount} failuresCount={failuresCount} />
        <main id="main" className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
