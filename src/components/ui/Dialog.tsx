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
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Set false when the opener is going away; the caller then places focus itself. */
  returnFocus?: boolean;
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

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={() => {
        if (returnFocusRef.current) returnTo.current?.focus();
        onClose();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl border border-border bg-surface p-6 text-foreground shadow-overlay"
    >
      <h2 id={titleId} className="mb-3 text-lg font-semibold text-heading">
        {title}
      </h2>
      {children}
    </dialog>
  );
}
