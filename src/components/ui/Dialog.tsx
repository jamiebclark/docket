"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * Confirm dialog on native `<dialog>`: showModal() traps focus and Escape
 * closes it; focus returns to the previously focused element on close.
 * Name the thing being destroyed in `title`/`children`.
 */
export function Dialog({
  open,
  onClose,
  title,
  returnFocus = true,
  size = "md",
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Set false when the opener is going away; the caller then places focus itself. */
  returnFocus?: boolean;
  /** `lg` for a dialog hosting a whole form; it also scrolls rather than growing past the viewport. */
  size?: "md" | "lg";
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const titleId = useId();
  // The `close` event fires after the render that set `returnFocus`, so read it through a ref.
  const returnFocusRef = useRef(returnFocus);

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

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={() => {
        if (returnFocusRef.current) returnTo.current?.focus();
        onClose();
      }}
      className={`m-auto w-[calc(100%-2rem)] rounded-2xl border border-border bg-surface p-6 text-foreground shadow-overlay ${
        size === "lg" ? "max-h-[calc(100dvh-4rem)] max-w-3xl overflow-y-auto" : "max-w-md"
      }`}
    >
      <h2 id={titleId} className="mb-3 text-lg font-semibold text-heading">
        {title}
      </h2>
      {children}
    </dialog>
  );
}
