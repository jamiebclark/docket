export interface LoopOptions {
  tick: () => Promise<unknown>;
  intervalMs: number;
  signal: AbortSignal;
  log?: (line: string) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function summaryLine(result: unknown, ms: number): string {
  const sections = result as { publishing?: { counts?: Record<string, number> }; generation?: { counts?: Record<string, number> } } | null;
  const counts = sections?.publishing?.counts ?? {};
  const gen = sections?.generation?.counts ?? {};
  return `Docket scheduler: tick ${ms}ms published=${counts.done ?? 0} failed=${counts.failed ?? 0} ambiguous=${counts.ambiguous ?? 0} deferred=${counts.deferred ?? 0} generated=${gen.done ?? 0} gen_failed=${gen.failed ?? 0}`;
}

/**
 * Repeats `tick` then sleeps, until `signal` aborts. An abort during a tick lets it finish; an abort
 * during the sleep ends it at once. A throwing tick is logged (message only) and the loop continues.
 */
export async function runLoop(opts: LoopOptions): Promise<void> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const sleep = opts.sleep ?? abortableSleep;
  while (!opts.signal.aborted) {
    const t0 = Date.now();
    try {
      const result = await opts.tick();
      log(summaryLine(result, Date.now() - t0));
    } catch (error) {
      log(`Docket scheduler: tick failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    if (opts.signal.aborted) break;
    await sleep(opts.intervalMs, opts.signal);
  }
}
