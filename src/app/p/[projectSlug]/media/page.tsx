import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MediaCard } from "@/components/media/MediaCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { FilterTabs } from "@/components/ui/FilterTabs";
import { Pagination } from "@/components/ui/Pagination";
import { firstParam, mediaSearchParamsSchema, toMediaListInput, type MediaSearchParams } from "@/lib/validation/media";
import { forProject, NotFoundError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import * as media from "@/server/services/media";
import { MediaCardActions } from "./MediaCardActions";
import { UploadDropzone } from "./UploadDropzone";

export const metadata: Metadata = { title: "Media" };
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ projectSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function hrefFor(slug: string, f: MediaSearchParams, page?: number): string {
  const qs = new URLSearchParams();
  if (f.tag) qs.set("tag", f.tag);
  if (f.unused) qs.set("unused", "1");
  if (f.missingAlt) qs.set("missingAlt", "1");
  if (f.q) qs.set("q", f.q);
  if (page && page > 1) qs.set("page", String(page));
  const s = qs.toString();
  return `/p/${slug}/media${s ? `?${s}` : ""}`;
}

export default async function MediaPage({ params, searchParams }: Props) {
  const { projectSlug } = await params;
  const raw = await searchParams;
  const filter = mediaSearchParamsSchema.parse(Object.fromEntries(Object.keys(raw).map((k) => [k, firstParam(raw[k])])));
  let scope;
  try {
    scope = await forProject(await getSession(), projectSlug);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const status = await media.mediaStatus(scope);
  const canEdit = scope.can({ media: ["edit"] });
  const filtered = !!(filter.tag || filter.unused || filter.missingAlt || filter.q);
  let list: Awaited<ReturnType<typeof media.listMedia>> | null = null;
  let failed = false;
  try {
    list = await media.listMedia(scope, toMediaListInput(filter));
  } catch {
    failed = true;
  }

  const tabs = [
    { label: "All", href: hrefFor(projectSlug, {}), active: !filtered },
    { label: "Unused", href: hrefFor(projectSlug, { unused: "1" }), active: !!filter.unused && !filter.tag && !filter.missingAlt },
    { label: "Missing alt text", href: hrefFor(projectSlug, { missingAlt: "1" }), active: !!filter.missingAlt && !filter.tag && !filter.unused },
    ...(list?.tags ?? []).map((t) => ({ label: t, href: hrefFor(projectSlug, { tag: t }), active: filter.tag === t })),
  ];

  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Media</h1>
      {!status.enabled ? (
        <EmptyState message="Media storage is not set up. Ask an administrator to configure S3-compatible storage, then you can upload images here." />
      ) : (
        <>
          {canEdit ? <UploadDropzone slug={projectSlug} maxMegabytes={Math.floor(status.maxUploadBytes / 1024 / 1024)} /> : null}
          <form action={`/p/${projectSlug}/media`} method="get" role="search" className="flex gap-2">
            <label htmlFor="media-q" className="sr-only">
              Search media
            </label>
            <input
              id="media-q"
              name="q"
              defaultValue={filter.q ?? ""}
              placeholder="Search alt text or file name"
              className="w-full max-w-sm rounded-md border border-foreground/40 bg-background px-3 py-1.5 text-sm"
            />
            <button type="submit" className="rounded-md border border-foreground/30 px-3 py-1.5 text-sm hover:bg-foreground/10">
              Search
            </button>
          </form>
          <FilterTabs label="Filter media" tabs={tabs} />
          {failed || !list ? (
            <p role="alert" className="text-sm text-red-700 dark:text-red-400">
              The library could not be loaded. Reload the page to try again.
            </p>
          ) : list.items.length === 0 ? (
            <EmptyState message={filtered ? "No images match these filters." : "No images yet. Upload your first image above."} />
          ) : (
            <>
              <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {list.items.map((item) => (
                  <li key={item.id}>
                    <MediaCard item={item} actions={canEdit ? <MediaCardActions slug={projectSlug} item={item} /> : null} />
                  </li>
                ))}
              </ul>
              <Pagination
                page={list.page}
                pageSize={media.MEDIA_PAGE_SIZE}
                total={list.total}
                hrefFor={(p) => hrefFor(projectSlug, filter, p)}
              />
            </>
          )}
        </>
      )}
    </section>
  );
}
