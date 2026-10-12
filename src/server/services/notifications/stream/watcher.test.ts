import { describe, expect, it, vi } from "vitest";
import type { ChangeFingerprint } from "../../../dal/notification-probe";
import type { UnreadSummary } from "../../../../lib/notifications/types";
import { runRound, type WatcherDeps, type WatcherState } from "./watcher";
import type { StreamConnection, StreamRegistry } from "./registry";

function fp(value: string): ChangeFingerprint {
  return { value };
}

function summary(count: number, nextChangeAt: string | null = null): UnreadSummary {
  return { count, display: String(count), label: `${count} unread problems`, nextChangeAt };
}

function fakeConnection(overrides: Partial<StreamConnection> & { id: string; userId: string }): StreamConnection {
  return {
    sessionId: "session",
    openedAt: 0,
    lastSent: { count: 0, nextChangeAt: null },
    write: () => true,
    end: () => {},
    ...overrides,
  };
}

function fakeRegistry(connections: StreamConnection[]): StreamRegistry {
  return {
    add: () => "added",
    overflowing: () => null,
    remove: () => {},
    size: () => connections.length,
    byUser: () => {
      const grouped = new Map<string, StreamConnection[]>();
      for (const c of connections) {
        const existing = grouped.get(c.userId);
        if (existing) existing.push(c);
        else grouped.set(c.userId, [c]);
      }
      return grouped;
    },
    all: () => connections,
  };
}

function baseDeps(overrides: Partial<WatcherDeps> = {}): WatcherDeps {
  return {
    probe: async () => fp("a"),
    recompute: async () => summary(0),
    sessionIsLive: async () => true,
    registry: fakeRegistry([]),
    now: () => 0,
    sleep: async () => {},
    log: () => {},
    ...overrides,
  };
}

describe("runRound", () => {
  it("sends nothing on the first round — it only establishes the baseline", async () => {
    const state: WatcherState = { baseline: null };
    const recompute = vi.fn();
    const result = await runRound(baseDeps({ recompute }), state);
    expect(result.ran).toBe(false);
    expect(recompute).not.toHaveBeenCalled();
    expect(state.baseline).toEqual(fp("a"));
  });

  it("sends nothing when the fingerprint is unchanged and nothing is due", async () => {
    const state: WatcherState = { baseline: fp("a") };
    const recompute = vi.fn();
    const connection = fakeConnection({ id: "c1", userId: "u1" });
    const result = await runRound(baseDeps({ recompute, registry: fakeRegistry([connection]) }), state);
    expect(result.ran).toBe(false);
    expect(recompute).not.toHaveBeenCalled();
  });

  it("runs a round when a connection's nextChangeAt instant has passed, with an unchanged fingerprint", async () => {
    const state: WatcherState = { baseline: fp("a") };
    const connection = fakeConnection({
      id: "c1",
      userId: "u1",
      lastSent: { count: 0, nextChangeAt: new Date(1_000).toISOString() },
    });
    const result = await runRound(
      baseDeps({
        registry: fakeRegistry([connection]),
        recompute: async () => summary(1),
        now: () => 2_000,
      }),
      state,
    );
    expect(result.ran).toBe(true);
    expect(result.recomputedUsers).toEqual(["u1"]);
  });

  it("recomputes once per person even when they hold several connections (S21)", async () => {
    const recompute = vi.fn(async () => summary(2));
    const c1 = fakeConnection({ id: "c1", userId: "u1" });
    const c2 = fakeConnection({ id: "c2", userId: "u1" });
    const state: WatcherState = { baseline: fp("a") };
    const result = await runRound(
      baseDeps({ probe: async () => fp("b"), registry: fakeRegistry([c1, c2]), recompute }),
      state,
    );
    expect(recompute).toHaveBeenCalledTimes(1);
    expect(result.sent).toBe(2);
    expect(c1.lastSent).toEqual({ count: 2, nextChangeAt: null });
    expect(c2.lastSent).toEqual({ count: 2, nextChangeAt: null });
  });

  it("never runs more than MAX_CONCURRENT_RECOMPUTES recomputes at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const users = Array.from({ length: 10 }, (_, i) => fakeConnection({ id: `c${i}`, userId: `u${i}` }));
    const recompute = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return summary(1);
    });
    const state: WatcherState = { baseline: fp("a") };
    await runRound(baseDeps({ probe: async () => fp("b"), registry: fakeRegistry(users), recompute }), state);
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(recompute).toHaveBeenCalledTimes(10);
  });

  it("leaves the baseline untouched on a probe failure", async () => {
    const state: WatcherState = { baseline: fp("a") };
    const result = await runRound(
      baseDeps({ probe: async () => { throw new Error("db down"); } }),
      state,
    );
    expect(result.ran).toBe(false);
    expect(state.baseline).toEqual(fp("a"));
  });

  it("keeps a connection's lastSent on a recompute failure, retried the next round", async () => {
    const connection = fakeConnection({ id: "c1", userId: "u1", lastSent: { count: 5, nextChangeAt: null } });
    const state: WatcherState = { baseline: fp("a") };
    const result = await runRound(
      baseDeps({
        probe: async () => fp("b"),
        registry: fakeRegistry([connection]),
        recompute: async () => { throw new Error("busy"); },
      }),
      state,
    );
    expect(connection.lastSent).toEqual({ count: 5, nextChangeAt: null });
    expect(result.sent).toBe(0);
    // The probe still succeeded, so the baseline still advances (S24).
    expect(state.baseline).toEqual(fp("b"));
  });

  it("ends every connection of a person whose session is no longer live", async () => {
    const ended: string[] = [];
    const connection = fakeConnection({ id: "c1", userId: "u1", end: (event) => ended.push(event) });
    const state: WatcherState = { baseline: fp("a") };
    const recompute = vi.fn();
    const result = await runRound(
      baseDeps({
        probe: async () => fp("b"),
        registry: fakeRegistry([connection]),
        sessionIsLive: async () => false,
        recompute,
      }),
      state,
    );
    expect(ended).toEqual(["ended"]);
    expect(recompute).not.toHaveBeenCalled();
    expect(result.endedUsers).toEqual(["u1"]);
  });

  it("treats a sessionIsLive failure as live — a database blip must not sign anybody out (N81)", async () => {
    const connection = fakeConnection({ id: "c1", userId: "u1" });
    const state: WatcherState = { baseline: fp("a") };
    const result = await runRound(
      baseDeps({
        probe: async () => fp("b"),
        registry: fakeRegistry([connection]),
        sessionIsLive: async () => { throw new Error("db down"); },
        recompute: async () => summary(1),
      }),
      state,
    );
    expect(result.endedUsers).toEqual([]);
    expect(result.recomputedUsers).toEqual(["u1"]);
  });

  it("only writes a snapshot when the value differs from that connection's own lastSent", async () => {
    const writes: string[] = [];
    const connection = fakeConnection({
      id: "c1",
      userId: "u1",
      lastSent: { count: 3, nextChangeAt: null },
      write: (f) => {
        writes.push(f);
        return true;
      },
    });
    const state: WatcherState = { baseline: fp("a") };
    await runRound(
      baseDeps({ probe: async () => fp("b"), registry: fakeRegistry([connection]), recompute: async () => summary(3) }),
      state,
    );
    expect(writes).toHaveLength(0);
  });
});
