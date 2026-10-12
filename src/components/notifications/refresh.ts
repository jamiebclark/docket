// The supervisor that picks exactly one refresh mechanism at a time: the push stream when it can be
// held, the existing 60 s poll (`poll.ts`, unedited) whenever it cannot (045, contracts/client.md).

import { browserPollEnv, startPolling, type PollEnv, type PollHandlers } from "@/components/notifications/poll";
import {
  CLEAN_RECONNECT_DELAY_MS,
  FAILURE_BACKOFF_MS,
  FLAPPING_MS,
  LOCAL_CHANGE_YIELD_MS,
  MAX_CONNECT_ATTEMPTS,
  OPENING_SNAPSHOT_DEADLINE_MS,
  parseSnapshot,
  SILENCE_DEADLINE_MS,
  STREAM_PATH,
  type StreamEventName,
} from "@/lib/notifications/stream-protocol";
import type { UnreadSummary } from "@/lib/notifications/types";

export interface StreamHandle {
  on: (event: StreamEventName, listener: (data: string) => void) => void;
  onError: (listener: () => void) => void;
  close: () => void;
}

export type FetchResult = { kind: "ok"; summary: UnreadSummary } | { kind: "unauthenticated" } | { kind: "failed" };

export interface RefreshEnv {
  // --- the stream leg ---
  hasEventSource: () => boolean;
  openStream: (path: string) => StreamHandle;
  // --- the fallback leg ---
  pollEnv: () => PollEnv;
  fetchSummary: () => Promise<FetchResult>;
  // --- the tab ---
  isVisible: () => boolean;
  onVisibilityChange: (listener: () => void) => () => void;
  /** Per-tab, not per-page: a module-level flag, so a navigation does not forget it (FR-020). */
  getFallbackMemo: () => boolean;
  setFallbackMemo: (value: boolean) => void;
  // --- time ---
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
  random: () => number;
}

export interface RefreshHandlers {
  onSummary: (summary: UnreadSummary) => void;
  /** Only when the count rose above what the page last displayed (N70, FR-025). */
  onAnnounce: (summary: UnreadSummary) => void;
  /** A snapshot changed the count: the panel, if open, refetches its rows (FR-027). */
  onPanelRefresh: () => void;
}

export interface RefreshHandle {
  /** The person just changed something in this tab: ignore stream snapshots for 2 s (FR-028). */
  noteLocalChange: (summary?: UnreadSummary) => void;
  stop: () => void;
}

/**
 * The five-state supervisor (`hidden`, `connecting`, `streaming`, `polling`, `ended`) of
 * contracts/client.md §1–§4. Starts `poll.ts` unedited on entering `polling` and pulls its trigger
 * once immediately, so the fallback never waits up to 60 s for its first refresh.
 */
