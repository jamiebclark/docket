import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AnnounceProvider } from "@/components/ui/Announce";
import { InboxItemDetail } from "@/components/engagement/InboxItemDetail";
import { findProvider } from "@/providers/registry";
import { forProject, NotFoundError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import { getInboxItem } from "@/server/services/engagement/inbox";

export const metadata: Metadata = { title: "Inbox item" };
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ projectSlug: string; itemId: string }> };

export default async function InboxItemPage({ params }: Props) {
  const { projectSlug, itemId } = await params;
  let scope;
  try {
    scope = await forProject(await getSession(), projectSlug);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  if (!scope.can({ engagement: ["view"] })) notFound();

  let item;
  try {
    item = await getInboxItem(scope, itemId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const tz = scope.project.timezone;
  const provider = findProvider(item.providerKey);
  const textCaps = provider?.capabilities.text ?? { maxLength: 0, countingRule: "code_points" as const };
  const canReply = scope.can({ engagement: ["reply"] });

  return (
    <AnnounceProvider focusFallbackId="page-title">
      <section>
        <InboxItemDetail
          item={item}
          projectSlug={projectSlug}
          tz={tz}
          canReply={canReply}
          maxLength={textCaps.maxLength}
          countingRule={textCaps.countingRule}
          headingLevel={1}
          headingId="page-title"
        />
      </section>
    </AnnounceProvider>
  );
}
