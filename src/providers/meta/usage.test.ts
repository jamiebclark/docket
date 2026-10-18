import { describe, expect, it } from "vitest";
import { parseUsageHeader } from "./usage";

describe("parseUsageHeader", () => {
  it("returns null for null, empty string, and non-JSON", () => {
    expect(parseUsageHeader(null)).toBeNull();
    expect(parseUsageHeader("")).toBeNull();
    expect(parseUsageHeader("not json")).toBeNull();
  });

  it("returns null for JSON that is not an object", () => {
    expect(parseUsageHeader("42")).toBeNull();
    expect(parseUsageHeader("[1,2,3]")).toBeNull();
    expect(parseUsageHeader('"hello"')).toBeNull();
  });

  it("takes the max of call_count/total_cputime/total_time across multiple object ids", () => {
    const header = JSON.stringify({
      "123": [{ call_count: 10, total_cputime: 20, total_time: 15 }],
      "456": [{ call_count: 85, total_cputime: 5, total_time: 5 }],
    });
    const result = parseUsageHeader(header);
    expect(result).toEqual({ maxPercent: 85, retryAfterMinutes: null });
  });

  it("clamps maxPercent to [0, 100]", () => {
    const header = JSON.stringify({ "1": [{ call_count: 150 }] });
    expect(parseUsageHeader(header)).toEqual({ maxPercent: 100, retryAfterMinutes: null });
  });

  it("clamps estimated_time_to_regain_access to [0, 1440]", () => {
    const header = JSON.stringify({ "1": [{ call_count: 10, estimated_time_to_regain_access: 999999 }] });
    expect(parseUsageHeader(header)).toEqual({ maxPercent: 10, retryAfterMinutes: 1440 });
  });

  it("takes the maximum finite estimated_time_to_regain_access across ids", () => {
    const header = JSON.stringify({
      "1": [{ call_count: 10, estimated_time_to_regain_access: 5 }],
      "2": [{ call_count: 10, estimated_time_to_regain_access: 30 }],
    });
    expect(parseUsageHeader(header)).toEqual({ maxPercent: 10, retryAfterMinutes: 30 });
  });

  it("returns null when no usable number is found anywhere, never 0", () => {
    const header = JSON.stringify({ "1": [{ type: "instagram" }] });
    expect(parseUsageHeader(header)).toBeNull();
  });

  it("returns null when the value is an empty object", () => {
    expect(parseUsageHeader("{}")).toBeNull();
  });

  it("ignores non-finite values", () => {
    const header = JSON.stringify({ "1": [{ call_count: Number.NaN, total_cputime: 40 }] });
    expect(parseUsageHeader(header)).toEqual({ maxPercent: 40, retryAfterMinutes: null });
  });
});
