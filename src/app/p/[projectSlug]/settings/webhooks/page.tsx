import { PageHeader } from "@/components/ui/PageHeader";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { docsUrl } from "@/lib/docs";
import { ForbiddenError, forProject, NotFoundError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import * as webhooks from "@/server/services/webhooks";
import { toEndpointDto } from "./dto";
import { WebhooksPanel } from "./WebhooksPanel";

export const metadata: Metadata = { title: "Webhooks" };
export const dynamic = "force-dynamic";

export default async function WebhooksPage({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  const session = await getSession();
  let scope;
  let endpoints;
  try {
    scope = await forProject(session, projectSlug);
    endpoints = await webhooks.listEndpoints(scope);
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ForbiddenError) notFound();
    throw error;
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Webhooks"
        description="Docket can tell another service when posts publish or fail, when a job finishes, or when an account needs reconnecting."
      />
      <p className="text-sm">
        <a href={docsUrl("n8n", "6-verifying-webhook-signatures")} className="underline">
          Verifying webhook signatures
        </a>
      </p>
      <WebhooksPanel slug={scope.project.slug} timeZone={scope.project.timezone} endpoints={endpoints.map(toEndpointDto)} />
    </div>
  );
}
