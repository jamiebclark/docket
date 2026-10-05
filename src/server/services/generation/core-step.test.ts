import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_VOICE_CONTENT } from "@/lib/validation/voice";
import type { ProjectScope } from "../../dal/scope";
import { createFakeLlm } from "../../../../tests/helpers/fake-llm";
import { groupsOfPlatforms } from "./__fixtures__/cases";
import { runGenerationStep, type CoreRequest } from "./core";

const prepare = vi.hoisted(() => vi.fn());
vi.mock("../../llm/images", () => ({ imagesForModel: prepare }));

const scope = { media: {} } as unknown as ProjectScope;
const req: CoreRequest = {
  label: "generate.job_item",
  voice: { content: EMPTY_VOICE_CONTENT },
  groups: groupsOfPlatforms(["bluesky"]),
  assets: [],
  inputs: { brief: "Sale day", sourceText: null, instructions: null, series: null },
};
const good = { variants: { bluesky: { text: "Sale today" } } };
const long = { variants: { bluesky: { text: "a".repeat(312) } } };

beforeEach(() => prepare.mockResolvedValue({ ok: true, images: [], record: [] }));

describe("runGenerationStep", () => {
  it("defers the correction retry after exactly one call when there is no time", async () => {
    const llm = createFakeLlm([{ ok: long }, { ok: good }]);
    const step = await runGenerationStep(scope, req, llm, { retryWindowMs: async () => null });
    expect(step).toMatchObject({ ok: "retry", pending: { reason: "invalid_platform" } });
    expect(llm.requests).toHaveLength(1);
    expect(step.ok === "retry" && step.pending.attempts).toHaveLength(1);
  });

  it("returns retry without a window callback too", async () => {
    const llm = createFakeLlm([{ fail: "refused" }]);
    const step = await runGenerationStep(scope, req, llm);
    expect(step).toMatchObject({ ok: "retry", pending: { reason: "refused" } });
    expect(llm.requests).toHaveLength(1);
  });

  it("resumes with exactly one call and records both attempts", async () => {
    const first = createFakeLlm([{ ok: long }]);
    const step = await runGenerationStep(scope, req, first, { retryWindowMs: async () => null });
    if (step.ok !== "retry") throw new Error("expected retry");

    const llm = createFakeLlm([{ ok: good }, { ok: good }]);
    const done = await runGenerationStep(scope, req, llm, { pending: step.pending });
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]!.user).toContain("Text is 312 graphemes");
    expect(done).toMatchObject({ ok: true, retried: { reason: "invalid_platform" } });
    expect(done.ok === true && done.attempts.map((a) => a.kind)).toEqual(["invalid_platform", "ok"]);
  });

  it("runs the retry in the same step when a window is given, and passes it as the timeout", async () => {
    const llm = createFakeLlm([{ ok: long }, { ok: good }]);
    const done = await runGenerationStep({ ...scope } as ProjectScope, { ...req, timeoutMs: 9000 }, llm, {
      retryWindowMs: async () => 4000,
    });
    expect(done.ok).toBe(true);
    expect(llm.requests.map((r) => r.timeoutMs)).toEqual([9000, 4000]);
  });

  it("passes timeoutMs to llm.generate and omits it when absent", async () => {
    const withT = createFakeLlm([{ ok: good }]);
    await runGenerationStep(scope, { ...req, timeoutMs: 7000 }, withT);
    expect(withT.requests[0]!.timeoutMs).toBe(7000);
    const without = createFakeLlm([{ ok: good }]);
    await runGenerationStep(scope, req, without);
    expect(without.requests[0]!.timeoutMs).toBeUndefined();
  });

  it("sends item data in the prompt", async () => {
    const llm = createFakeLlm([{ ok: good }]);
    await runGenerationStep(scope, { ...req, itemData: { fields: [["product", "Blue mug"]] } }, llm);
    expect(llm.requests[0]!.user).toContain("<item_data>");
    expect(llm.requests[0]!.user).toContain("product: Blue mug");
  });
});
