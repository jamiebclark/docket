import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ForbiddenError, forProject, NotFoundError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import * as webhooks from "@/server/services/webhooks";
import { toEndpointDto } from "../dto";
import { DeliveryDto } from "./DeliveryLog";
import { EndpointDetail } from "./EndpointDetail";

export const dynamic = "force-dynamic";

const MAX_ATTEMPTS = 8;

type Params = Promise<{ projectSlug: string; endpointId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { projectSlug, endpointId } = await params;
  try {
    const endpoint = await webhooks.getEndpoint(await forProject(await getSession(), projectSlug), endpointId);
    return { title: `Webhook: ${new URL(endpoint.url).host}` };
  } catch {
    return { title: "Webhook" };
  }
}

export default async function EndpointPage({ params }: { params: Params }) {
  const { projectSlug, endpointId } = await params;
  const session = await getSession();
  let scope;
  let endpoint;
  let rows;
  try {
    scope = await forProject(session, projectSlug);
    endpoint = await webhooks.getEndpoint(scope, endpointId);
    rows = await webhooks.listDeliveries(scope, endpointId, { limit: 50 });
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ForbiddenError) notFound();
    throw error;
  }
  const dto = toEndpointDto(endpoint);
  const deliveries: DeliveryDto[] = rows.map((d) => ({
    id: d.id,
    eventId: d.eventId,
    eventType: d.eventType,
    status: d.status,
    attemptCount: d.attemptCount,
    maxAttempts: MAX_ATTEMPTS,
    createdAt: d.createdAt.toISOString(),
    nextAttemptAt: d.status === "pending" ? d.nextAttemptAt.toISOString() : null,
    result: d.lastStatusCode ? String(d.lastStatusCode) : (d.lastErrorKind ?? "—"),
    attempts: d.attempts.map((a) => ({
      attempt: a.attempt,
      at: a.at.toISOString(),
      result: a.statusCode ? String(a.statusCode) : (a.errorKind ?? "—"),
      durationMs: a.durationMs,
      excerpt: a.responseExcerpt,
    })),
  }));

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm">
        <Link href={`/p/${scope.project.slug}/settings/webhooks`} className="underline">
          ← All webhooks
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">Webhook: {dto.host}</h1>
      <EndpointDetail slug={scope.project.slug} timeZone={scope.project.timezone} endpoint={dto} deliveries={deliveries} />
    </div>
  );
}
