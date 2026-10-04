import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState } from "@/components/ui/EmptyState";
import { FilterTabs } from "@/components/ui/FilterTabs";
import { LocalTime } from "@/components/ui/LocalTime";
import { findProvider } from "@/providers/registry";
import { forProject, NotFoundError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import { getLlmStatus } from "@/server/llm";
import * as accounts from "@/server/services/accounts";
import { listRecentFailures } from "@/server/services/generation/failures";
import { getStorage } from "@/server/storage";
import { GenerateForm } from "./GenerateForm";
import type { AccountOption } from "./generate-logic";

export const metadata: Metadata = { title: "Generate" };
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ projectSlug: string }>;
  searchParams?: Promise<{ mode?: string }>;
};

export default async function GeneratePage({ params, searchParams }: Props) {
  const { projectSlug } = await params;
  const mode = (await searchParams)?.mode === "series" ? "series" : "single";
  let scope;
  try {
    scope = await forProject(await getSession(), projectSlug);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const base = `/p/${projectSlug}/generate`;
  const heading = (
    <>
      <h1 className="text-2xl font-semibold">Generate</h1>
      <FilterTabs
        label="Generation mode"
        tabs={[
          { label: "Single post", href: `${base}?mode=single`, active: mode === "single" },
          { label: "Series", href: `${base}?mode=series`, active: mode === "series" },
        ]}
      />
    </>
  );

  const status = getLlmStatus();
  if (!status.configured) {
    const names = status.problems.map((p) => p.name);
    return (
      <section className="flex flex-col gap-4">
        {heading}
        <EmptyState
          message={`Generation is not set up. Set ${names.join(", ")} on the server, then reload this page.`}
        />
      </section>
    );
  }

  const profiles = await scope.voiceProfiles.list();
  if (profiles.length === 0) {
    const manage = scope.can({ voice: ["manage"] });
    return (
      <section className="flex flex-col gap-4">
        {heading}
        <EmptyState
          message={
            manage
              ? "No voice profile yet. Create one so generated posts sound like you."
              : "No voice profile yet. Ask an owner or admin to create one."
          }
          action={manage ? <Link href={`/p/${projectSlug}/voice/new`} className="text-sm underline">Create a voice profile</Link> : undefined}
        />
      </section>
    );
  }

  const list = await accounts.listAccounts(scope);
  if (list.length === 0) {
    return (
      <section className="flex flex-col gap-4">
        {heading}
        <EmptyState
          message="Connect an account first, then come back to generate posts for it."
          action={<Link href={`/p/${projectSlug}/accounts`} className="text-sm underline">Go to Accounts</Link>}
        />
      </section>
    );
  }

  const options: AccountOption[] = list.map((a) => {
    const caps = findProvider(a.providerKey)?.capabilities;
    return {
      id: a.id,
      displayName: a.displayName,
      providerKey: a.providerKey,
      providerName: a.providerName,
      status: a.status,
      providerAvailable: a.providerAvailable,
      maxImages: caps?.media.maxImages ?? 0,
      mediaRequired: caps?.media.required ?? false,
    };
  });
  const failures = scope.can({ post: ["view"] }) ? await listRecentFailures(scope, { limit: 5 }) : [];
  const defaultId = scope.project.defaultVoiceProfileId;

  return (
    <section className="flex flex-col gap-4">
      {heading}
      {mode === "series" ? (
        <EmptyState message="Series mode is coming soon. For now, generate a single post." />
      ) : (
        <GenerateForm
          slug={projectSlug}
          profiles={profiles.map((p) => ({ id: p.id, name: p.name, isDefault: p.id === defaultId }))}
          accounts={options}
          defaults={{ approval: scope.project.defaultApprovalPolicy, scheduling: scope.project.defaultSchedulingPolicy }}
          mediaEnabled={getStorage() !== null}
        />
      )}
      {failures.length > 0 ? (
        <section aria-labelledby="recent-failures" className="flex max-w-2xl flex-col gap-2">
          <h2 id="recent-failures" className="text-lg font-semibold">
            Recent failures
          </h2>
          <ul className="flex flex-col gap-1 text-sm">
            {failures.map((f) => (
              <li key={f.id}>
                <LocalTime value={f.createdAt} timeZone={scope.project.timezone} />: {f.message}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}
