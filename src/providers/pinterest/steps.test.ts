import { describe, expect, it } from "vitest";
import { pinterestStepFor } from "./steps";

describe("pinterestStepFor", () => {
  it("returns create_pin, mayPublish true for null state", () => {
    expect(pinterestStepFor(null)).toEqual({ name: "create_pin", mayPublish: true });
  });

  it("returns create_pin, mayPublish true for any junk state", () => {
    expect(pinterestStepFor(undefined)).toEqual({ name: "create_pin", mayPublish: true });
    expect(pinterestStepFor("garbage")).toEqual({ name: "create_pin", mayPublish: true });
    expect(pinterestStepFor(42)).toEqual({ name: "create_pin", mayPublish: true });
    expect(pinterestStepFor({ v: 99, anything: "goes" })).toEqual({ name: "create_pin", mayPublish: true });
    expect(pinterestStepFor([1, 2, 3])).toEqual({ name: "create_pin", mayPublish: true });
  });
});
