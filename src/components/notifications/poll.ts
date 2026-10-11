import type { UnreadSummary } from "@/lib/notifications/types";

export const POLL_INTERVAL_MS = 60_000;
export const CHANGED_EVENT = "docket:notifications-changed";

export interface PollEnv {
  fetchSummary: () => Promise<UnreadSummary>;
  isVisible: () => boolean;
  /** Subscribe to visibility changes; returns an unsubscribe. */
  onVisibilityChange: (listener: () => void) => () => void;
  /** Subscribe to the "unread changed" event; returns an unsubscribe. */
  onChanged: (listener: () => void) => () => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
}

export interface PollHandlers {
  onSummary: (summary: UnreadSummary) => void;
  /** Called only when the count rose since the last known one. */
  onAnnounce: (summary: UnreadSummary) => void;
}

/**
 * Refreshes the bell count: every 60 s while the page is visible, once on becoming visible, once when the
 * count changes elsewhere, and once more from a one-shot timer armed from `nextChangeAt` — so a snooze
 * running out refreshes the bell at that instant rather than up to 60 s later (FR-022, contracts/ui.md §7).
 * A failure keeps the last count silently. Returns a stop function.
 */
export function startPolling(initial: UnreadSummary, env: PollEnv, handlers: PollHandlers): () => void {
  let last = initial.count;
  let timer: unknown = null;
  let oneShot: unknown = null;
  let stopped = false;

  const clearOneShot = () => {
    if (oneShot !== null) env.clearTimeout(oneShot);
    oneShot = null;
  };

  const armOneShot = (nextChangeAt: string | null) => {
    clearOneShot();
    if (nextChangeAt === null || !env.isVisible()) return;
    const delay = Math.max(0, new Date(nextChangeAt).getTime() - env.now());
    oneShot = env.setTimeout(() => void refresh(), delay);
  };

  const refresh = async () => {
    try {
      const summary = await env.fetchSummary();
      if (stopped) return;
      const rose = summary.count > last;
      last = summary.count;
      handlers.onSummary(summary);
      if (rose) handlers.onAnnounce(summary);
      armOneShot(summary.nextChangeAt);
    } catch {
      // Keep showing the last count.
    }
  };

  const start = () => {
    if (timer === null) timer = env.setInterval(() => void refresh(), POLL_INTERVAL_MS);
  };
  const halt = () => {
    if (timer !== null) env.clearInterval(timer);
    timer = null;
  };

  const onVisibility = () => {
    if (env.isVisible()) {
      void refresh();
      start();
    } else {
      halt();
      clearOneShot();
    }
  };

  if (env.isVisible()) {
    start();
    armOneShot(initial.nextChangeAt);
  }
  const offVisibility = env.onVisibilityChange(onVisibility);
  const offChanged = env.onChanged(() => void refresh());

  return () => {
    stopped = true;
    halt();
    clearOneShot();
    offVisibility();
    offChanged();
  };
}

/** The browser wiring of `PollEnv`. */
export function browserPollEnv(): PollEnv {
  return {
    fetchSummary: async () => {
      const response = await fetch("/api/me/notifications", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      return (await response.json()) as UnreadSummary;
    },
    isVisible: () => document.visibilityState === "visible",
    onVisibilityChange: (listener) => {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
    onChanged: (listener) => {
      window.addEventListener(CHANGED_EVENT, listener);
      return () => window.removeEventListener(CHANGED_EVENT, listener);
    },
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (handle) => window.clearInterval(handle as number),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
    now: () => Date.now(),
  };
}
