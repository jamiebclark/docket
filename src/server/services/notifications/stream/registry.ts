// The process-local registry of open notification streams (045, contracts/server.md §2). Pure over an
// injected clock: no database, no `Response`, no timers. Held under a `Symbol.for` singleton so a hot
// reload or a second module evaluation cannot produce two registries (S23), the same pattern
// `src/server/scheduler/in-process.ts` already uses.

import { MAX_STREAMS_PER_PERSON, MAX_STREAMS_PER_PROCESS } from "../../../../lib/notifications/stream-protocol";

export interface StreamConnection {
  readonly id: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly openedAt: number;
  lastSent: { count: number; nextChangeAt: string | null };
  /** Returns `false` once the client has gone. */
  write(frame: string): boolean;
  end(event: "reconnect" | "unavailable" | "ended", reason?: string): void;
}

export interface StreamRegistry {
  /** Full? Then nothing is added and the caller answers the documented refusal. */
  add(connection: StreamConnection): "added" | "process_full";
  /** The person's oldest, when they already hold the per-person maximum; otherwise null. */
  overflowing(userId: string): StreamConnection | null;
  remove(id: string): void;
  size(): number;
  /** Grouped by user id, so one recompute serves a person's tabs (S21). */
  byUser(): Map<string, StreamConnection[]>;
  all(): StreamConnection[];
}

function createRegistry(): StreamRegistry {
  const connections = new Map<string, StreamConnection>();

  return {
    add(connection) {
      if (connections.size >= MAX_STREAMS_PER_PROCESS) return "process_full";
      connections.set(connection.id, connection);
      return "added";
    },
    overflowing(userId) {
      let oldest: StreamConnection | null = null;
      let count = 0;
      for (const c of connections.values()) {
        if (c.userId !== userId) continue;
        count++;
        if (!oldest || c.openedAt < oldest.openedAt) oldest = c;
      }
      return count >= MAX_STREAMS_PER_PERSON ? oldest : null;
    },
    remove(id) {
      connections.delete(id);
    },
    size() {
      return connections.size;
    },
    byUser() {
      const grouped = new Map<string, StreamConnection[]>();
      for (const c of connections.values()) {
        const existing = grouped.get(c.userId);
        if (existing) existing.push(c);
        else grouped.set(c.userId, [c]);
      }
      return grouped;
    },
    all() {
      return [...connections.values()];
    },
  };
}

const REGISTRY = Symbol.for("docket.notifications.stream");
type Guarded = typeof globalThis & { [REGISTRY]?: StreamRegistry };

export function getRegistry(): StreamRegistry {
  const g = globalThis as Guarded;
  if (!g[REGISTRY]) g[REGISTRY] = createRegistry();
  return g[REGISTRY];
}

/** For tests: starts the next test from an empty process. */
export function resetRegistryForTests(): void {
  const g = globalThis as Guarded;
  delete g[REGISTRY];
}
