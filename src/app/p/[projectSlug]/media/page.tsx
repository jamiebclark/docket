import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MediaCard } from "@/components/media/MediaCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { FilterTabs } from "@/components/ui/FilterTabs";
import { Pagination } from "@/components/ui/Pagination";
import { firstParam, mediaSearchParamsSchema, toMediaListInput, type MediaSearchParams } from "@/lib/validation/media";
import { forProject, NotFoundError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import * as media from "@/server/services/media";
import { MediaSelection, SelectBox } from "./MediaSelection";
import { MediaCardActions } from "./MediaCardActions";
import { UploadDropzone } from "./UploadDropzone";
import { buttonStyles } from "@/components/ui/Button";
import { controlStyles } from "@/components/ui/controls";
import { alertStyles } from "@/components/ui/Alert";
import { docsUrl } from "@/lib/docs";
import { askOwners } from "@/lib/roles/names";
import { listManagers } from "@/server/services/members";

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

const GENERATE_ALL_CAP = 500; // limit-literal-ok: the batch cap for "generate for all", not a platform limit

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
  const canGenerate = scope.can({ generation: ["run"] });
  const unusedCount = canGenerate && status.enabled ? (await scope.media.listIdsForSelection({ unusedOnly: true, limit: 501 })).length : 0;
  const filtered = !!(filter.tag || filter.unused || filter.missingAlt || filter.q);
  let list: Awaited<ReturnType<typeof media.listMedia>> | null = null;
  let failed = false;
  try {
    list = await media.listMedia(scope, { ...toMediaListInput(filter), fit: { active: true } });
  } catch {
    failed = true;
  }

  const tabs = [
    { label: "All", href: hrefFor(projectSlug, {}), active: !filtered },
    { label: "Unused", href: hrefFor(projectSlug, { unused: "1" }), active: !!filter.unused && !filter.tag && !filter.missingAlt },
    { label: "Missing alt text", href: hrefFor(projectSlug, { missingAlt: "1" }), active: !!filter.missingAlt && !filter.tag && !filter.unused },
    ...(list?.tags ?? []).map((t) => ({ label: t, href: hrefFor(projectSlug, { tag: t }), active: filter.tag === t })),
  ];

  const isOwner = scope.membership.role === "owner";
  const libraryEmpty = !failed && !!list && list.total === 0 && !filtered;

  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Media</h1>
      {!status.enabled ? (
        <EmptyState
          message={`Media storage is not set up, so images and videos can't be uploaded yet.${
            isOwner ? "" : ` Ask ${askOwners(await listManagers(scope), "or")} to set it up.`
          }`}
          action={
            isOwner ? (
              <a href={docsUrl("storage")} target="_blank" rel="noreferrer" className={buttonStyles({ variant: "primary" })}>
                Set up storage
              </a>
            ) : undefined
          }
        />
      ) : libraryEmpty ? (
        <>
          {canEdit ? <UploadDropzone slug={projectSlug} limits={status.limits} /> : null}
          <EmptyState message={canEdit ? "No images or videos yet. Upload your first one above." : "No images or videos yet."} />
        </>
      ) : (
        <>
          {canEdit ? <UploadDropzone slug={projectSlug} limits={status.limits} /> : null}
          <form action={`/p/${projectSlug}/media`} method="get" role="search" className="flex gap-2">
            <label htmlFor="media-q" className="sr-only">
              Search media
            </label>
            <input
              id="media-q"
              name="q"
              defaultValue={filter.q ?? ""}
              placeholder="Search alt text or file name"
              className={`${controlStyles} w-full max-w-sm`}
            />
            <button type="submit" className={buttonStyles({ variant: "secondary" })}>
              Search
            </button>
          </form>
          <FilterTabs label="Filter media" tabs={tabs} />
          {canGenerate ? (
            unusedCount > 0 ? (
              <Link
                href={`/p/${projectSlug}/jobs/new?source=media&mode=unused`}
                className={buttonStyles({ variant: "primary", className: "self-start" })}
              >
                Generate for all unused images ({unusedCount > GENERATE_ALL_CAP ? `${GENERATE_ALL_CAP}+` : unusedCount})
              </Link>
            ) : (
              <p className={`${alertStyles("info")} self-start`}>No unused images to generate for</p>
            )
          ) : null}
          {canGenerate && (filter.tag || filter.missingAlt || filter.q) && list && list.total > 0 ? (
            // FR-028: generate for the current filter or tag, not only checked images (F1).
            <Link
              href={`/p/${projectSlug}/jobs/new?${new URLSearchParams({
                source: "media",
                mode: "filter",
                ...(filter.tag ? { tag: filter.tag } : {}),
                ...(filter.missingAlt ? { missingAlt: "1" } : {}),
                ...(filter.q ? { q: filter.q } : {}),
              }).toString()}`}
              className={buttonStyles({ variant: "secondary", className: "self-start" })}
            >
              Generate posts for these {list.total} images
            </Link>
          ) : null}
          {failed || !list ? (
            <p role="alert" className="text-sm text-danger">
              The library could not be loaded. Reload the page to try again.
            </p>
          ) : list.items.length === 0 ? (
            <EmptyState message={filtered ? "No images or videos match these filters." : "No images or videos yet."} />
          ) : (
            <MediaSelection slug={projectSlug}>
              <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {list.items.map((item) => (
                  <li key={item.id}>
                    <MediaCard
                      item={item}
                      {...(item.fit ? { fit: item.fit } : {})}
                      actions={canEdit ? <MediaCardActions slug={projectSlug} item={item} /> : null}
                      select={canGenerate && !item.reservedByJobId ? <SelectBox id={item.id} label={item.originalFilename ?? "image"} /> : null}
                      jobHref={(jobId) => `/p/${projectSlug}/jobs/${jobId}`}
                    />
                  </li>
                ))}
              </ul>
              <Pagination
                page={list.page}
                pageSize={media.MEDIA_PAGE_SIZE}
                total={list.total}
                hrefFor={(p) => hrefFor(projectSlug, filter, p)}
              />
            </MediaSelection>
          )}
        </>
      )}
    </section>
  );
}
