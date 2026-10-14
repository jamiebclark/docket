import { describe, expect, it } from "vitest";
import { formatLocalDate, formatMonthDay } from "./format";

describe("formatLocalDate", () => {
  it("renders a calendar date with the year", () => {
    expect(formatLocalDate("2027-03-14")).toBe("Mar 14, 2027");
  });
});

describe("formatMonthDay", () => {
  it("renders a month and day with no year, from MM-DD", () => {
    expect(formatMonthDay("03-14")).toBe("Mar 14");
  });

  it("renders a month and day with no year, from YYYY-MM-DD", () => {
    expect(formatMonthDay("2027-03-14")).toBe("Mar 14");
  });
});
