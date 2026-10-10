"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { Icon } from "./Icon";

/**
 * Confirm dialog on native `<dialog>`: showModal() traps focus and Escape
 * closes it; focus returns to the previously focused element on close.
 * Name the thing being destroyed in `title`/`children`.
 *
 * Three ways out, all through the element's own `close()` so they share the
 * focus-return path: the Close button in the header, Escape, and a click on
 * the backdrop (`dismissOnBackdrop`, off for dialogs holding unsaved input).
 */
export function Dialog({
  open,
  onClose,
  title,
  returnFocus = true,
  size = "md",
  dismissOnBackdrop = true,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Set false when the opener is going away; the caller then places focus itself. */
  returnFocus?: boolean;
  /** `lg` for a dialog hosting a whole form; it also scrolls rather than growing past the viewport. */
  size?: "md" | "lg";
  /** Set false when the dialog holds work a stray click must not throw away (the composer). */
  dismissOnBackdrop?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const titleId = useId();
  // The `close` event fires after the render that set `returnFocus`, so read it through a ref.
  const returnFocusRef = useRef(returnFocus);
  // True only when the press that started this click landed on the backdrop, so selecting text and
  // releasing outside the panel does not close the dialog.
  const pressedBackdrop = useRef(false);

  useEffect(() => {
    returnFocusRef.current = returnFocus;
  }, [returnFocus]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      returnTo.current = document.activeElement as HTMLElement | null;
      el.showModal();
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);

  // A caller that stops rendering the dialog instead of setting `open` to false unmounts the
  // element while it is still open, and an unmounted `<dialog>` fires no `close` event — so the
  // restore above never runs and focus falls to `<body>`. Restore it here on the way out.
  useEffect(() => {
    const el = ref.current;
    return () => {
      if (el?.open && returnFocusRef.current) returnTo.current?.focus();
    };
  }, []);

  /** A press on the backdrop: the event's target is the dialog itself and the point is outside its box. */
  const onBackdrop = (e: { target: EventTarget | null; clientX: number; clientY: number }) => {
    const el = ref.current;
    if (!el || e.target !== el) return false;
    const r = el.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={() => {
        if (returnFocusRef.current) returnTo.current?.focus();
        onClose();
      }}
      onMouseDown={(e) => {
        pressedBackdrop.current = dismissOnBackdrop && onBackdrop(e);
      }}
      onClick={(e) => {
        if (pressedBackdrop.current && onBackdrop(e)) ref.current?.close();
        pressedBackdrop.current = false;
      }}
      className={`m-auto w-[calc(100%-2rem)] rounded-2xl border border-border bg-surface text-foreground shadow-overlay ${
        size === "lg" ? "max-h-[calc(100dvh-4rem)] max-w-3xl overflow-y-auto p-0" : "max-w-md p-6"
      }`}
    >
      {/*
       * In a scrolling dialog the header stays put, so Close is always one click away. The padding
       * lives on the header and the body rather than on the <dialog>: a scroll container with its
       * own top padding leaves a band above a `top-0` sticky child that content scrolls through, so
       * cards slid visibly over the title. With no padding on the scrollport the header really does
       * sit at the top.
       */}
      <div
        className={`flex items-start justify-between gap-3 ${
          size === "lg" ? "sticky top-0 z-10 border-b border-border bg-surface px-6 pt-6 pb-3" : "mb-3"
        }`}
      >
        <h2 id={titleId} className="text-lg font-semibold text-heading">
          {title}
        </h2>
        <button
          type="button"
          onClick={() => ref.current?.close()}
          className="-mt-1 -mr-1 inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <Icon name="close" size={18} />
          <span className="sr-only">Close</span>
        </button>
      </div>
      {size === "lg" ? <div className="px-6 pt-4 pb-6">{children}</div> : children}
    </dialog>
  );
}
