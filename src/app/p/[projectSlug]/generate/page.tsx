import { PageHeader } from "@/components/ui/PageHeader";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Checklist } from "@/components/ui/Checklist";
import { FilterTabs } from "@/components/ui/FilterTabs";
import { LocalTime } from "@/components/ui/LocalTime";
import { findProvider } from "@/providers/registry";
import { forProject, NotFoundError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import { PREREQUISITES_TITLE } from "@/lib/roles/prerequisites";
import * as accounts from "@/server/services/accounts";
import { listRecentFailures } from "@/server/services/generation/failures";
import { getStorage } from "@/server/storage";
import { loadPrerequisites } from "./prerequisites";
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
      <PageHeader title="Generate" description="Draft one post, or a series of related posts, in your brand voice." />
      <FilterTabs
        label="Generation mode"
        tabs={[
          { label: "Single post", href: `${base}?mode=single`, active: mode === "single" },
          { label: "Series", href: `${base}?mode=series`, active: mode === "series" },
        ]}
      />
    </>
  );

  const prerequisites = await loadPrerequisites(scope, projectSlug);
  if (prerequisites) {
    return (
      <section className="flex flex-col gap-4">
        {heading}
        <Checklist title={PREREQUISITES_TITLE} items={prerequisites} />
      </section>
    );
  }

  const profiles = await scope.voiceProfiles.list();
  const list = await accounts.listAccounts(scope);
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
      postingInstructions: a.postingInstructions,
    };
  });
  const failures = scope.can({ post: ["view"] }) ? await listRecentFailures(scope, { limit: 5 }) : [];
  const defaultId = scope.project.defaultVoiceProfileId;

  return (
    <section className="flex flex-col gap-4">
      {heading}
      <GenerateForm
        slug={projectSlug}
        mode={mode}
        profiles={profiles.map((p) => ({ id: p.id, name: p.name, isDefault: p.id === defaultId }))}
        accounts={options}
        defaults={{ approval: scope.project.defaultApprovalPolicy, scheduling: scope.project.defaultSchedulingPolicy }}
        mediaEnabled={getStorage() !== null}
        canAutoApprove={scope.can({ generation: ["auto_approve"] })}
      />
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
