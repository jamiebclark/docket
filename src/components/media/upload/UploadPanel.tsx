"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/Button";
import { LiveRegion } from "@/components/ui/LiveRegion";
import {
  createUploadEngine,
  type EngineEvent,
  type UploadActions,
  type UploadEngine,
  type UploadRowState,
} from "@/lib/upload/engine";
import { xhrTransport } from "@/lib/upload/xhr-transport";
import type { LibraryLimits } from "@/server/media/limits";
import type { MediaView } from "@/server/services/media";
import {
  cancelUploadAction,
  completeUploadAction,
  createUploadAction,
  listUploadedPartsAction,
  mediaProcessingStatusAction,
  signUploadPartsAction,
} from "@/app/p/[projectSlug]/media/upload-actions";
import { readHead, readVideo } from "./read-video";
import { UploadRow } from "./UploadRow";
import { ANNOUNCE_WINDOW_MS, acceptAttribute, announcementFor, helpText, joinAnnouncements, limitsIdentity } from "./upload-ui";

export interface UploadPanelProps {
  slug: string;
  limits: LibraryLimits;
  /** False when media storage is not set up. */
  enabled?: boolean;
  /** Runs when an upload completes, whatever its processing state (D8). */
  onUploaded?: (asset: MediaView) => void;
  /** Runs when a processing video becomes ready, with the finished item. */
  onReady?: (asset: MediaView) => void;
  /** Library: refresh the page once the batch is finished so new items appear. Default true. */
  refreshWhenDone?: boolean;
}

/** The presentational half: everything it shows comes from its props, so it renders on the server in tests. */
export function UploadPanelView({
  limits,
  rows,
  announcement,
  over = false,
  busy = false,
  inputRef,
  onChoose,
  onFiles,
  onDragOver,
  onDragLeave,
  actions,
}: {
  limits: LibraryLimits;
  rows: readonly UploadRowState[];
  announcement: string;
  over?: boolean;
  busy?: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
  onChoose?: () => void;
  onFiles?: (files: File[]) => void;
  onDragOver?: () => void;
  onDragLeave?: () => void;
  actions: { onRetry(id: string): void; onCancel(id: string): void; onDismiss(id: string): void };
}) {
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        onDragOver?.();
      }}
      onDragLeave={() => onDragLeave?.()}
      onDrop={(e) => {
        e.preventDefault();
        onFiles?.([...e.dataTransfer.files]);
      }}
      className={`flex flex-col gap-3 rounded-lg border border-dashed p-4 ${over ? "border-primary bg-muted" : "border-input"}`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={acceptAttribute(limits)}
          className="sr-only"
          aria-label="Image or video files"
          tabIndex={-1}
          onChange={(e) => {
            onFiles?.([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <Button pending={busy} pendingLabel="Uploading…" onClick={onChoose}>
          Choose files
        </Button>
        <p className="text-sm">{helpText(limits)}</p>
      </div>
      <LiveRegion message={announcement} />
      {rows.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <UploadRow key={row.id} row={row} limits={limits} actions={actions} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const browserClock = {
  setTimeout: (fn: () => void, ms: number) => window.setTimeout(fn, ms),
  clearTimeout: (h: unknown) => window.clearTimeout(h as number),
};

/** The one upload component of the library and the picker (P29). */
export function UploadPanel({ slug, limits, enabled = true, onUploaded, onReady, refreshWhenDone = true }: UploadPanelProps) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const pending = useRef<string[]>([]);
  const flushTimer = useRef<number | null>(null);
  const handlers = useRef({ onUploaded, onReady });
  useEffect(() => {
    handlers.current = { onUploaded, onReady };
  });
  const readyCount = useRef(0);

  // The server re-renders hand down an equal but new `limits` object; the engine (and its rows) must outlive that.
  const limitsKey = limitsIdentity(limits);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableLimits = useMemo(() => limits, [limitsKey]);

  const engine = useMemo<UploadEngine>(() => {
    const actions: UploadActions<MediaView> = {
      createUpload: (i) => createUploadAction(slug, i),
      signUploadParts: (i) => signUploadPartsAction(slug, i),
      listUploadedParts: (i) => listUploadedPartsAction(slug, i),
      completeUpload: (i) => completeUploadAction(slug, i) as ReturnType<UploadActions<MediaView>["completeUpload"]>,
      cancelUpload: (i) => cancelUploadAction(slug, i),
      status: (i) => mediaProcessingStatusAction(slug, i) as ReturnType<UploadActions<MediaView>["status"]>,
    };
    const announce = (message: string) => {
      pending.current.push(message);
      if (flushTimer.current !== null) return;
      flushTimer.current = window.setTimeout(() => {
        flushTimer.current = null;
        setAnnouncement(joinAnnouncements(pending.current));
        pending.current = [];
      }, ANNOUNCE_WINDOW_MS);
    };
    return createUploadEngine<MediaView>({
      actions,
      transport: xhrTransport,
      readVideo,
      readHead,
      limits: stableLimits,
      clock: browserClock,
      onEvent(event: EngineEvent<MediaView>) {
        announce(announcementFor(event, stableLimits));
        if (event.type === "uploaded") handlers.current.onUploaded?.(event.asset);
        if (event.type === "ready") {
          readyCount.current++;
          if (event.asset) handlers.current.onReady?.(event.asset);
        }
      },
    });
  }, [slug, stableLimits]);

  const rows = useSyncExternalStore(engine.subscribe, engine.snapshot, engine.snapshot);

  // Leaving the page loses the file in flight; open sessions expire on the server (FR-012, P2).
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (engine.active()) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [engine, rows]);

  // One refresh per batch, when the last row is terminal, so new items appear in the grid.
  useEffect(() => {
    const settled = rows.length > 0 && rows.every((r) => ["ready", "failed", "refused", "cancelled"].includes(r.state));
    if (refreshWhenDone && settled && readyCount.current > 0) {
      readyCount.current = 0;
      router.refresh();
    }
  }, [rows, refreshWhenDone, router]);

  if (!enabled) {
    return <p className="text-sm">Uploads are unavailable: media storage is not set up.</p>;
  }

  return (
    <UploadPanelView
      limits={limits}
      rows={rows}
      announcement={announcement}
      over={over}
      busy={engine.active()}
      inputRef={input}
      onChoose={() => input.current?.click()}
      onFiles={(files) => {
        setOver(false);
        engine.add(files);
      }}
      onDragOver={() => setOver(true)}
      onDragLeave={() => setOver(false)}
      actions={{
        onRetry: engine.retry,
        onCancel: engine.cancel,
        onDismiss: engine.dismiss,
      }}
    />
  );
}
