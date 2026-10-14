import { describe, expect, it } from "vitest";
import { createStandingSeriesSchema, datedPositionSchema, standingSeriesRunConfigSchema } from "./standing-series";

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

  it("requires a cadence when occurrenceRule is cadence (the default)", () => {
    const { cadence, ...withoutCadence } = base;
    expect(() => createStandingSeriesSchema.parse(withoutCadence)).toThrow(/Choose how often it posts/);
  });

  it("refuses a cadence for a dated series", () => {
    expect(() => createStandingSeriesSchema.parse({ ...base, occurrenceRule: "dated_list" })).toThrow(
      /A dated series has no cadence/,
    );
  });

  it("refuses lead time for a cadence series", () => {
    expect(() => createStandingSeriesSchema.parse({ ...base, leadDays: 3 })).toThrow(
      /Lead time only applies to a dated list/,
    );
  });

  it("accepts a dated series with no cadence and a lead time", () => {
    const { cadence, ...withoutCadence } = base;
    const result = createStandingSeriesSchema.parse({ ...withoutCadence, occurrenceRule: "dated_list", leadDays: 3 });
    expect(result.occurrenceRule).toBe("dated_list");
    expect(result.cadence).toBeUndefined();
    expect(result.leadDays).toBe(3);
  });
});

describe("standingSeriesRunConfigSchema", () => {
  it("round-trips the snapshot shape", () => {
    const config = {
      v: 1 as const,
      rule: "cadence" as const,
      brief: base.brief,
      template: base.template,
      templateFields: [],
      voiceProfileId: base.voiceProfileId,
      targetAccountIds: base.targetAccountIds,
      cadence: base.cadence,
      leadDays: 0,
      media: base.media,
      requested: { approval: null, scheduling: null },
      resolved: { approval: "review_required" as const, scheduling: "leave_as_draft" as const },
    };
    const parsed = standingSeriesRunConfigSchema.parse(config);
    expect(parsed).toEqual(config);
  });

  it("parses an old cadence-only config stored before this feature, with no rule or leadDays", () => {
    const old = {
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
    const parsed = standingSeriesRunConfigSchema.parse(old);
    expect(parsed.rule).toBe("cadence");
    expect(parsed.leadDays).toBe(0);
  });
});

describe("datedPositionSchema", () => {
  it("parses the position's dated payload", () => {
    const dated = {
      v: 1 as const,
      rowId: "33333333-3333-4333-8333-333333333333",
      year: 2027,
      targetDate: "2027-03-14",
      keyValue: "Ada Lovelace",
      values: { name: "Ada Lovelace" },
      mediaAssetId: null,
      mediaFilename: null,
    };
    expect(datedPositionSchema.parse(dated)).toEqual(dated);
  });
});
