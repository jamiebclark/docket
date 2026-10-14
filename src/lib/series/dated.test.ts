import { Temporal } from "@js-temporal/polyfill";
import { describe, expect, it } from "vitest";
import {
  dueInstant,
  isEligible,
  localToday,
  nextTargetDate,
  parseDatedValue,
  targetDateFor,
  upcoming,
  windowEnd,
} from "./dated";

describe("parseDatedValue", () => {
  it("accepts MM-DD and YYYY-MM-DD, trimmed", () => {
    expect(parseDatedValue("03-14")).toEqual({ month: 3, day: 14, year: null });
    expect(parseDatedValue("2027-03-14")).toEqual({ month: 3, day: 14, year: 2027 });
    expect(parseDatedValue(" 03-14 ")).toEqual({ month: 3, day: 14, year: null });
  });

  it("accepts 02-29 with no year and a leap-year 02-29", () => {
    expect(parseDatedValue("02-29")).toEqual({ month: 2, day: 29, year: null });
    expect(parseDatedValue("2028-02-29")).toEqual({ month: 2, day: 29, year: 2028 });
  });

  it.each(["3/14", "Mar 14", "14 March", "3-14", "2027/03/14", "03-14-2027", ""])(
    "rejects %s as format",
    (raw) => {
      expect(parseDatedValue(raw)).toEqual({ error: "format" });
    },
  );

  it.each(["02-30", "13-01", "14-03", "00-05", "04-31", "2027-02-29"])("rejects %s as impossible", (raw) => {
    expect(parseDatedValue(raw)).toEqual({ error: "impossible" });
  });
});

describe("targetDateFor", () => {
  it("resolves 02-29 to the leap day in a leap year", () => {
    const d = targetDateFor({ month: 2, day: 29, year: null }, 2028);
    expect(d.toString()).toBe("2028-02-29");
  });

  it("resolves 02-29 to 02-28 in a non-leap year, never 03-01", () => {
    const d = targetDateFor({ month: 2, day: 29, year: null }, 2027);
    expect(d.toString()).toBe("2027-02-28");
  });
});

describe("nextTargetDate", () => {
  it("rolls an every-year row to the next year once fired", () => {
    const spec = { month: 3, day: 14, year: null };
    const today = Temporal.PlainDate.from("2027-06-01");
    const next = nextTargetDate(spec, today, [2027]);
    expect(next?.toString()).toBe("2028-03-14");
  });

  it("returns a year-specific row's date once, then null", () => {
    const spec = { month: 3, day: 14, year: 2027 };
    const today = Temporal.PlainDate.from("2027-01-01");
    expect(nextTargetDate(spec, today, [])?.toString()).toBe("2027-03-14");
    expect(nextTargetDate(spec, today, [2027])).toBeNull();
  });

  it("returns null for a year-specific row whose year is past", () => {
    const spec = { month: 3, day: 14, year: 2020 };
    const today = Temporal.PlainDate.from("2027-01-01");
    expect(nextTargetDate(spec, today, [])).toBeNull();
  });

  it("returns today when the row's date is today (inside its window)", () => {
    const spec = { month: 6, day: 1, year: null };
    const today = Temporal.PlainDate.from("2027-06-01");
    expect(nextTargetDate(spec, today, [])?.toString()).toBe("2027-06-01");
  });
});

describe("isEligible agrees with dueInstant/windowEnd", () => {
  const zones = ["America/New_York", "Pacific/Auckland"];
  const leadDaysCases = [0, 1, 30];
  const target = Temporal.PlainDate.from("2027-03-14");

  for (const zone of zones) {
    for (const leadDays of leadDaysCases) {
      it(`${zone} leadDays=${leadDays} across the day`, () => {
        const due = dueInstant(target, leadDays, zone);
        const end = windowEnd(target, zone);
        for (let h = -40; h < 40; h += 4) {
          const now = new Date(due.getTime() + h * 3600 * 1000);
          const today = localToday(now, zone);
          const expected = due.getTime() <= now.getTime() && now.getTime() < end.getTime();
          expect(isEligible(target, leadDays, today)).toBe(expected);
        }
      });
    }
  }
});

describe("dueInstant disambiguation", () => {
  it("resolves to exactly one instant in Australia/Lord_Howe and Asia/Kathmandu", () => {
    const target = Temporal.PlainDate.from("2027-03-14");
    expect(dueInstant(target, 0, "Australia/Lord_Howe")).toBeInstanceOf(Date);
    expect(dueInstant(target, 0, "Asia/Kathmandu")).toBeInstanceOf(Date);
  });
});

describe("upcoming", () => {
  it("orders by target date and omits rows with no next target date", () => {
    const rows = [
      { id: "a", keyValue: "Ada", nextTargetDate: "2027-05-01" },
      { id: "b", keyValue: "Bob", nextTargetDate: null },
      { id: "c", keyValue: "Cid", nextTargetDate: "2027-01-01" },
    ];
    const result = upcoming(rows, 0, "UTC", 10);
    expect(result.map((r) => r.rowId)).toEqual(["c", "a"]);
  });

  it("respects the limit", () => {
    const rows = [
      { id: "a", keyValue: "Ada", nextTargetDate: "2027-05-01" },
      { id: "c", keyValue: "Cid", nextTargetDate: "2027-01-01" },
    ];
    expect(upcoming(rows, 0, "UTC", 1)).toHaveLength(1);
  });
});
