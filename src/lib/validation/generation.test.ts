import { describe, expect, it } from "vitest";
import { generationInputsSchema, generationMetadataSchema } from "./generation";

const id = "11111111-1111-4111-8111-111111111111";
const inputs = { brief: "Launch", sourceText: null, instructions: null, mediaAssetIds: [], targetAccountIds: [id], series: null };

describe("generationInputsSchema", () => {
  it("accepts a minimal input and enforces limits", () => {
    expect(generationInputsSchema.safeParse(inputs).success).toBe(true);
    expect(generationInputsSchema.safeParse({ ...inputs, brief: "  " }).success).toBe(false);
    expect(generationInputsSchema.safeParse({ ...inputs, brief: "x".repeat(2001) }).success).toBe(false);
    expect(generationInputsSchema.safeParse({ ...inputs, sourceText: "x".repeat(50_001) }).success).toBe(false);
    expect(generationInputsSchema.safeParse({ ...inputs, targetAccountIds: [] }).success).toBe(false);
    expect(generationInputsSchema.safeParse({ ...inputs, targetAccountIds: [id, id] }).success).toBe(false);
    expect(generationInputsSchema.safeParse({ ...inputs, mediaAssetIds: Array.from({ length: 11 }, () => id) }).success).toBe(false);
  });
});

describe("generationMetadataSchema", () => {
  it("round-trips a record", () => {
    const record = {
      at: "2026-01-01T00:00:00.000Z",
      mode: "single",
      provider: "openai",
      model: "m",
      voiceProfile: { id, versionId: id, version: 1, name: "Brand" },
      inputs,
      prompt: { system: "s", user: "u", images: [] },
      policies: {
        requested: { approval: null, scheduling: null },
        resolved: { approval: "review_required", scheduling: "leave_as_draft" },
        decision: { reviewState: "needs_review", queued: false, reason: "Review required" },
      },
      attempts: [{ kind: "ok", latencyMs: 10, usage: { inputTokens: 1, outputTokens: 2 } }],
      retried: null,
      output: { variants: { bluesky: "hi" }, imageAltTexts: null },
      remainingProblems: [],
    };
    expect(generationMetadataSchema.safeParse({ v: 1, records: [record] }).success).toBe(true);
    expect(generationMetadataSchema.safeParse({ v: 2, records: [] }).success).toBe(false);
    expect(generationMetadataSchema.safeParse({ v: 1, records: [{ ...record, mode: "series_plan" }] }).success).toBe(false);
  });
});
