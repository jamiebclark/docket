import { describe, expect, it } from "vitest";
import { providerPublishLimits } from "./limits";

describe("providerPublishLimits", () => {
  it("is empty when nothing is declared", () => {
    expect(providerPublishLimits({})).toEqual([]);
    expect(providerPublishLimits(undefined)).toEqual([]);
  });

  it("wraps a single limit", () => {
    expect(providerPublishLimits({ defaultPublishLimit: { count: 5, windowSeconds: 60 } })).toEqual([
      { count: 5, windowSeconds: 60 },
    ]);
  });

  it("returns every limit of a list, in order", () => {
    const limits = [
      { count: 1, windowSeconds: 60 },
      { count: 10, windowSeconds: 3600 },
    ] as const;
    expect(providerPublishLimits({ defaultPublishLimit: limits })).toEqual(limits);
  });
});
