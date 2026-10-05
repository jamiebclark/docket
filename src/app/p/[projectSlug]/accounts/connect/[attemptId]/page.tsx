import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LocalTime } from "@/components/ui/LocalTime";
import { forProject, ForbiddenError, NotFoundError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import * as connect from "@/server/services/connect";
import { ChooserForm } from "./ChooserForm";

export const metadata: Metadata = { title: "Choose accounts to connect" };
export const dynamic = "force-dynamic";

export default async function ConnectChooserPage({ params }: { params: Promise<{ projectSlug: string; attemptId: string }> }) {
  const { projectSlug, attemptId } = await params;
  const session = await getSession();
  let scope;
  try {
    scope = await forProject(session, projectSlug);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  if (!session || !scope.can({ account: ["manage"] })) notFound();
  let choice;
  try {
    choice = await connect.getConnectChoice(scope, attemptId, { sessionId: session.session.id });
  } catch (error) {
    if (error instanceof ForbiddenError) notFound();
    throw error;
  }
  if (!choice) {
    return (
      <section className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">Connect accounts</h1>
        <p role="alert">This connection attempt has expired or is not valid. Start again.</p>
        <Link href={`/p/${projectSlug}/accounts`} className="underline">
          Back to accounts
        </Link>
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Connect {choice.groupDisplayName}</h1>
      <p className="text-sm text-muted-foreground">
        Choose what to connect. This choice is available until <LocalTime value={choice.expiresAt} timeZone={scope.project.timezone} />.
      </p>
      {choice.notices.map((n) => (
        <p key={n} role="status" className="text-sm">
          {n}
        </p>
      ))}
      {choice.missing.length > 0 ? (
        <div className="text-sm">
          <p>These accounts need reconnecting but were not found for this login:</p>
          <ul className="list-disc pl-6">
            {choice.missing.map((m) => (
              <li key={m.accountId}>
                {m.displayName} ({m.providerName}) was not found for this login
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <ChooserForm
        slug={projectSlug}
        attemptId={attemptId}
        candidates={choice.candidates.map((c) => ({
          key: c.key,
          providerName: c.providerName,
          displayName: c.displayName,
          parentKey: c.parentKey,
          notes: c.notes,
          state: c.state,
        }))}
      />
    </section>
  );
}
