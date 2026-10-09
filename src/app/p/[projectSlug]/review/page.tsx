import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState } from "@/components/ui/EmptyState";
import { buttonStyles } from "@/components/ui/Button";
import { Pagination } from "@/components/ui/Pagination";
import { forProject, NotFoundError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import { listReviewQueue } from "@/server/services/review";
import { ReviewList } from "./ReviewList";

export const metadata: Metadata = { title: "Review" };
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ projectSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ReviewPage({ params, searchParams }: Props) {
  const { projectSlug } = await params;
  const raw = await searchParams;
  let scope;
  try {
    scope = await forProject(await getSession(), projectSlug);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const rawPage = Array.isArray(raw.page) ? raw.page[0] : raw.page;
  const page = Math.max(1, Number.parseInt(rawPage ?? "1", 10) || 1);
  const queue = await listReviewQueue(scope, { page });

  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Review</h1>
      {queue.items.length === 0 ? (
        <EmptyState
          message="Generated posts wait here for approval before they're scheduled. Posts you write yourself don't come here."
          action={
            scope.can({ generation: ["run"] }) ? (
              <Link href={`/p/${projectSlug}/generate`} className={buttonStyles({ variant: "primary" })}>
                Generate a post
              </Link>
            ) : undefined
          }
        />
      ) : (
        <>
          <ReviewList
            slug={projectSlug}
            items={queue.items}
            canApprove={scope.can({ post: ["edit", "schedule"] })}
            canRegenerate={scope.can({ generation: ["run"], post: ["edit"] })}
          />
          <Pagination
            page={queue.page}
            pageSize={queue.pageSize}
            total={queue.total}
            hrefFor={(n) => `/p/${projectSlug}/review${n > 1 ? `?page=${n}` : ""}`}
          />
        </>
      )}
    </section>
  );
}
