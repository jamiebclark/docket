import { PageHeader } from "@/components/ui/PageHeader";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getSession } from "@/server/auth/session";
import { forProject, NotFoundError } from "@/server/dal";
import { getStandingSeries } from "@/server/services/standing-series/read";
import { loadStandingSeriesFormData } from "../../form-data";
import { StandingSeriesForm } from "../../StandingSeriesForm";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ projectSlug: string; seriesId: string }> };

async function load(projectSlug: string, seriesId: string) {
  try {
    const scope = await forProject(await getSession(), projectSlug);
    if (!scope.can({ standing_series: ["manage"] })) notFound();
    return { scope, series: await getStandingSeries(scope, seriesId) };
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { projectSlug, seriesId } = await params;
  const { series } = await load(projectSlug, seriesId);
  return { title: `${series.name} · Standing series` };
}

export default async function EditStandingSeriesPage({ params }: Props) {
  const { projectSlug, seriesId } = await params;
  const { scope, series } = await load(projectSlug, seriesId);
  const data = await loadStandingSeriesFormData(scope);

  return (
    <section className="flex flex-col gap-4">
      <PageHeader title={`Edit "${series.name}"`} />
      <StandingSeriesForm
        slug={projectSlug}
        mode="edit"
        seriesId={seriesId}
        initial={{
          name: series.name,
          brief: series.brief,
          template: series.template,
          voiceProfileId: series.voiceProfile.id,
          targetAccountIds: series.accounts.filter((a) => !a.removed).map((a) => a.id),
          cadenceCount: series.cadence?.count ?? 1,
          cadencePeriod: series.cadence?.period ?? "day",
          mediaSource: series.media.source,
          mediaTag: series.media.tag,
          imagePrompt: series.media.prompt,
          approval: series.requestedApproval,
          scheduling: series.requestedScheduling,
        }}
        profiles={data.profiles}
        accounts={data.accounts}
        mediaTags={data.mediaTags}
        defaults={data.defaults}
        canAutoApprove={data.canAutoApprove}
        timezone={data.timezone}
      />
    </section>
  );
}
