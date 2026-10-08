"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { NotificationPanel } from "@/components/notifications/NotificationPanel";
import { browserPollEnv, startPolling } from "@/components/notifications/poll";
import { Icon } from "@/components/ui/Icon";
import type { UnreadSummary } from "@/lib/notifications/types";

const LINK_CLASS =
  "relative inline-flex h-9 items-center gap-2 rounded-lg px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

const noopSubscribe = () => () => {};

/** True once hydrated: until then (and with no JavaScript) the bell is a plain link to /notifications. */
function useHydrated(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

/** The bell. A link to /notifications that JavaScript turns into a button opening the recent-problems panel. */
export function NotificationBellClient({ initial }: { initial: UnreadSummary }) {
  const hydrated = useHydrated();
  // A newer count from the panel wins until the server renders a fresh `initial`.
  const [override, setOverride] = useState<{ base: UnreadSummary; value: UnreadSummary } | null>(null);
  const summary = override && override.base === initial ? override.value : initial;
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const onSummary = useCallback((value: UnreadSummary) => setOverride({ base: initial, value }), [initial]);
  const [announcement, setAnnouncement] = useState("");
  const initialCount = useRef(summary.count);
  useEffect(() => {
    initialCount.current = summary.count;
  }, [summary.count]);

  // Visible-only 60 s refresh of the count; never refreshes the page (no router.refresh()).
  useEffect(() => {
    if (!hydrated) return;
    return startPolling(initialCount.current, browserPollEnv(), {
      onSummary,
      onAnnounce: (value) => setAnnouncement(value.label),
    });
  }, [hydrated, onSummary]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onFocusIn = (event: FocusEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [open]);

  const children = (
    <>
      <Icon name="bell" />
      {summary.count > 0 && (
        <span aria-hidden="true" className="rounded-full bg-cta px-1.5 py-0.5 text-xs font-semibold text-cta-foreground tabular-nums">
          {summary.display}
        </span>
      )}
      <span className="sr-only">{summary.label}</span>
    </>
  );

  if (!hydrated) {
    return (
      <a href="/notifications" title={summary.label} className={LINK_CLASS}>
        {children}
      </a>
    );
  }

  return (
    <div ref={root} className="relative">
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
      <button
        ref={button}
        type="button"
        title={summary.label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="notifications-panel"
        onClick={() => setOpen((value) => !value)}
        className={LINK_CLASS}
      >
        {children}
      </button>
      {open ? <NotificationPanel onSummary={onSummary} /> : null}
    </div>
  );
}
