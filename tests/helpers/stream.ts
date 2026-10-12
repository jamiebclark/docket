// Reads a `Response`'s body as decoded SSE frames, with a deadline (045, T013). Used by every
// integration test against `GET /api/me/notifications/stream`.
//
// Also a fake `StreamHandle` (contracts/client.md §10) for `refresh.ts`'s tests: emits `snapshot`,
// `ping`, `reconnect`, `unavailable`, `ended` and connection errors on demand, with a variant that
// accepts the connection and sends nothing — the buffering-proxy case (US2 §1).

import type { StreamEventName } from "@/lib/notifications/stream-protocol";

export interface SseFrame {
  event: string;
  data: string;
}

export interface FrameReader {
  /** Resolves with the next full frame, or rejects once `deadlineMs` has passed with none. */
  next(deadlineMs?: number): Promise<SseFrame>;
  close(): Promise<void>;
}

const DEFAULT_DEADLINE_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function parseFrame(raw: string): SseFrame {
  let event = "message";
  let data = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7);
    else if (line.startsWith("data: ")) data = line.slice(6);
    else if (line === "data:") data = "";
  }
  return { event, data };
}

/** Decodes `response.body` into SSE frames one at a time, buffering partial reads. */
export function frameReader(response: Response): FrameReader {
  if (!response.body) throw new Error("stream helper: response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  function takeOne(): SseFrame | null {
    const idx = buffer.indexOf("\n\n");
    if (idx === -1) return null;
    const raw = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    return parseFrame(raw);
  }

  return {
    async next(deadlineMs = DEFAULT_DEADLINE_MS) {
      const deadlineAt = Date.now() + deadlineMs;
      for (;;) {
        const frame = takeOne();
        if (frame) return frame;
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) throw new Error(`stream helper: no frame within ${deadlineMs}ms`);
        const { done, value } = await withTimeout(reader.read(), remaining, `stream helper: no frame within ${deadlineMs}ms`);
        if (done) throw new Error("stream helper: stream ended before a full frame arrived");
        buffer += decoder.decode(value, { stream: true });
      }
    },
    async close() {
      await reader.cancel().catch(() => {});
    },
  };
}

export interface FakeStreamHandle {
  on: (event: StreamEventName, listener: (data: string) => void) => void;
  onError: (listener: () => void) => void;
  close: () => void;
  /** Test-only: deliver a named event with an optional body. */
  emit: (event: StreamEventName, data?: string) => void;
  /** Test-only: fire every registered `onError` listener. */
  fail: () => void;
  readonly closed: boolean;
}

/** A fake `StreamHandle` (contracts/client.md §10): nothing happens until `emit`/`fail` is called. */
export function fakeStreamHandle(): FakeStreamHandle {
  const listeners = new Map<StreamEventName, Set<(data: string) => void>>();
  const errorListeners = new Set<() => void>();
  let closed = false;
  return {
    on(event, listener) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener);
    },
    onError(listener) {
      errorListeners.add(listener);
    },
    close() {
      closed = true;
    },
    emit(event, data = "") {
      listeners.get(event)?.forEach((listener) => listener(data));
    },
    fail() {
      errorListeners.forEach((listener) => listener());
    },
    get closed() {
      return closed;
    },
  };
}

/** The buffering-proxy case (US2 §1): the connection is accepted and never sends anything. */
export function silentStreamHandle(): FakeStreamHandle {
  return fakeStreamHandle();
}
