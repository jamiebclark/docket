import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { forProject, NotFoundError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import { getStorage } from "@/server/storage";
import * as accounts from "@/server/services/accounts";
import { hasActiveSlot } from "@/lib/roles/slots";
import { askManagers } from "@/lib/roles/names";
import { listManagers } from "@/server/services/members";
import { listSlotCounts } from "@/server/services/slots";
import { Composer } from "./Composer";

export const metadata: Metadata = { title: "Compose" };
export const dynamic = "force-dynamic";

export default async function ComposePage({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  let scope;
  try {
    scope = await forProject(await getSession(), projectSlug);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const list = await accounts.listAccounts(scope);
  const counts = await listSlotCounts(scope).catch(() => null);
  const slotById = new Map((counts ?? []).map((c) => [c.accountId, hasActiveSlot(c)]));
  const canManageAccounts = scope.can({ account: ["manage"] });
  const canManageSlots = scope.can({ slot: ["manage"] });
  const managersToAsk =
    canManageAccounts && canManageSlots ? undefined : askManagers(await listManagers(scope), "or");
  return (
    <Composer
      slug={projectSlug}
      timeZone={scope.project.timezone}
      accounts={list.map(({ id, displayName, providerKey, providerName, status, providerAvailable }) => ({
        id,
        displayName,
        providerKey,
        providerName,
        status,
        providerAvailable,
        hasActiveSlot: counts ? (slotById.get(id) ?? false) : null,
      }))}
      canManageAccounts={canManageAccounts}
      canManageSlots={canManageSlots}
      managersToAsk={managersToAsk}
      canEdit={scope.can({ post: ["edit"] })}
      canSchedule={scope.can({ post: ["schedule"] })}
      mediaEnabled={getStorage() !== null}
    />
  );
}
