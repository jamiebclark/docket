import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Checklist } from "@/components/ui/Checklist";
import { PREREQUISITES_TITLE } from "@/lib/roles/prerequisites";
import { getSession } from "@/server/auth/session";
import { forProject, NotFoundError } from "@/server/dal";
import { previewJob } from "@/server/services/jobs";
import { loadPrerequisites } from "../../generate/prerequisites";
import { loadJobFormData } from "./form-data";
import { JobForm } from "./JobForm";

export const metadata: Metadata = { title: "New job" };
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ projectSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const DEFAULT_MEDIA_TEMPLATE = "Write a post about this photo.";

export default async function NewJobPage({ params, searchParams }: Props) {
  const { projectSlug } = await params;
  const raw = await searchParams;
  let scope;
  try {
    scope = await forProject(await getSession(), projectSlug);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  if (!scope.can({ generation: ["run"] })) notFound();
  const base = `/p/${projectSlug}`;
  const mode = one(raw.mode);

  const selection =
    mode === "pick"
      ? { mode: "pick" as const, ids: (one(raw.ids) ?? "").split(",").filter(Boolean) }
      : mode === "filter"
        ? {
            mode: "filter" as const,
            filter: {
              ...(one(raw.tag) ? { tag: one(raw.tag)! } : {}),
              ...(one(raw.missingAlt) === "1" ? { missingAlt: true } : {}),
              ...(one(raw.q) ? { q: one(raw.q)! } : {}),
            },
          }
        : { mode: "unused" as const };
  const includeUsed = mode !== "unused" && one(raw.includeUsed) === "1";
  const heading = <h1 className="text-2xl font-semibold">New job</h1>;

  let preview;
  let images: { message: string } | null = null;
  try {
    preview = await previewJob(scope, { source: { kind: "media", selection, includeUsed } });
    if (preview.itemCount === 0) {
      images = {
        message:
          mode === "unused" || mode === undefined ? "No unused images left to generate for." : "No images to generate for.",
      };
    }
  } catch {
    images = { message: "That selection can't be used. Go back and choose the images again." };
  }

  const prerequisites = await loadPrerequisites(scope, projectSlug, images);
  if (prerequisites || !preview) {
    return (
      <section className="flex flex-col gap-4">
        {heading}
        <Checklist title={PREREQUISITES_TITLE} items={prerequisites ?? []} />
      </section>
    );
  }

  const data = await loadJobFormData(scope);
  const used = preview.excluded.find((e) => e.reason === "already_used")?.count ?? 0;
  const deleted = preview.excluded.find((e) => e.reason === "deleted")?.count ?? 0;
  const toggle = new URLSearchParams(Object.entries(raw).flatMap(([k, v]) => (k === "includeUsed" || v === undefined ? [] : [[k, one(v)!]])));
  if (!includeUsed) toggle.set("includeUsed", "1");

  return (
    <section className="flex flex-col gap-4">
      {heading}
      <JobForm
        slug={projectSlug}
        source={{ kind: "media", selection, includeUsed }}
        summary={
          <div className="flex flex-col gap-1 text-sm">
            <p>{preview.itemCount} {preview.itemCount === 1 ? "image" : "images"} will be generated</p>
            {used > 0 ? <p>{used} already used in posts {used === 1 ? "was" : "were"} left out.</p> : null}
            {mode !== "unused" && (used > 0 || includeUsed) ? (
              <Link href={`${base}/jobs/new?${toggle.toString()}`} className="underline">
                {includeUsed ? "Leave out images already used in posts" : "Include images already used in posts"}
              </Link>
            ) : null}
            {preview.reserved > 0 ? <p>{preview.reserved} {preview.reserved === 1 ? "is" : "are"} waiting in another job and will be skipped.</p> : null}
            {deleted > 0 ? <p>{deleted} {deleted === 1 ? "was" : "were"} deleted.</p> : null}
          </div>
        }
        itemCount={preview.itemCount}
        fields={preview.fields}
        firstFields={preview.first?.fields ?? null}
        emptyByField={preview.emptyByField}
        defaultTemplate={DEFAULT_MEDIA_TEMPLATE}
        {...data}
      />
    </section>
  );
}
