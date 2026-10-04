import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../../../../tests/helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../../../../tests/helpers/actions")).cacheModule);
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
}));

import { setLlmForTests } from "@/server/llm";
import { GenerateForm, type GenerateFormProps } from "./GenerateForm";
import { SeriesPlanEditor } from "./SeriesPlanEditor";
import { SeriesWriter } from "./series/[seriesId]/SeriesWriter";
import {
  addAngle,
  editAngle,
  moveAngle,
  planProblem,
  progressLabel,
  removeAngle,
  slotFromOutcome,
  writeInOrder,
  type Angle,
  type Slot,
  type WriteOutcome,
} from "./series-logic";

afterAll(() => setLlmForTests(null));
afterEach(() => setLlmForTests(null));

const angles = (n: number): Angle[] => Array.from({ length: n }, (_, i) => ({ title: `T${i + 1}`, description: `D${i + 1}` }));
const titles = (list: Angle[]) => list.map((a) => a.title);

const formProps: Omit<GenerateFormProps, "mode"> = {
  slug: "p",
  profiles: [{ id: "v", name: "Voice", isDefault: true }],
  accounts: [],
  defaults: { approval: "review_required", scheduling: "leave_as_draft" },
  mediaEnabled: false,
};

describe("series mode form", () => {
  it("asks for the number of posts and offers Plan series", () => {
    const html = renderToStaticMarkup(<GenerateForm {...formProps} mode="series" />);
    expect(html).toContain("Number of posts");
    expect(html).toContain("Plan series");
  });

  it("shows Planning… while pending", () => {
    const html = renderToStaticMarkup(<GenerateForm {...formProps} mode="series" initial={{ pending: true }} />);
    expect(html).toContain("Planning…");
  });
});

describe("plan editing", () => {
  it("edits, reorders, removes and adds within 1 to 10", () => {
    let list = angles(3);
    list = editAngle(list, 1, { title: "Edited" });
    expect(titles(list)).toEqual(["T1", "Edited", "T3"]);
    expect(titles(moveAngle(list, 1, -1))).toEqual(["Edited", "T1", "T3"]);
    expect(titles(moveAngle(list, 1, 1))).toEqual(["T1", "T3", "Edited"]);
    expect(titles(moveAngle(list, 0, -1))).toEqual(["T1", "Edited", "T3"]);
    expect(titles(removeAngle(list, 0))).toEqual(["Edited", "T3"]);
    expect(addAngle(list)).toHaveLength(4);
    expect(addAngle(angles(10))).toHaveLength(10);
  });

  it("blocks writing outside 1 to 10 angles and with blank ones", () => {
    expect(planProblem([])).toMatch(/at least 1/);
    expect(planProblem(angles(11))).toMatch(/at most 10/);
    expect(planProblem([{ title: "", description: "x" }])).toMatch(/Angle 1/);
    expect(planProblem(angles(1))).toBeNull();
    expect(planProblem(angles(10))).toBeNull();
  });

  it("renders Move up and Move down buttons, no drag handles, and disables Write posts out of range", () => {
    const html = renderToStaticMarkup(<SeriesPlanEditor slug="p" request={{}} initialAngles={angles(3)} />);
    expect(html.match(/Move up/g)).toHaveLength(3);
    expect(html.match(/Move down/g)).toHaveLength(3);
    expect(html).not.toContain("draggable");
    expect(html).toContain("Write posts");
    const empty = renderToStaticMarkup(<SeriesPlanEditor slug="p" request={{}} initialAngles={[]} />);
    expect(empty).toContain("Keep at least 1 angle");
    expect(empty).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Write posts/s);
  });
});

describe("SeriesWriter", () => {
  const done = (postId: string, position: number): WriteOutcome => ({
    ok: true,
    data: { ok: true, postId, position },
  });

  it("writes positions sequentially, in order", async () => {
    const calls: string[] = [];
    let active = 0;
    const write = vi.fn(async (position: number): Promise<WriteOutcome> => {
      active++;
      expect(active).toBe(1);
      calls.push(`start ${position}`);
      await new Promise((r) => setTimeout(r, 5));
      calls.push(`end ${position}`);
      active--;
      return done(`post-${position}`, position);
    });
    const seen: [number, Slot["state"]][] = [];
    await writeInOrder([0, 1, 2], write, (p, s) => seen.push([p, s.state]));
    expect(calls).toEqual(["start 0", "end 0", "start 1", "end 1", "start 2", "end 2"]);
    expect(seen).toEqual([[0, "writing"], [0, "done"], [1, "writing"], [1, "done"], [2, "writing"], [2, "done"]]);
  });

  it("carries on after a failure and reports it", async () => {
    const write = vi.fn(async (position: number): Promise<WriteOutcome> =>
      position === 1 ? { ok: true, data: { ok: false, message: "The model is unavailable", position } } : done(`p${position}`, position),
    );
    const slots: Slot[] = [{ state: "pending" }, { state: "pending" }, { state: "pending" }];
    await writeInOrder([0, 1, 2], write, (p, s) => (slots[p] = s));
    expect(slots.map((s) => s.state)).toEqual(["done", "failed", "done"]);
    expect(progressLabel(slots)).toBe("2 of 3 posts written. 1 failed.");
    expect(slotFromOutcome({ ok: false, error: "forbidden", message: "No" })).toEqual({ state: "failed", message: "No" });
  });

  it("states in progress, done and partial failure", () => {
    const render = (initialSlots: Slot[]) =>
      renderToStaticMarkup(<SeriesWriter slug="p" seriesId="s" angles={angles(initialSlots.length)} initialSlots={initialSlots} />);
    expect(render([{ state: "done", postId: "a" }, { state: "writing" }])).toContain("Writing post 2 of 2…");
    const finished = render([{ state: "done", postId: "a" }, { state: "done", postId: "b" }]);
    expect(finished).toContain("All 2 posts are written.");
    expect(finished).toContain('href="/p/p/generate/result/a"');
    const partial = render([{ state: "done", postId: "a" }, { state: "failed", message: "Too slow" }]);
    expect(partial).toContain("1 of 2 posts written. 1 failed.");
    expect(partial).toContain("Too slow");
    expect(partial).toContain("Try again");
  });
});
