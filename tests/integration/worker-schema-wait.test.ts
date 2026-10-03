import { afterAll, describe, expect, it } from "vitest";
import { waitForSchema } from "../../src/server/scheduler/schema-wait";
import { schemaIsReady } from "../../src/server/dal";
import { closeDb } from "./../helpers/db";

afterAll(async () => {
  await closeDb();
});

describe("worker schema wait", () => {
  it("sees the migrated test database as ready", async () => {
    expect(await schemaIsReady()).toBe(true);
    const ac = new AbortController();
    expect(await waitForSchema({ ready: schemaIsReady, signal: ac.signal, log: () => {} })).toBe(true);
  });

  it("polls every 2 s and logs at most every 30 s until the schema appears", async () => {
    let t = 0;
    let polls = 0;
    const sleeps: number[] = [];
    const lines: string[] = [];
    const ok = await waitForSchema({
      ready: async () => ++polls > 40,
      signal: new AbortController().signal,
      log: (l) => lines.push(l),
      clock: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
    });
    expect(ok).toBe(true);
    expect(new Set(sleeps)).toEqual(new Set([2000]));
    // 40 failed polls span 80 s → logged at 0 s, 30 s, 60 s.
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("waiting for database schema");
  });

  it("stops when aborted", async () => {
    const ac = new AbortController();
    const ok = await waitForSchema({
      ready: async () => false,
      signal: ac.signal,
      log: () => {},
      sleep: async () => ac.abort(),
    });
    expect(ok).toBe(false);
  });
});
