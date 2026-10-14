import { describe, expect, it } from "vitest";
import { createStandingSeriesSchema, standingSeriesRunConfigSchema } from "./standing-series";

const base = {
  name: "Weekly tips",
  brief: "Short actionable tips",
  template: "Write one tip about {{topic}}",
  voiceProfileId: "11111111-1111-4111-8111-111111111111",
  targetAccountIds: ["22222222-2222-4222-8222-222222222222"],
  cadence: { count: 3, period: "week" as const },
  media: { source: "none" as const },
};

describe("createStandingSeriesSchema", () => {
  it("accepts a well-formed input", () => {
    const result = createStandingSeriesSchema.parse(base);
    expect(result.name).toBe("Weekly tips");
    expect(result.confirmUnreviewedQueue).toBe(false);
  });

  it("rejects a cadence count outside bounds", () => {
    expect(() => createStandingSeriesSchema.parse({ ...base, cadence: { count: 0, period: "week" } })).toThrow();
    expect(() => createStandingSeriesSchema.parse({ ...base, cadence: { count: 11, period: "week" } })).toThrow();
  });

  it("accepts the none media branch", () => {
    const result = createStandingSeriesSchema.parse({ ...base, media: { source: "none" } });
    expect(result.media).toEqual({ source: "none" });
  });

  it("accepts the pool media branch with an optional tag", () => {
    const result = createStandingSeriesSchema.parse({ ...base, media: { source: "pool", tag: "brand" } });
    expect(result.media).toEqual({ source: "pool", tag: "brand" });
  });

  it("accepts the generate media branch requiring a prompt", () => {
    const result = createStandingSeriesSchema.parse({
      ...base,
      media: { source: "generate", prompt: "a photo of coffee" },
    });
    expect(result.media).toEqual({ source: "generate", prompt: "a photo of coffee" });
  });

  it("rejects the generate media branch without a prompt", () => {
    expect(() => createStandingSeriesSchema.parse({ ...base, media: { source: "generate" } })).toThrow();
  });
});

describe("standingSeriesRunConfigSchema", () => {
  it("round-trips the snapshot shape", () => {
    const config = {
      v: 1 as const,
      brief: base.brief,
      template: base.template,
      templateFields: [],
      voiceProfileId: base.voiceProfileId,
      targetAccountIds: base.targetAccountIds,
      cadence: base.cadence,
      media: base.media,
      requested: { approval: null, scheduling: null },
      resolved: { approval: "review_required" as const, scheduling: "leave_as_draft" as const },
    };
    const parsed = standingSeriesRunConfigSchema.parse(config);
    expect(parsed).toEqual(config);
  });
});
