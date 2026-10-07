import Link from "next/link";
import type { ReactNode } from "react";
import { MIME_LABEL } from "@/lib/media/types";
import type { MediaView } from "@/server/services/media";
import type { PlatformFit } from "@/server/services/media-fit";
import { Badge } from "../ui/Badge";
import { FitBadges } from "./FitBadges";

const STEP_LABEL = {
  queued: "Waiting to be processed",
  probing: "Checking the video",
  poster: "Making the poster",
} as const;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * One library item. `actions` is where the client-side edit/delete controls go; `select` is the selection
 * checkbox slot; `jobHref` links the "In a job" badge to the job holding the image.
 */
export function MediaCard({
  item,
  actions,
  select,
  jobHref,
  fit,
}: {
  item: MediaView;
  actions?: ReactNode;
  select?: ReactNode;
  jobHref?: (jobId: string) => string;
  fit?: readonly PlatformFit[];
}) {
  const dims = item.width && item.height ? `${item.width}×${item.height}` : null;
  const isVideo = item.kind === "video";
  const kindLabel = item.video ? item.video.labels.container : (MIME_LABEL[item.mimeType] ?? item.mimeType);
  const facts = [dims, item.video?.labels.duration, formatBytes(item.byteSize), kindLabel];
  return (
    <article className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-3 shadow-card">
      {select}
      {item.video ? (
        <video
          src={item.publicUrl}
          poster={item.thumbnailUrl}
          controls
          preload="none"
          aria-label={item.altText || item.originalFilename || "Video"}
          className="aspect-square w-full rounded bg-muted object-contain"
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={item.thumbnailUrl}
          alt={isVideo ? "" : item.altText || ""}
          loading="lazy"
          className="aspect-square w-full rounded bg-muted object-cover"
        />
      )}
      <p className="text-xs text-muted-foreground">{facts.filter(Boolean).join(" · ")}</p>
      {item.video ? (
        <p className="text-xs text-muted-foreground">
          {[item.video.labels.videoCodec, item.video.labels.audioCodec, item.video.labels.frameRate].filter(Boolean).join(" · ")}
        </p>
      ) : null}
      {item.status === "processing" ? (
        <div role="status">
          <Badge tone="info">Processing</Badge>
          <p className="mt-1 text-xs text-muted-foreground">{item.processingStep ? STEP_LABEL[item.processingStep] : ""}</p>
        </div>
      ) : null}
      {item.status === "failed" ? (
        <div role="alert">
          <Badge tone="danger">Failed</Badge>
          <p className="mt-1 text-xs text-danger">{item.processingError}</p>
        </div>
      ) : null}
      {item.originalFilename ? <p className="truncate text-sm font-medium">{item.originalFilename}</p> : null}
      <div className="flex flex-wrap gap-1">
        <Badge tone={item.inUse ? "success" : "neutral"}>{item.inUse ? "In use" : "Unused"}</Badge>
        {item.reservedByJobId ? (
          <Link href={jobHref ? jobHref(item.reservedByJobId) : `/jobs/${item.reservedByJobId}`} className="rounded">
            <Badge tone="warning">In a job</Badge>
          </Link>
        ) : null}
        {item.missingAlt && item.status === "ready" ? <Badge tone="warning">Missing alt text</Badge> : null}
      </div>
      {fit && item.status === "ready" ? <FitBadges fit={fit} /> : null}
      {fit && item.status !== "ready" ? (
        <p className="text-xs text-muted-foreground">Badges appear when processing finishes</p>
      ) : null}
      {item.tags.length > 0 ? (
        <ul aria-label="Tags" className="flex flex-wrap gap-1 text-xs">
          {item.tags.map((t) => (
            <li key={t} className="rounded bg-muted px-1.5 py-0.5">
              {t}
            </li>
          ))}
        </ul>
      ) : null}
      {actions}
    </article>
  );
}
