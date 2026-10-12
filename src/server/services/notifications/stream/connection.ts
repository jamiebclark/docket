// One held connection: the guarded write, the heartbeat, the lifetime close and the session re-check
// (045, contracts/server.md §4). The only module besides `index.ts` that touches real time; everything
// else in this feature is unit-tested over an injected clock.

import { randomUUID } from "node:crypto";
import { streamSessionIsLive } from "../../../dal/sessions";
import {
  CONNECTION_LIFETIME_MS,
  frame,
  HEARTBEAT_MS,
  SESSION_RECHECK_MS,
} from "../../../../lib/notifications/stream-protocol";
import { getRegistry, type StreamConnection } from "./registry";
import { stopWatcher } from "./watcher";

/**
 * Nothing here relies on `request.signal` aborting or `ReadableStream.cancel()` firing on a dropped
 * socket — neither is documented in the installed Next docs (S19, constitution I). The guaranteed path is
 * a write throwing on the next heartbeat; `index.ts` wires the signal/cancel as a best-effort fast path.
 */
export function createConnection(input: {
  userId: string;
  sessionId: string;
  enqueue: (chunk: string) => void;
  close: () => void;
}): StreamConnection {
  const { userId, sessionId, enqueue, close } = input;
  let closed = false;
  const stopTimers: Array<() => void> = [];

  const connection: StreamConnection = {
    id: randomUUID(),
    userId,
    sessionId,
    openedAt: Date.now(),
    lastSent: { count: 0, nextChangeAt: null },
    write(body) {
      if (closed) return false;
      try {
        enqueue(body);
        return true;
      } catch {
        teardown();
        return false;
      }
    },
    end(event, reason) {
      connection.write(reason === undefined ? frame(event) : frame(event, { reason }));
      teardown();
    },
  };

  function teardown(): void {
    if (closed) return;
    closed = true;
    for (const stop of stopTimers) stop();
    const registry = getRegistry();
    registry.remove(connection.id);
    if (registry.size() === 0) stopWatcher();
    try {
      close();
    } catch {
      // Already gone.
    }
  }

  const heartbeat = setInterval(() => {
    connection.write(frame("ping"));
  }, HEARTBEAT_MS);
  stopTimers.push(() => clearInterval(heartbeat));

  const lifetime = setTimeout(() => {
    connection.end("reconnect");
  }, CONNECTION_LIFETIME_MS);
  stopTimers.push(() => clearTimeout(lifetime));

  const recheck = setInterval(() => {
    void (async () => {
      let live = true;
      try {
        live = await streamSessionIsLive({ sessionId, userId });
      } catch {
        live = true; // A database blip must not sign anybody out (N81, FR-015).
      }
      if (!live) connection.end("ended", "unauthenticated");
    })();
  }, SESSION_RECHECK_MS);
  stopTimers.push(() => clearInterval(recheck));

  return connection;
}
