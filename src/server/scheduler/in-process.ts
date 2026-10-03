import { getEnv } from "../env";
import { runTick } from "./index";
import { runLoop } from "./loop";

const GUARD = Symbol.for("docket.scheduler.inProcess");
type Guarded = typeof globalThis & { [GUARD]?: AbortController };

/**
 * Starts the scheduler loop inside the web process (FR-044). A no-op unless `RUN_WORKER_IN_PROCESS`.
 * Not awaited by the caller: `register()` must return before the server serves. A `globalThis` guard
 * stops a second start when the instrumentation hook runs more than once (hot reload, U2).
 */
export function startInProcessLoop(
  deps: { tick?: () => Promise<unknown>; env?: { RUN_WORKER_IN_PROCESS: boolean; WORKER_INTERVAL_SECONDS: number } } = {},
): AbortController | null {
  const env = deps.env ?? getEnv();
  if (!env.RUN_WORKER_IN_PROCESS) return null;
  const g = globalThis as Guarded;
  if (g[GUARD]) return g[GUARD];

  const controller = new AbortController();
  g[GUARD] = controller;
  process.once("SIGTERM", () => controller.abort());
  void runLoop({
    tick: deps.tick ?? (() => runTick()),
    intervalMs: env.WORKER_INTERVAL_SECONDS * 1000,
    signal: controller.signal,
  });
  return controller;
}

/** For tests. */
export function resetInProcessGuard(): void {
  const g = globalThis as Guarded;
  g[GUARD]?.abort();
  delete g[GUARD];
}
