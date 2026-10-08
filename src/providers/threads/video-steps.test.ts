import { describe, expect, it } from "vitest";
import { initialState, planOf, type ThreadsState } from "./state";
import { threadsStepFor, validState } from "./steps";

type Kind = "image" | "video";
const c = (kinds: Kind[]) => ({ text: "x", mediaCount: kinds.length, kinds });
const plan = (kinds: Kind[]) => planOf(kinds.length, kinds)!;
const st = (kinds: Kind[], patch: Partial<ThreadsState> = {}): ThreadsState => ({ ...initialState(plan(kinds)), ...patch });
const step = (name: string, mayPublish = false) => ({ name, mayPublish });
const at = "2026-01-01T00:00:00.000Z";
const prog = (ready: boolean) => ({ createdAt: at, checks: 0, ready });
const name = (state: unknown, kinds: Kind[]) => threadsStepFor(state, c(kinds)).name;

describe("single video", () => {
  const k: Kind[] = ["video"];
  it("runs create_container → check_status → check_quota → publish", () => {
    expect(threadsStepFor(null, c(k))).toEqual(step("create_container"));
    expect(threadsStepFor(st(k, { container: "1", createdAt: at }), c(k))).toEqual(step("check_status"));
    expect(threadsStepFor(st(k, { container: "1", createdAt: at, ready: true }), c(k))).toEqual(step("check_quota"));
    expect(threadsStepFor(st(k, { container: "1", createdAt: at, ready: true, quotaChecked: true }), c(k))).toEqual(step("publish", true));
  });

  it("restarts when the saved state is for an image", () => {
    const image = initialState(1);
    expect(name({ ...image, container: "1", createdAt: at }, k)).toBe("create_container");
    expect(name({ ...initialState(plan(k)), container: "1", createdAt: at }, ["image"])).toBe("create_container");
  });
});

describe("mixed carousel", () => {
  const k: Kind[] = ["image", "video", "image"];
  const items = (n: number) => ["1", "2", "3"].slice(0, n);
  const progress = (...ready: boolean[]) => ready.map(prog);

  it("creates each item, checks the video, then creates the carousel", () => {
    expect(name(null, k)).toBe("create_item_1");
    expect(name(st(k, { items: ["1"], itemProgress: progress(true) }), k)).toBe("create_item_2");
    expect(name(st(k, { items: items(2), itemProgress: progress(true, false) }), k)).toBe("create_item_3");
    expect(name(st(k, { items: items(3), itemProgress: progress(true, false, true) }), k)).toBe("check_item_2");
    expect(name(st(k, { items: items(3), itemProgress: progress(true, true, true) }), k)).toBe("create_carousel");
    expect(name(st(k, { items: items(3), itemProgress: progress(true, true, true), container: "9", createdAt: at }), k)).toBe("check_status");
    expect(name(st(k, { items: items(3), itemProgress: progress(true, true, true), container: "9", createdAt: at, ready: true }), k)).toBe("check_quota");
    expect(threadsStepFor(st(k, { items: items(3), itemProgress: progress(true, true, true), container: "9", createdAt: at, ready: true, quotaChecked: true }), c(k))).toEqual(step("publish", true));
  });

  it("checks the first unready video first (all-video pair)", () => {
    const v: Kind[] = ["video", "video"];
    expect(name(st(v, { items: ["1", "2"], itemProgress: progress(false, false) }), v)).toBe("check_item_1");
    expect(name(st(v, { items: ["1", "2"], itemProgress: progress(true, false) }), v)).toBe("check_item_2");
    expect(name(st(v, { items: ["1", "2"], itemProgress: progress(true, true) }), v)).toBe("create_carousel");
  });

  it("handles 20 items", () => {
    const twenty: Kind[] = Array.from({ length: 20 }, (_, i) => (i % 2 ? "video" : "image"));
    expect(name(null, twenty)).toBe("create_item_1");
    const ids = Array.from({ length: 20 }, (_, i) => String(i + 1));
    expect(name(st(twenty, { items: ids, itemProgress: ids.map((_, i) => prog(i % 2 === 0)) }), twenty)).toBe("check_item_2");
  });

  it("restarts from the first create step when the state no longer fits (D10)", () => {
    const good = st(k, { items: items(3), itemProgress: progress(true, true, true) });
    expect(name(good, k)).toBe("create_carousel");
    // kinds changed, image <-> video swapped, item removed
    expect(name(good, ["image", "image", "image"])).toBe("create_item_1");
    expect(name(good, ["image", "image", "video"])).toBe("create_item_1");
    expect(name(good, ["image", "video"])).toBe("create_item_1");
    // parent exists while an item is unready, misaligned progress
    expect(name({ ...good, container: "9", createdAt: at, itemProgress: progress(true, false, true) }, k)).toBe("create_item_1");
    expect(name({ ...good, itemProgress: progress(true, true) }, k)).toBe("create_item_1");
    expect(name({ ...good, itemProgress: undefined }, k)).toBe("create_item_1");
    // a video state against an image-only plan, and the reverse
    expect(validState(good, plan(["image", "image", "image"]))).toBeNull();
    expect(validState(initialState(3), plan(k))).toBeNull();
  });
});

describe("limits and totality", () => {
  it("is invalid over 20 items", () => {
    const kinds: Kind[] = Array.from({ length: 21 }, () => "video");
    expect(threadsStepFor(null, c(kinds)).name).toBe("invalid");
  });

  it("only publish may publish", () => {
    const k: Kind[] = ["image", "video"];
    for (const state of [null, st(k), st(k, { items: ["1", "2"], itemProgress: [prog(true), prog(false)] })]) {
      expect(threadsStepFor(state, c(k)).mayPublish).toBe(false);
    }
  });

  it("is total on garbled state and content", () => {
    for (const state of [undefined, "x", 5, [], {}, { v: 1, mediaType: "VIDEO", items: "no" }]) {
      for (const content of [c(["video"]), { text: "x", mediaCount: 2 }, { text: "x", mediaCount: 2, kinds: ["video" as const] }, undefined as never, null as never]) {
        expect(() => threadsStepFor(state, content)).not.toThrow();
      }
    }
  });

  it("ignores kinds whose length does not match the count", () => {
    expect(threadsStepFor(null, { text: "x", mediaCount: 2, kinds: ["video"] }).name).toBe("create_item_1");
    expect(validState(initialState(2), planOf(2, ["video"])!)).not.toBeNull();
  });
});
