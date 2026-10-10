import { PageHeader } from "@/components/ui/PageHeader";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { forProject, NotFoundError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import { getSeries } from "@/server/services/generation/series";
import type { Slot } from "../../series-logic";
import { SeriesWriter } from "./SeriesWriter";

export const metadata: Metadata = { title: "Series" };
export const dynamic = "force-dynamic";

export default async function SeriesPage({ params }: { params: Promise<{ projectSlug: string; seriesId: string }> }) {
  const { projectSlug, seriesId } = await params;
  let detail;
  try {
    const scope = await forProject(await getSession(), projectSlug);
    detail = await getSeries(scope, seriesId);
  } catch (error) {
    if (error instanceof NotFoundError || (error instanceof Error && ["ZodError", "ForbiddenError"].includes(error.name))) notFound();
    throw error;
  }
  // A failure from an earlier visit is shown with "Try again"; the rest are written on arrival.
  const initialSlots: Slot[] = detail.angles.map((_, i) => {
    const post = detail.posts[i];
    if (post) return { state: "done", postId: post.id };
    const failure = detail.failures[i];
    return failure ? { state: "failed", message: failure.message } : { state: "pending" };
  });
  return (
    <section className="flex flex-col gap-4">
      <PageHeader title="Series" description="A run of related posts generated from one brief." />
      <p className="max-w-2xl text-sm text-muted-foreground">{detail.series.brief}</p>
      <SeriesWriter slug={projectSlug} seriesId={seriesId} angles={detail.angles} initialSlots={initialSlots} />
      <Link href={`/p/${projectSlug}/review`} className="text-sm underline">
        Go to the review queue
      </Link>
    </section>
  );
}
