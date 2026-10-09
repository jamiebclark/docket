import { describe, expect, it } from "vitest";
import { firstWithoutActiveSlot, hasActiveSlot } from "./slots";

const c = (accountId: string, providerAvailable: boolean, active: number) => ({ accountId, providerAvailable, active });

describe("hasActiveSlot", () => {
  it("needs an available provider and an unpaused slot", () => {
    expect(hasActiveSlot(c("a", true, 1))).toBe(true);
    expect(hasActiveSlot(c("a", true, 0))).toBe(false); // all paused
    expect(hasActiveSlot(c("a", false, 3))).toBe(false); // unavailable provider
  });
});

describe("firstWithoutActiveSlot", () => {
  it("prefers an available account", () => {
    expect(firstWithoutActiveSlot([c("a", false, 0), c("b", true, 0), c("c", true, 2)])?.accountId).toBe("b");
    expect(firstWithoutActiveSlot([c("a", false, 0)])?.accountId).toBe("a");
  });
  it("is null when all have slots", () => {
    expect(firstWithoutActiveSlot([c("a", true, 1)])).toBeNull();
  });
});
