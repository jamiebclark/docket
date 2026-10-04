import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_VOICE_CONTENT } from "@/lib/validation/voice";
import type { ProjectScope } from "../../dal/scope";
import { createFakeLlm } from "../../../../tests/helpers/fake-llm";
import { runGeneration, type CoreRequest } from "./core";

const prepare = vi.hoisted(() => vi.fn());
vi.mock("../../llm/images", () => ({ imagesForModel: prepare }));

const scope = { media: {} } as unknown as ProjectScope;
const req: CoreRequest = {
  label: "generate.single",
  voice: { content: EMPTY_VOICE_CONTENT },
  providerKeys: ["bluesky"],
  assets: [],
  inputs: { brief: "Sale day", sourceText: null, instructions: null, series: null },
};
const good = { variants: { bluesky: { text: "Sale today" } } };
const long = { variants: { bluesky: { text: "a".repeat(312) } } };

beforeEach(() => prepare.mockResolvedValue({ ok: true, images: [], record: [] }));

describe("runGeneration", () => {
  it("makes one call for a valid answer", async () => {
    const llm = createFakeLlm([{ ok: good }]);
    const r = await runGeneration(scope, req, llm);
    expect(r).toMatchObject({ ok: true, output: { variants: { bluesky: "Sale today" }, imageAltTexts: null }, retried: null });
    expect(llm.requests).toHaveLength(1);
    expect(llm.remaining()).toBe(0);
  });

  it("retries once with the platform problem in the prompt", async () => {
    const llm = createFakeLlm([{ ok: long }, { ok: good }]);
    const r = await runGeneration(scope, req, llm);
    expect(r.ok && r.remainingProblems).toEqual([]);
    expect(r.ok && r.retried?.reason).toBe("invalid_platform");
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]!.user).toContain("bluesky: Text is 312 graphemes; the limit is 300.");
    expect(llm.remaining()).toBe(0);
  });

  it("returns ok with remaining problems after two invalid answers, never a third call", async () => {
    const llm = createFakeLlm([{ ok: long }, { ok: long }, { ok: good }]);
    const r = await runGeneration(scope, req, llm);
    expect(r.ok && r.remainingProblems).toEqual([{ providerKey: "bluesky", messages: ["Text is 312 graphemes; the limit is 300."] }]);
    expect(llm.requests).toHaveLength(2);
    expect(llm.remaining()).toBe(1);
  });

  it("fails when the answer is unreadable twice", async () => {
    const llm = createFakeLlm([{ raw: "nope" }, { raw: "still nope" }]);
    const r = await runGeneration(scope, req, llm);
    expect(r).toMatchObject({ ok: false, kind: "invalid_output" });
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]!.user).toContain("nope");
  });

  it("retries after a refusal", async () => {
    const llm = createFakeLlm([{ fail: "refused" }, { ok: good }]);
    const r = await runGeneration(scope, req, llm);
    expect(r).toMatchObject({ ok: true, retried: { reason: "refused" } });
    expect(llm.requests).toHaveLength(2);
    expect(llm.remaining()).toBe(0);
  });

  it("fails with timeout after two timeouts", async () => {
    const llm = createFakeLlm([{ fail: "timeout" }, { fail: "timeout" }]);
    expect(await runGeneration(scope, req, llm)).toMatchObject({ ok: false, kind: "timeout" });
    expect(llm.requests).toHaveLength(2);
    expect(llm.remaining()).toBe(0);
  });

  it.each(["rate_limited", "unavailable", "auth", "bad_request"] as const)("does not retry %s", async (kind) => {
    const llm = createFakeLlm([{ fail: kind }, { ok: good }]);
    expect(await runGeneration(scope, req, llm)).toMatchObject({ ok: false, kind });
    expect(llm.requests).toHaveLength(1);
    expect(llm.remaining()).toBe(1);
  });

  it("throws before any call when images cannot be prepared", async () => {
    prepare.mockResolvedValue({ ok: false, message: "Media storage is not set up." });
    const llm = createFakeLlm([{ ok: good }]);
    await expect(runGeneration(scope, req, llm)).rejects.toThrow("Media storage is not set up.");
    expect(llm.requests).toHaveLength(0);
  });
});
