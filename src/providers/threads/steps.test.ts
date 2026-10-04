import { describe, expect, it } from "vitest";
import { initialState, type ThreadsState } from "./state";
import { threadsStepFor, validState } from "./steps";

const c = (mediaCount: number) => ({ text: "x", mediaCount });
const st = (mediaCount: number, patch: Partial<ThreadsState> = {}): ThreadsState => ({ ...initialState(mediaCount), ...patch });
const step = (name: string, mayPublish = false) => ({ name, mayPublish });
const now = "2026-01-01T00:00:00.000Z";

describe("threadsStepFor", () => {
  it("text and single image: create_container → check_status → check_quota → publish", () => {
    for (const n of [0, 1]) {
      expect(threadsStepFor(null, c(n))).toEqual(step("create_container"));
      expect(threadsStepFor(st(n, { container: "1", createdAt: now }), c(n))).toEqual(step("check_status"));
      expect(threadsStepFor(st(n, { container: "1", createdAt: now, ready: true }), c(n))).toEqual(step("check_quota"));
      expect(threadsStepFor(st(n, { container: "1", createdAt: now, ready: true, quotaChecked: true }), c(n))).toEqual(step("publish", true));
    }
  });

  it("carousel: one item container per image, then the carousel container", () => {
    expect(threadsStepFor(null, c(3))).toEqual(step("create_item_1"));
    expect(threadsStepFor(st(3, { items: ["1"] }), c(3))).toEqual(step("create_item_2"));
    expect(threadsStepFor(st(3, { items: ["1", "2", "3"] }), c(3))).toEqual(step("create_carousel"));
    expect(threadsStepFor(st(3, { items: ["1", "2", "3"], container: "9", createdAt: now }), c(3))).toEqual(step("check_status"));
    expect(threadsStepFor(null, c(20))).toEqual(step("create_item_1"));
  });

  it("only publish may publish", () => {
    for (const n of [0, 1, 2, 20]) expect(threadsStepFor(null, c(n)).mayPublish).toBe(false);
  });

  it("is invalid over 20 images or for a non-finite count", () => {
    for (const n of [21, 100, Number.NaN, Infinity]) expect(threadsStepFor(null, c(n)).name).toBe("invalid");
  });

  it("restarts from the first create step when the state no longer fits (FR-030)", () => {
    const bad = [{}, "x", 5, [], { v: 2 }, st(3, { items: ["1"] }), st(1, { ready: true }), st(1, { container: "1", quotaChecked: true }), st(1, { items: ["1"] })];
    for (const b of bad) expect(threadsStepFor(b, c(1)).name).toBe("create_container");
    expect(threadsStepFor(st(3, { items: ["1"] }), c(2)).name).toBe("create_item_2");
    expect(threadsStepFor(st(3, { items: ["1", "2", "3"] }), c(2)).name).toBe("create_item_1");
    expect(threadsStepFor(st(1, { container: "1", ready: true }), c(0)).name).toBe("create_container");
    expect(threadsStepFor(st(3, { items: ["1"], container: "9" }), c(3)).name).toBe("create_item_1");
    expect(validState(st(3, { items: ["1"] }), 1)).toBeNull();
  });

  it("is total over garbled state and content", () => {
    const junk: unknown[] = [undefined, null, 0, "", {}, [], { v: 1 }, { v: 1, mediaType: "VIDEO" }, { ...st(1), checks: -1 }, { ...st(1), recreations: 3 }, { ...st(1), container: "abc" }];
    for (const j of junk) {
      for (const n of [-1, 0, 1, 2, 20, 21, Number.NaN]) {
        const r = threadsStepFor(j, c(n));
        expect(typeof r.name).toBe("string");
        expect(typeof r.mayPublish).toBe("boolean");
      }
    }
    expect(threadsStepFor(null, undefined as never).name).toBe("invalid");
  });

  it("recreation restarts and keeps the count", () => {
    expect(threadsStepFor(st(1, { recreations: 1 }), c(1)).name).toBe("create_container");
    expect(threadsStepFor(st(3, { recreations: 2 }), c(3)).name).toBe("create_item_1");
  });
});
