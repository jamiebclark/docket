// The wire protocol for GET /api/me/notifications/stream (045). Pure: no DOM, no Node API. Imported by
// both the server (framing) and the client (parsing), so the heartbeat and the deadline are one fact (S32).

import type { UnreadSummary } from "./types";

export const STREAM_PATH = "/api/me/notifications/stream";

export const PROBE_INTERVAL_MS = 2_000;
export const HEARTBEAT_MS = 20_000;
export const CONNECTION_LIFETIME_MS = 270_000;
export const SESSION_RECHECK_MS = 60_000;
export const MAX_STREAMS_PER_PROCESS = 50;
export const MAX_STREAMS_PER_PERSON = 5;
export const MAX_CONCURRENT_RECOMPUTES = 3;

export const OPENING_SNAPSHOT_DEADLINE_MS = 5_000;
export const SILENCE_DEADLINE_MS = 45_000;
export const LOCAL_CHANGE_YIELD_MS = 2_000;
export const MAX_CONNECT_ATTEMPTS = 3;
export const FAILURE_BACKOFF_MS = [1_000, 2_000];
export const CLEAN_RECONNECT_DELAY_MS = 500;
export const FLAPPING_MS = 2_000;

export type StreamEventName = "snapshot" | "ping" | "reconnect" | "unavailable" | "ended";

/** Server side: one frame, ready to enqueue. Never emits `id:` or `retry:`. */
export function frame(event: StreamEventName, data?: unknown): string {
  const body = data === undefined ? "" : JSON.stringify(data);
  return `event: ${event}\ndata: ${body}\n\n`;
}

function isUnreadSummary(value: unknown): value is UnreadSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.count === "number" &&
    typeof v.display === "string" &&
    typeof v.label === "string" &&
    (v.nextChangeAt === null || typeof v.nextChangeAt === "string")
  );
}

/** Client side: the parsed body of a `snapshot` event. Malformed or truncated data is dropped, never thrown (N80). */
export function parseSnapshot(data: string): UnreadSummary | null {
  try {
    const parsed = JSON.parse(data);
    return isUnreadSummary(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Client side: the parsed `reason` field of an `unavailable` or `ended` event. Advisory only. */
export function parseReason(data: string): string | null {
  try {
    const parsed = JSON.parse(data);
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as Record<string, unknown>).reason === "string") {
      return (parsed as Record<string, unknown>).reason as string;
    }
    return null;
  } catch {
    return null;
  }
}
