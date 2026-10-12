// The watcher: one sequential loop that finds out, for the whole process, whether anything changed
// (045, contracts/server.md §3). `runRound` is exported separately so a test drives one round at a time
// with injected deps and no clock. `ensureWatcher`/`stopWatcher` own the real loop, started by the first
// connection and stopped by the last.

import { forMyProjects } from "../../../dal/my-projects";
import { probeChangeFingerprint, type ChangeFingerprint } from "../../../dal/notification-probe";
import { streamSessionIsLive } from "../../../dal/sessions";
import { frame, MAX_CONCURRENT_RECOMPUTES, PROBE_INTERVAL_MS } from "../../../../lib/notifications/stream-protocol";
import type { UnreadSummary } from "../../../../lib/notifications/types";
import { unreadSummary } from "../index";
import { getRegistry, type StreamRegistry } from "./registry";

export interface WatcherDeps {
  probe: () => Promise<ChangeFingerprint>;
  recompute: (userId: string) => Promise<UnreadSummary>;
  sessionIsLive: (c: { sessionId: string; userId: string }) => Promise<boolean>;
  registry: StreamRegistry;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  log: (line: string) => void;
}

export interface RoundSummary {
  /** False when the probe failed, the round was the first ever, or nothing changed and nothing was due. */
  ran: boolean;
  recomputedUsers: string[];
  endedUsers: string[];
  sent: number;
}

/** Carried across rounds. A test passes its own, isolated from the process-wide default. */
export interface WatcherState {
  baseline: ChangeFingerprint | null;
}

const NOTHING: RoundSummary = { ran: false, recomputedUsers: [], endedUsers: [], sent: 0 };

const defaultState: WatcherState = { baseline: null };

async function withConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  async function next(): Promise<void> {
    const i = index++;
    if (i >= items.length) return;
    await worker(items[i]!);
    return next();
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
}

/** One round, per contracts/server.md §3.1. */
export async function runRound(deps: WatcherDeps, state: WatcherState = defaultState): Promise<RoundSummary> {
  let fingerprint: ChangeFingerprint;
  try {
    fingerprint = await deps.probe();
  } catch (error) {
    deps.log(`notifications stream: probe failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return NOTHING;
  }

  // The first probe of this state's lifetime only establishes the baseline: every connection already got
  // its own opening snapshot on admission (FR-005).
  if (state.baseline === null) {
    state.baseline = fingerprint;
    return NOTHING;
  }

  const now = deps.now();
  const due = deps.registry
    .all()
    .some((c) => c.lastSent.nextChangeAt !== null && new Date(c.lastSent.nextChangeAt).getTime() <= now);

  if (fingerprint.value === state.baseline.value && !due) {
    return NOTHING;
  }

  const recomputedUsers: string[] = [];
  const endedUsers: string[] = [];
  let sent = 0;

  const entries = [...deps.registry.byUser().entries()];
  await withConcurrency(entries, MAX_CONCURRENT_RECOMPUTES, async ([userId, connections]) => {
    let live = true;
    try {
      live = await deps.sessionIsLive({ sessionId: connections[0]!.sessionId, userId });
    } catch {
      live = true; // A database blip must not sign anybody out (N81, FR-015).
    }
    if (!live) {
      endedUsers.push(userId);
      for (const c of connections) c.end("ended", "unauthenticated");
      return;
    }

    let summary: UnreadSummary;
    try {
      summary = await deps.recompute(userId);
    } catch (error) {
      deps.log(`notifications stream: recompute failed: ${error instanceof Error ? error.message : "unknown error"}`);
      return;
    }
    recomputedUsers.push(userId);
    for (const c of connections) {
      if (c.lastSent.count === summary.count && c.lastSent.nextChangeAt === summary.nextChangeAt) continue;
      if (c.write(frame("snapshot", summary))) sent++;
      c.lastSent = { count: summary.count, nextChangeAt: summary.nextChangeAt };
    }
  });

  // Assigned only after a successful probe, regardless of any per-person failure above (S24).
  state.baseline = fingerprint;
  return { ran: true, recomputedUsers, endedUsers, sent };
}

function defaultDeps(): WatcherDeps {
  return {
    probe: probeChangeFingerprint,
    recompute: async (userId) => unreadSummary(await forMyProjects({ user: { id: userId } })),
    sessionIsLive: streamSessionIsLive,
    registry: getRegistry(),
    now: () => Date.now(),
    sleep: (ms, signal) =>
      new Promise((resolve) => {
        if (signal.aborted) return resolve();
        const timer = setTimeout(done, ms);
        function done() {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        }
        signal.addEventListener("abort", done, { once: true });
      }),
    log: (line) => console.log(line),
  };
}

const GUARD = Symbol.for("docket.notifications.stream.watcher");
type Guarded = typeof globalThis & { [GUARD]?: AbortController };

async function loop(deps: WatcherDeps, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    await runRound(deps);
    if (signal.aborted) break;
    await deps.sleep(PROBE_INTERVAL_MS, signal);
  }
}

let sigtermWired = false;

/** Ends every held connection with `reconnect`, then stops the loop — what makes a deploy look ordinary. */
function shutdown(): void {
  for (const c of getRegistry().all()) c.end("reconnect");
  stopWatcher();
}

function wireSigterm(): void {
  if (sigtermWired) return;
  sigtermWired = true;
  process.once("SIGTERM", shutdown);
}

/** Starts the loop if it is not running. Called by the first connection; a no-op otherwise. */
export function ensureWatcher(deps: Partial<WatcherDeps> = {}): void {
  const g = globalThis as Guarded;
  if (g[GUARD]) return;
  const controller = new AbortController();
  g[GUARD] = controller;
  wireSigterm();
  void loop({ ...defaultDeps(), ...deps }, controller.signal);
}

/** Stops when the last connection goes, and on `SIGTERM`. */
export function stopWatcher(): void {
  const g = globalThis as Guarded;
  g[GUARD]?.abort();
  delete g[GUARD];
}

/** For tests: starts the next test with no loop running and no remembered baseline. */
export function resetWatcherForTests(): void {
  stopWatcher();
  defaultState.baseline = null;
}
