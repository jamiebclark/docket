export interface SchemaWaitOptions {
  ready: () => Promise<boolean>;
  signal: AbortSignal;
  log?: (line: string) => void;
  /** Poll interval (default 2 s). */
  pollMs?: number;
  /** Minimum gap between "waiting" log lines (default 30 s). */
  logEveryMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  clock?: () => number;
}

/**
 * Worker start-up (research D17): the web container migrates, the worker may start first. Polls until
 * the scheduler schema exists, logging at most every `logEveryMs`. No timeout. Returns false if aborted.
 */
export async function waitForSchema(opts: SchemaWaitOptions): Promise<boolean> {
  const { ready, signal } = opts;
  const log = opts.log ?? ((line: string) => console.log(line));
  const pollMs = opts.pollMs ?? 2000;
  const logEveryMs = opts.logEveryMs ?? 30_000;
  const clock = opts.clock ?? Date.now;
  const sleep = opts.sleep ?? (await import("./loop")).abortableSleep;
  let lastLogged: number | null = null;
  while (!signal.aborted) {
    if (await ready()) return true;
    const t = clock();
    if (lastLogged === null || t - lastLogged >= logEveryMs) {
      log("Docket scheduler: waiting for database schema…");
      lastLogged = t;
    }
    await sleep(pollMs, signal);
  }
  return false;
}
