import { PageHeader } from "@/components/ui/PageHeader";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getSession } from "@/server/auth/session";
import { forProject, NotFoundError } from "@/server/dal";
import { loadStandingSeriesFormData } from "../form-data";
import { StandingSeriesForm } from "../StandingSeriesForm";

export const metadata: Metadata = { title: "Standing series" };
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ projectSlug: string }> };

export default async function NewStandingSeriesPage({ params }: Props) {
  const { projectSlug } = await params;
  let scope;
  try {
    scope = await forProject(await getSession(), projectSlug);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  if (!scope.can({ standing_series: ["manage"] })) notFound();

  const data = await loadStandingSeriesFormData(scope);

  return (
    <section className="flex flex-col gap-4">
      <PageHeader title="New standing series" description="Keeps producing posts on a cadence until you pause it." />
      <StandingSeriesForm
        slug={projectSlug}
        mode="create"
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
