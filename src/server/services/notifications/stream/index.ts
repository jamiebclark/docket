// Admission: the one place that decides whether a request gets a stream, per contracts/server.md §1.
// `request` is used for nothing but its `signal` (FR-002) — no query parameter, header or body is ever
// read, so there is nothing here for anybody to craft.

import { getSession } from "../../../auth/session";
import { forMyProjects } from "../../../dal/my-projects";
import { frame } from "../../../../lib/notifications/stream-protocol";
import { unreadSummary } from "../index";
import { createConnection } from "./connection";
import { getRegistry } from "./registry";
import { ensureWatcher } from "./watcher";

const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "private, no-store", Vary: "Cookie" };

// Byte-identical to GET /api/me/notifications's refusal (FR-002, contracts/stream.md §2.2).
const unauthenticated = () => new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401, headers: JSON_HEADERS });

const STREAM_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "private, no-store",
  Vary: "Cookie",
  "Content-Encoding": "identity",
  "X-Accel-Buffering": "no",
};

export async function openNotificationStream(request: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return unauthenticated();

  const userId = session.user.id;
  const sessionId = session.session.id;
  const registry = getRegistry();
  const encoder = new TextEncoder();

  // Step 2: the person's own cap, before the process cap, so nobody is refused for a slot they were
  // about to free themselves (S9).
  const overflow = registry.overflowing(userId);
  if (overflow) overflow.end("unavailable", "displaced");

  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  const connection = createConnection({
    userId,
    sessionId,
    enqueue: (chunk) => {
      if (!controllerRef) throw new Error("notifications stream: not yet open");
      controllerRef.enqueue(encoder.encode(chunk));
    },
    close: () => {
      try {
        controllerRef?.close();
      } catch {
        // Already closed.
      }
    },
  });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
    },
    cancel() {
      registry.remove(connection.id);
    },
  });

  request.signal.addEventListener("abort", () => registry.remove(connection.id), { once: true });

  // Steps 3+4: the process cap and admission are one atomic call (registry.ts).
  if (registry.add(connection) === "process_full") {
    connection.end("unavailable", "busy");
    return new Response(stream, { status: 200, headers: STREAM_HEADERS });
  }

  // Step 5: the opening snapshot. A refused request above never reaches this query.
  try {
    const summary = await unreadSummary(await forMyProjects(session));
    connection.write(frame("snapshot", summary));
    connection.lastSent = { count: summary.count, nextChangeAt: summary.nextChangeAt };
  } catch (error) {
    console.error("notifications stream: opening snapshot failed", error);
    registry.remove(connection.id);
    return new Response(JSON.stringify({ error: "unavailable" }), { status: 500, headers: JSON_HEADERS });
  }

  // Step 8. Step 7 (the heartbeat/lifetime/re-check timers) is armed inside `createConnection` itself.
  ensureWatcher();

  return new Response(stream, { status: 200, headers: STREAM_HEADERS });
}
