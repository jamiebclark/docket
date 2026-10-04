import Link from "next/link";
import type { ReactNode } from "react";
import type { MediaView } from "@/server/services/media";
import { Badge } from "../ui/Badge";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const TYPE_LABEL: Record<string, string> = { "image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WebP" };

/**
 * One library item. `actions` is where the client-side edit/delete controls go; `select` is the selection
 * checkbox slot; `jobHref` links the "In a job" badge to the job holding the image.
 */
export function MediaCard({
  item,
  actions,
  select,
  jobHref,
}: {
  item: MediaView;
  actions?: ReactNode;
  select?: ReactNode;
  jobHref?: (jobId: string) => string;
}) {
  const dims = item.width && item.height ? `${item.width}×${item.height}` : null;
  return (
    <article className="flex flex-col gap-2 rounded-lg border border-foreground/30 p-3">
      {select}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={item.thumbnailUrl}
        alt={item.altText || ""}
        loading="lazy"
        className="aspect-square w-full rounded bg-foreground/5 object-cover"
      />
      <p className="text-xs text-foreground/70">
        {[dims, formatBytes(item.byteSize), TYPE_LABEL[item.mimeType] ?? item.mimeType].filter(Boolean).join(" · ")}
      </p>
      {item.originalFilename ? <p className="truncate text-sm font-medium">{item.originalFilename}</p> : null}
      <div className="flex flex-wrap gap-1">
        <Badge tone={item.inUse ? "success" : "neutral"}>{item.inUse ? "In use" : "Unused"}</Badge>
        {item.reservedByJobId ? (
          <Link href={jobHref ? jobHref(item.reservedByJobId) : `/jobs/${item.reservedByJobId}`} className="rounded">
            <Badge tone="warning">In a job</Badge>
          </Link>
        ) : null}
        {item.missingAlt ? <Badge tone="warning">Missing alt text</Badge> : null}
      </div>
      {item.tags.length > 0 ? (
        <ul aria-label="Tags" className="flex flex-wrap gap-1 text-xs">
          {item.tags.map((t) => (
            <li key={t} className="rounded bg-foreground/10 px-1.5 py-0.5">
              {t}
            </li>
          ))}
        </ul>
      ) : null}
      {actions}
    </article>
  );
}
