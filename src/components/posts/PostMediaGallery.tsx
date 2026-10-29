"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import type { PostViewMedia } from "@/server/services/posts/view";

type LiveMedia = Extract<PostViewMedia, { deleted: false }>;

/**
 * A post's images as a thumbnail strip, each one opening full screen.
 *
 * The viewer is a native `<dialog>` like `Dialog`, but not `Dialog` itself: this one is a picture
 * on a dimmed field with no panel, no title bar and no padding — a card frame around a photograph
 * is exactly what a full-screen view is for getting rid of — and it owns left/right arrow keys to
 * step through the post's other images, which no other dialog in the app needs. Everything a
 * dialog must do is still done the same way: `showModal()` traps focus, Escape closes, and focus
 * returns to the thumbnail that opened it.
 */
export function PostMediaGallery({ media }: { media: readonly PostViewMedia[] }) {
  const live = media.filter((m): m is LiveMedia => !m.deleted);
  const [openId, setOpenId] = useState<string | null>(null);
  const index = live.findIndex((m) => m.id === openId);
  const current = index === -1 ? null : live[index]!;

  // A plain function, not `useCallback`: `live` is rebuilt on every render, so a dependency array
  // would memoize nothing and the React Compiler bails out on the attempt.
  function step(by: number) {
    if (live.length < 2 || index === -1) return;
    setOpenId(live[(index + by + live.length) % live.length]!.id);
  }

  return (
    <>
      <ul className="flex flex-wrap gap-2">
        {media.map((m) =>
          m.deleted ? (
            <li key={m.id}>
              <span className="inline-flex h-24 w-24 items-center justify-center rounded-lg border border-dashed border-border p-1 text-center text-xs text-muted-foreground">
                Image deleted
              </span>
            </li>
          ) : (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => setOpenId(m.id)}
                className="group relative block overflow-hidden rounded-lg border border-border focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={m.thumbnailUrl} alt={m.altText} className="h-24 w-24 object-cover transition-opacity group-hover:opacity-85" />
                <span className="absolute right-1 bottom-1 rounded bg-foreground/70 p-1 text-background opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                  <Icon name="expand" size={14} />
                </span>
                <span className="sr-only">
                  {m.altText ? `View ${m.altText} full screen` : "View this image full screen"}
                </span>
              </button>
            </li>
          ),
        )}
      </ul>
      {current ? (
        <Lightbox
          media={current}
          position={live.length > 1 ? { index: index + 1, count: live.length } : null}
          onClose={() => setOpenId(null)}
          onStep={step}
        />
      ) : null}
    </>
  );
}

function Lightbox({
  media,
  position,
  onClose,
  onStep,
}: {
  media: LiveMedia;
  position: { index: number; count: number } | null;
  onClose: () => void;
  onStep: (by: number) => void;
}) {
  const [el, setEl] = useState<HTMLDialogElement | null>(null);

  // `showModal()` only on a mounted element, and only once: calling it on an already-open dialog
  // throws, and stepping between images re-renders this component without remounting it.
  useEffect(() => {
    if (el && !el.open) el.showModal();
  }, [el]);

  return (
    <dialog
      ref={setEl}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) el?.close();
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") onStep(1);
        if (e.key === "ArrowLeft") onStep(-1);
      }}
      aria-label={media.altText || "Post image"}
      // No `backdrop:` utilities: the base layer already dims and blurs every dialog's backdrop
      // with a fixed dark scrim. Overriding it with `bg-foreground/80` made the scrim *light* in
      // dark mode, where `foreground` is a near-white — a scrim has to be dark in both themes,
      // which is exactly why that base rule is a fixed colour rather than a token.
      className="m-auto max-h-full max-w-full bg-transparent"
    >
      <div className="flex flex-col items-center gap-3 p-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={media.fullUrl}
          alt={media.altText}
          width={media.width ?? undefined}
          height={media.height ?? undefined}
          className="max-h-[80vh] w-auto max-w-full rounded-lg object-contain"
        />
        <div className="flex items-center gap-3">
          {position ? (
            <>
              <button
                type="button"
                onClick={() => onStep(-1)}
                className="rounded-lg bg-surface p-2 shadow-overlay focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
              >
                <Icon name="arrowLeft" size={18} />
                <span className="sr-only">Previous image</span>
              </button>
              <p className="rounded-lg bg-surface px-3 py-2 text-sm tabular-nums shadow-overlay">
                {position.index} of {position.count}
              </p>
              <button
                type="button"
                onClick={() => onStep(1)}
                className="rounded-lg bg-surface p-2 shadow-overlay focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
              >
                <Icon name="arrowRight" size={18} />
                <span className="sr-only">Next image</span>
              </button>
            </>
          ) : null}
          <button
            type="button"
            onClick={() => el?.close()}
            className="rounded-lg bg-surface px-3 py-2 text-sm font-medium shadow-overlay focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
          >
            Close
          </button>
        </div>
        {media.altText ? (
          <p className="max-w-2xl rounded-lg bg-surface px-3 py-2 text-center text-sm shadow-overlay">{media.altText}</p>
        ) : null}
      </div>
    </dialog>
  );
}