export function startRefreshing(initial: UnreadSummary, env: RefreshEnv, handlers: RefreshHandlers): RefreshHandle {
  let lastShown = initial;
  let stream: StreamHandle | null = null;
  let pollStop: (() => void) | null = null;
  let pollTrigger: (() => void) | null = null;
  let timer: unknown = null;
  let attempts = 0;
  let localChangeAt: number | null = null;
  let stopped = false;
  let ended = false;

  const clearTimer = () => {
    if (timer !== null) env.clearTimeout(timer);
    timer = null;
  };

  const stopStream = () => {
    if (stream) {
      stream.close();
      stream = null;
    }
  };

  const stopPoll = () => {
    if (pollStop) {
      pollStop();
      pollStop = null;
      pollTrigger = null;
    }
  };

  const pollHandlers: PollHandlers = {
    onSummary: (summary) => {
      lastShown = summary;
      handlers.onSummary(summary);
    },
    onAnnounce: (summary) => handlers.onAnnounce(summary),
  };

  /** Merges `poll.ts`'s own "refresh once on an in-page change" path with the supervisor's own trigger. */
  function buildPollEnv(): PollEnv {
    const base = env.pollEnv();
    return {
      ...base,
      onChanged: (listener) => {
        pollTrigger = listener;
        const off = base.onChanged(listener);
        return () => {
          off();
          if (pollTrigger === listener) pollTrigger = null;
        };
      },
    };
  }

  function enterPolling() {
    clearTimer();
    stopStream();
    if (ended || stopped) return;
    if (!pollStop) {
      pollStop = startPolling(lastShown, buildPollEnv(), pollHandlers);
      pollTrigger?.();
    }
  }

  function enterHidden() {
    clearTimer();
    stopStream();
    stopPoll();
  }

  function deliverSnapshot(summary: UnreadSummary) {
    if (localChangeAt !== null && env.now() - localChangeAt < LOCAL_CHANGE_YIELD_MS) return;
    const rose = summary.count > lastShown.count;
    lastShown = summary;
    handlers.onSummary(summary);
    if (rose) handlers.onAnnounce(summary);
    handlers.onPanelRefresh();
  }

  function armOpeningDeadline() {
    clearTimer();
    timer = env.setTimeout(() => {
      // The buffering-proxy case: close, remember the fallback, show no error (N77, US2 §1).
      stopStream();
      env.setFallbackMemo(true);
      enterPolling();
    }, OPENING_SNAPSHOT_DEADLINE_MS);
  }

  function armSilence() {
    clearTimer();
    timer = env.setTimeout(() => recordFailure(), SILENCE_DEADLINE_MS);
  }

  function recordFailure() {
    stopStream();
    attempts += 1;
    if (attempts < MAX_CONNECT_ATTEMPTS) {
      enterPolling();
      const delay = FAILURE_BACKOFF_MS[attempts - 1]! * (1 + env.random() * 0.2);
      timer = env.setTimeout(() => void openStream(), delay);
    } else {
      env.setFallbackMemo(true);
      enterPolling();
    }
  }

  /**
   * `onError` recovery (contracts/client.md §3.1): `EventSource` exposes neither a status code nor a
   * body, so the only way to learn why is to close and make one free-standing probe request. A
   * connection that delivered its opening snapshot more than `FLAPPING_MS` ago is not counted as a
   * failure — it reconnects immediately, like a clean `reconnect` — because it was stable, not flapping.
   */
  function onConnectionError(snapshotAt: number | null) {
    void (async () => {
      clearTimer();
      stopStream();
      if (ended || stopped) return;
      const result = await env.fetchSummary();
      if (ended || stopped) return;
      if (result.kind === "unauthenticated") {
        ended = true;
        stopPoll();
        return;
      }
      if (result.kind === "ok") deliverSnapshot(result.summary);

      const flapping = snapshotAt === null || env.now() - snapshotAt < FLAPPING_MS;
      if (flapping) {
        recordFailure();
      } else {
        attempts = 0;
        timer = env.setTimeout(() => void openStream(), CLEAN_RECONNECT_DELAY_MS);
      }
    })();
  }

  function openStream() {
    clearTimer();
    stopPoll();
    if (ended || stopped) return;
    const handle = env.openStream(STREAM_PATH);
    stream = handle;
    let snapshotAt: number | null = null;

    handle.on("snapshot", (data) => {
      const summary = parseSnapshot(data);
      if (summary === null) return;
      if (snapshotAt === null) {
        snapshotAt = env.now();
        attempts = 0;
        armSilence();
      }
      deliverSnapshot(summary);
    });
    handle.on("ping", () => armSilence());
    handle.on("reconnect", () => {
      // The scheduled close: not a failure; the failure count stays reset (FR-015, US3 §3).
      clearTimer();
      stopStream();
      attempts = 0;
      timer = env.setTimeout(() => void openStream(), CLEAN_RECONNECT_DELAY_MS);
    });
    handle.on("unavailable", () => {
      clearTimer();
      stopStream();
      env.setFallbackMemo(true);
      enterPolling();
    });
    handle.on("ended", () => {
      clearTimer();
      stopStream();
      ended = true;
      stopPoll();
    });
    handle.onError(() => onConnectionError(snapshotAt));

    armOpeningDeadline();
  }

  function enterFromVisible() {
    if (ended || stopped) return;
    if (env.getFallbackMemo() || !env.hasEventSource()) {
      enterPolling();
    } else {
      openStream();
    }
  }

  const onVisibility = () => {
    if (stopped || ended) return;
    if (env.isVisible()) enterFromVisible();
    else enterHidden();
  };
  const offVisibility = env.onVisibilityChange(onVisibility);

  if (env.isVisible()) enterFromVisible();

  return {
    noteLocalChange(summary) {
      localChangeAt = env.now();
      if (summary) {
        lastShown = summary;
        handlers.onSummary(summary);
      }
    },
    stop() {
      stopped = true;
      clearTimer();
      stopStream();
      stopPoll();
      offVisibility();
    },
  };
}

/** Per-tab, module-level: a navigation does not forget it; a fresh tab (a fresh load of this module) does. */
let fallbackMemo = false;

/** The browser wiring of `RefreshEnv`. */
export function browserRefreshEnv(): RefreshEnv {
  return {
    hasEventSource: () => typeof EventSource !== "undefined",
    openStream: (path) => {
      const source = new EventSource(path, { withCredentials: true });
      return {
        on: (event, listener) => {
          source.addEventListener(event, (e) => listener((e as MessageEvent).data ?? ""));
        },
        onError: (listener) => {
          source.addEventListener("error", listener);
        },
        close: () => source.close(),
      };
    },
    pollEnv: () => browserPollEnv(),
    fetchSummary: async () => {
      try {
        const response = await fetch("/api/me/notifications", { credentials: "same-origin", cache: "no-store" });
        if (response.status === 401) return { kind: "unauthenticated" };
        if (!response.ok) return { kind: "failed" };
        return { kind: "ok", summary: (await response.json()) as UnreadSummary };
      } catch {
        return { kind: "failed" };
      }
    },
    isVisible: () => document.visibilityState === "visible",
    onVisibilityChange: (listener) => {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
    getFallbackMemo: () => fallbackMemo,
    setFallbackMemo: (value) => {
      fallbackMemo = value;
    },
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
    now: () => Date.now(),
    random: () => Math.random(),
  };
}
