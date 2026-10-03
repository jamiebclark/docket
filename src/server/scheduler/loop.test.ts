import { describe, expect, it, vi } from "vitest";
import { runLoop } from "./loop";

const summary = { publishing: { counts: { done: 2, failed: 1, ambiguous: 0, deferred: 3 } } };

describe("runLoop", () => {
  it("logs one line per tick in the documented format", async () => {
    const ac = new AbortController();
    const lines: string[] = [];
    await runLoop({
      tick: async () => {
        ac.abort();
        return summary;
      },
      intervalMs: 1000,
      signal: ac.signal,
      log: (l) => lines.push(l),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Docket scheduler: tick \d+ms published=2 failed=1 ambiguous=0 deferred=3$/);
  });

  it("lets a tick finish when aborted during it", async () => {
    const ac = new AbortController();
    let finished = false;
    const sleep = vi.fn(async () => {});
    await runLoop({
      tick: async () => {
        ac.abort();
        await new Promise((r) => setTimeout(r, 10));
        finished = true;
        return summary;
      },
      intervalMs: 1000,
      signal: ac.signal,
      log: () => {},
      sleep,
    });
    expect(finished).toBe(true);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("ends the sleep immediately when aborted during it", async () => {
    const ac = new AbortController();
    const started = Date.now();
    const done = runLoop({ tick: async () => summary, intervalMs: 60_000, signal: ac.signal, log: () => {} });
    setTimeout(() => ac.abort(), 20);
    await done;
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("logs a throwing tick and keeps going", async () => {
    const ac = new AbortController();
    const lines: string[] = [];
    let calls = 0;
    await runLoop({
      tick: async () => {
        calls++;
        if (calls === 1) throw new Error("db down");
        ac.abort();
        return summary;
      },
      intervalMs: 1,
      signal: ac.signal,
      log: (l) => lines.push(l),
    });
    expect(calls).toBe(2);
    expect(lines[0]).toBe("Docket scheduler: tick failed: db down");
    expect(lines[1]).toContain("published=2");
  });
});
