import type { Metadata } from "next";
import Link from "next/link";
import { AccountsCard } from "@/components/overview/AccountsCard";
import { ContentToolsCard } from "@/components/overview/ContentToolsCard";
import { ComingUpCard } from "@/components/overview/ComingUpCard";
import { NeedsAttentionCard } from "@/components/overview/NeedsAttentionCard";
import { PostsByStatusCard } from "@/components/overview/PostsByStatusCard";
import { ProblemsCallout } from "@/components/notifications/ProblemsCallout";
import { buttonStyles } from "@/components/ui/Button";
import { Checklist, type ChecklistItem } from "@/components/ui/Checklist";
import { PageHeader } from "@/components/ui/PageHeader";
import { docsUrl } from "@/lib/docs";
import { deriveOverview, type ChecklistStep, type ServerSetupItem } from "@/lib/overview/derive";
import { forProject, NotFoundError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import { getOverview } from "@/server/services/overview";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ projectSlug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { projectSlug } = await params;
  try {
    const session = await getSession();
    if (!session) return {};
    return { title: (await forProject(session, projectSlug)).project.name };
  } catch (error) {
    if (error instanceof NotFoundError) return {};
    throw error;
  }
}

const toItem = (step: ChecklistStep): ChecklistItem => ({
  key: step.key,
  title: step.title,
  description: step.description,
  optional: step.optional,
  status: step.status,
  action: step.action,
  blocked: step.blocked,
});

function serverSetupItem(items: readonly ServerSetupItem[]): ChecklistItem {
  return {
    key: "server_setup",
    title: "Server setup",
    description: "Your server is missing a few pieces. Each link explains how to set it up.",
    optional: true,
    status: { kind: "todo" },
    children: (
      <ul className="mt-1 flex list-disc flex-col gap-1 pl-5 text-sm">
        {items.map((i) => (
          <li key={i.key}>
            <a href={i.href} className="underline" target="_blank" rel="noreferrer">
              {i.label}
            </a>
          </li>
        ))}
      </ul>
    ),
  };
}

export default async function ProjectOverview({ params }: Props) {
  const { projectSlug } = await params;
  const scope = await forProject(await getSession(), projectSlug);
  const facts = await getOverview(scope);
  const view = deriveOverview(facts);
  const { checklist, primaryAction } = view;
  const base = `/p/${facts.project.slug}`;
  const timeZone = facts.project.timezone;

  return (
    <section>
      <ProblemsCallout scope={scope} />
      <PageHeader
        title={view.title}
        description={view.description}
        actions={
          primaryAction ? (
            <Link href={primaryAction.href} className={buttonStyles({ variant: "primary" })}>
              {primaryAction.label}
            </Link>
          ) : null
        }
      />
      {checklist ? (
        <Checklist
          title="Getting started"
          items={[...checklist.steps.map(toItem), ...(checklist.serverSetup ? [serverSetupItem(checklist.serverSetup)] : [])]}
          {...(checklist.mode === "collapsed" ? { collapsedSummary: "Setup complete" } : {})}
          footer={
            <a
              href={docsUrl("getting-started")}
              className="mt-3 inline-block text-sm underline"
              target="_blank"
              rel="noreferrer"
            >
              Read the getting-started guide
            </a>
          }
        />
      ) : null}
      {view.needsAttention ? (
        <div className="mt-6">
          <NeedsAttentionCard items={view.needsAttention} timeZone={timeZone} activityHref={`${base}/activity`} />
        </div>
      ) : null}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ComingUpCard view={view.comingUp} timeZone={timeZone} calendarHref={`${base}/calendar`} />
        <AccountsCard view={view.accounts} timeZone={timeZone} />
        <PostsByStatusCard view={view.postsByStatus} />
        {view.contentTools ? <ContentToolsCard view={view.contentTools} /> : null}
      </div>
    </section>
  );
}
