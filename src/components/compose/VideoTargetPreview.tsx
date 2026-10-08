"use client";

import { useEffect, useRef, useState } from "react";
import { requestVideoPreviewsAction, videoPreviewStatusAction } from "@/app/p/[projectSlug]/compose/actions";
import { Button } from "@/components/ui/Button";
import { LiveRegion } from "@/components/ui/LiveRegion";
import type { TargetCheck } from "@/server/services/posts";

type VideoTargetView = TargetCheck["videos"][number];

type Render = Extract<NonNullable<VideoTargetView["preview"]>, { kind: "render" }>;
type Live = Pick<Render, "state" | "url" | "error">;

const POLL_MS = 2000;
const DEBOUNCE_MS = 800;

/** The collapsed line: what Docket will do with this video for this target (contracts/video-composer.md). */
export function summaryLine(v: Pick<VideoTargetView, "plan" | "steps" | "reasons">): string {
  switch (v.plan) {
    case "as_is":
      return "Fits as is";
    case "rewrap":
      return "Rewrapped as MP4 (no visible change)";
    case "adapted":
      return `Will be adapted: ${v.steps.join(", ")}`;
    case "refused":
      return `Will be refused: ${v.reasons[0] ?? "it does not fit this account"}`;
    default:
      return "Checking the video's details…";
  }
}

/**
 * Per-target preview of each video (FR-028, US4). Opening requests the ≤ 640 px renders, an edit while open requests again
 * (debounced), and polling runs only while one is queued or building. Never part of scheduling.
 */
export function VideoTargetPreview({
  slug,
  videos,
  requestInput,
  disabled = false,
}: {
  slug: string;
  videos: VideoTargetView[];
  /** The composer state (post id, text, media, edits, targets) a preview is requested for. */
  requestInput: Record<string, unknown>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [live, setLive] = useState<Record<string, Live>>({});
  const [announce, setAnnounce] = useState("");
  const requested = useRef("");
  const payload = JSON.stringify(requestInput);

  const request = async (retry: boolean) => {
    const res = await requestVideoPreviewsAction(slug, { ...JSON.parse(payload), ...(retry ? { retry: true } : {}) });
    if (res.ok) setLive((cur) => ({ ...cur, ...Object.fromEntries(res.data.previews.map((p) => [p.key, p])) }));
  };

  // Opening requests; an edit while open requests again after a pause. A new key is a new preview, so the old one just drops away.
  const wantsRender = videos.some((v) => v.plan === "adapted");
  useEffect(() => {
    if (!open || !wantsRender || disabled || requested.current === payload) return;
    const timer = setTimeout(() => {
      requested.current = payload;
      void request(false);
    }, requested.current === "" ? 0 : DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, wantsRender, disabled, payload]);

  const stateOf = (r: Render): Live => live[r.key] ?? r;
  const pollId = open
    ? videos
        .flatMap((v) => (v.preview?.kind === "render" ? [v.preview] : []))
        .filter((r) => ["queued", "building"].includes(stateOf(r).state))
        .map((r) => r.key)
        .join(",")
    : "";
  useEffect(() => {
    if (!pollId) return;
    const timer = setInterval(async () => {
      const res = await videoPreviewStatusAction(slug, { keys: pollId.split(",") });
      if (!res.ok) return;
      setLive((cur) => ({ ...cur, ...Object.fromEntries(res.data.previews.map((p) => [p.key, p])) }));
      if (res.data.previews.some((p) => p.state === "ready")) setAnnounce("Preview ready.");
      else if (res.data.previews.some((p) => p.state === "failed")) setAnnounce("A preview could not be prepared.");
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [pollId, slug]);

  if (videos.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-1 text-xs">
      <ul className="flex flex-col gap-0.5">
        {videos.map((v) => (
          <li key={v.mediaId}>
            <span className="font-medium">Video {v.index + 1}:</span> {summaryLine(v)}
            {v.output ? <span className="text-muted-foreground"> · {v.output.durationLabel}, {v.output.sizeLabel}</span> : null}
          </li>
        ))}
      </ul>
      <div>
        <Button type="button" variant="secondary" size="sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "Hide preview" : "Preview"}
        </Button>
      </div>
      {open ? (
        <div className="flex flex-col gap-2">
          {videos.map((v) => (
            <div key={v.mediaId} className="flex flex-col gap-1">
              <VideoRow v={v} live={v.preview?.kind === "render" ? stateOf(v.preview) : null} onRetry={() => void request(true)} />
            </div>
          ))}
        </div>
      ) : null}
      <LiveRegion message={announce} />
    </div>
  );
}

function VideoRow({ v, live, onRetry }: { v: VideoTargetView; live: Live | null; onRetry: () => void }) {
  const heading = <p className="font-medium">Video {v.index + 1}</p>;
  if (v.plan === "refused") {
    return (
      <div>
        {heading}
        <ul className="list-disc pl-4">{v.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
      </div>
    );
  }
  if (v.plan === "checking") {
    return (
      <div>
        {heading}
        <p role="status">Docket is still reading this video&apos;s details.</p>
      </div>
    );
  }
  if (v.preview?.kind === "original") {
    return (
      <div>
        {heading}
        <video controls preload="metadata" src={v.preview.url} poster={v.preview.posterUrl ?? undefined} className="max-h-64 max-w-full rounded" />
        <p>{summaryLine(v)}</p>
      </div>
    );
  }
  const state = live?.state ?? "none";
  return (
    <div>
      {heading}
      {state === "ready" && live?.url ? (
        <>
          <video controls preload="metadata" src={live.url} className="max-h-64 max-w-full rounded" />
          <p>
            {v.output ? `${v.output.durationLabel}, ${v.output.sizeLabel}. ` : ""}
            {v.steps.join(", ")}
          </p>
        </>
      ) : state === "failed" ? (
        <div className="flex flex-col items-start gap-1">
          <p role="alert">{live?.error ?? "The preview could not be prepared."}</p>
          <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : (
        <p role="status">Preparing preview…</p>
      )}
    </div>
  );
}
