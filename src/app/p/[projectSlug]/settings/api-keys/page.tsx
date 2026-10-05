import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { docsUrl } from "@/lib/docs";
import { ForbiddenError, forProject, NotFoundError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import * as apiKeys from "@/server/services/api-keys";
import { toKeyDto } from "./dto";
import { ApiKeysPanel } from "./ApiKeysPanel";

export const metadata: Metadata = { title: "API keys" };
export const dynamic = "force-dynamic";

export default async function ApiKeysPage({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  const session = await getSession();
  let scope;
  let keys;
  try {
    scope = await forProject(session, projectSlug);
    keys = await apiKeys.listApiKeys(scope);
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ForbiddenError) notFound();
    throw error;
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">API keys</h1>
      <p className="text-sm">
        Keys let tools like n8n use this project&apos;s API. Each key works only in this project, only for the permissions you tick.
      </p>
      <p className="flex gap-4 text-sm">
        <a href="/api/v1/openapi.json" className="underline">
          API reference (OpenAPI)
        </a>
        <a href={docsUrl("n8n")} className="underline">
          n8n guide
        </a>
      </p>
      <ApiKeysPanel slug={scope.project.slug} timeZone={scope.project.timezone} keys={keys.map(toKeyDto)} />
    </div>
  );
}
