import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NotFoundError } from "@/server/dal";
import { getVoiceProfile } from "@/server/services/voice";
import { accountOptions, scopeOrNotFound } from "../scope";
import { VoiceEditor } from "../VoiceEditor";
import { ArchivedBanner } from "./ArchivedBanner";

export const metadata: Metadata = { title: "Voice profile" };
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ projectSlug: string; profileId: string }> };

export default async function VoiceProfilePage({ params }: Props) {
  const { projectSlug, profileId } = await params;
  const scope = await scopeOrNotFound(projectSlug);
  let found;
  try {
    found = await getVoiceProfile(scope, profileId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const manage = scope.can({ voice: ["manage"] }) && !found.profile.archivedAt;
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{found.profile.name}</h1>
      {found.profile.archivedAt ? (
        <ArchivedBanner slug={projectSlug} profileId={profileId} canManage={scope.can({ voice: ["manage"] })} />
      ) : null}
      <VoiceEditor
        slug={projectSlug}
        canManage={manage}
        profile={{
          id: found.profile.id,
          version: found.current.version,
          versionId: found.current.id,
          isDefault: found.isDefault,
        }}
        initialName={found.profile.name}
        initialContent={found.current.content}
        accounts={await accountOptions(scope)}
      />
    </section>
  );
}
