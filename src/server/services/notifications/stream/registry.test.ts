import { beforeEach, describe, expect, it } from "vitest";
import { getRegistry, resetRegistryForTests, type StreamConnection } from "./registry";

function fakeConnection(overrides: Partial<StreamConnection> & { id: string; userId: string; openedAt: number }): StreamConnection {
  return {
    sessionId: "session",
    lastSent: { count: 0, nextChangeAt: null },
    write: () => true,
    end: () => {},
    ...overrides,
  };
}

describe("StreamRegistry", () => {
  beforeEach(() => {
    resetRegistryForTests();
  });

  it("refuses the 51st connection without closing anyone", () => {
    const registry = getRegistry();
    const ended: string[] = [];
    for (let i = 0; i < 50; i++) {
      const c = fakeConnection({
        id: `c${i}`,
        userId: `user-${i}`, // stay under the per-person cap
        openedAt: i,
        end: () => ended.push(`c${i}`),
      });
      expect(registry.add(c)).toBe("added");
    }
    const overflow = fakeConnection({ id: "c50", userId: "user-50", openedAt: 50 });
    expect(registry.add(overflow)).toBe("process_full");
    expect(registry.size()).toBe(50);
    expect(ended).toHaveLength(0);
  });

  it("overflowing returns the person's oldest-by-openedAt connection at the 5-per-person cap", () => {
    const registry = getRegistry();
    const sameUser = "user-a";
    const conns = [10, 30, 20, 5, 15].map((openedAt, i) => fakeConnection({ id: `c${i}`, userId: sameUser, openedAt }));
    for (const c of conns) {
      expect(registry.add(c)).toBe("added");
    }
    // Already at the 5-per-person cap: the sixth tab displaces the oldest.
    const oldest = registry.overflowing(sameUser);
    expect(oldest?.id).toBe("c3"); // openedAt: 5, the smallest
  });

  it("overflowing returns null below the per-person cap, for a different person, and after an empty removal", () => {
    const registry = getRegistry();
    registry.add(fakeConnection({ id: "c0", userId: "user-a", openedAt: 1 }));
    expect(registry.overflowing("user-a")).toBeNull();
    expect(registry.overflowing("user-b")).toBeNull();
  });

  it("remove is idempotent", () => {
    const registry = getRegistry();
    const c = fakeConnection({ id: "c0", userId: "user-a", openedAt: 1 });
    registry.add(c);
    expect(registry.size()).toBe(1);
    registry.remove("c0");
    expect(registry.size()).toBe(0);
    registry.remove("c0");
    registry.remove("not-there");
    expect(registry.size()).toBe(0);
  });

  it("byUser groups connections by user id", () => {
    const registry = getRegistry();
    const a1 = fakeConnection({ id: "a1", userId: "user-a", openedAt: 1 });
    const a2 = fakeConnection({ id: "a2", userId: "user-a", openedAt: 2 });
    const b1 = fakeConnection({ id: "b1", userId: "user-b", openedAt: 3 });
    registry.add(a1);
    registry.add(a2);
    registry.add(b1);
    const grouped = registry.byUser();
    expect(grouped.size).toBe(2);
    expect(grouped.get("user-a")?.map((c) => c.id).sort()).toEqual(["a1", "a2"]);
    expect(grouped.get("user-b")?.map((c) => c.id)).toEqual(["b1"]);
  });

  it("all returns every connection", () => {
    const registry = getRegistry();
    registry.add(fakeConnection({ id: "c0", userId: "user-a", openedAt: 1 }));
    registry.add(fakeConnection({ id: "c1", userId: "user-b", openedAt: 2 }));
    expect(registry.all().map((c) => c.id).sort()).toEqual(["c0", "c1"]);
  });

  it("getRegistry returns the same singleton across calls, reset starts fresh", () => {
    const first = getRegistry();
    first.add(fakeConnection({ id: "c0", userId: "user-a", openedAt: 1 }));
    expect(getRegistry()).toBe(first);
    expect(getRegistry().size()).toBe(1);
    resetRegistryForTests();
    expect(getRegistry().size()).toBe(0);
  });
});
