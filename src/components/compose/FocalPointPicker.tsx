"use client";

import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { LiveRegion } from "@/components/ui/LiveRegion";
import { focalFromKey, focalFromPointer, focalText, type Focal } from "./video-edit-ui";

/**
 * Where to keep when Docket crops a video: the poster frame with a marker. Click or drag on the image, or focus the marker and
 * use the arrow keys (5%, Shift 1%) and Home to centre. The picker never traps focus.
 */
export function FocalPointPicker({
  src,
  alt,
  value,
  onChange,
}: {
  /** The poster (rotation already applied). */
  src: string;
  alt: string;
  value: Focal;
  onChange: (value: Focal) => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [announcement, setAnnouncement] = useState("");

  const move = (next: Focal) => {
    onChange(next);
    setAnnouncement(focalText(next));
  };

  const fromPointer = (e: PointerEvent) => {
    const box = frame.current?.getBoundingClientRect();
    if (box) move(focalFromPointer(e.clientX, e.clientY, box));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const next = focalFromKey(value, e.key, e.shiftKey);
    if (!next) return;
    e.preventDefault();
    move(next);
  };

  return (
    <div>
      <div
        ref={frame}
        className="relative inline-block max-w-full touch-none select-none overflow-hidden rounded-lg border border-border"
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          fromPointer(e);
        }}
        onPointerMove={(e) => {
          if (dragging.current) fromPointer(e);
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- a stored poster at its own size */}
        <img src={src} alt={alt} draggable={false} className="block max-h-64 max-w-full" />
        <div
          role="slider"
          tabIndex={0}
          aria-label="Focal point"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(value.x * 100)}
          aria-valuetext={focalText(value)}
          onKeyDown={onKeyDown}
          style={{ left: `${value.x * 100}%`, top: `${value.y * 100}%` }}
          className="absolute size-6 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-2 border-white bg-primary/70 shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
        />
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{focalText(value)}</p>
      <LiveRegion message={announcement} />
    </div>
  );
}
