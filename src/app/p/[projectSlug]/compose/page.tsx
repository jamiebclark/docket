import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { forProject, NotFoundError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import { getStorage } from "@/server/storage";
import * as accounts from "@/server/services/accounts";
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
  return (
    <Composer
      slug={projectSlug}
      timeZone={scope.project.timezone}
      accounts={list.map(({ id, displayName, providerName, status, providerAvailable }) => ({
        id,
        displayName,
        providerName,
        status,
        providerAvailable,
      }))}
      canManageAccounts={scope.can({ account: ["manage"] })}
      canEdit={scope.can({ post: ["edit"] })}
      canSchedule={scope.can({ post: ["schedule"] })}
      mediaEnabled={getStorage() !== null}
    />
  );
}
