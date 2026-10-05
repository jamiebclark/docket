import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { fitsSegmented } from "./ChoiceField";
import { Combobox, filterOptions } from "./Combobox";
import { SegmentedControl } from "./SegmentedControl";
import { timeZoneOptions } from "./TimeZoneField";

const opts = (...labels: string[]) => labels.map((l) => ({ value: l.toLowerCase(), label: l }));

describe("ChoiceField sizing", () => {
  it("uses a button row for up to five short options and an autocomplete beyond", () => {
    expect(fitsSegmented(opts("Editor", "Admin", "Owner"))).toBe(true);
    expect(fitsSegmented(opts("A", "B", "C", "D", "E", "F"))).toBe(false);
    expect(fitsSegmented(opts("A label far too long to sit in a button row"))).toBe(false);
  });
});

describe("Combobox filtering", () => {
  const zones = [
    { value: "America/New_York", label: "America/New York", description: "GMT-4" },
    { value: "Europe/London", label: "Europe/London", description: "GMT+1" },
    { value: "America/Los_Angeles", label: "America/Los Angeles", description: "GMT-7" },
  ];
  it("matches every typed word against label, value and description, ignoring _ / - and case", () => {
    expect(filterOptions(zones, "new york").map((o) => o.value)).toEqual(["America/New_York"]);
    expect(filterOptions(zones, "new_york").map((o) => o.value)).toEqual(["America/New_York"]);
    expect(filterOptions(zones, "america").length).toBe(2);
    expect(filterOptions(zones, "gmt+1").map((o) => o.value)).toEqual(["Europe/London"]);
    expect(filterOptions(zones, "  ")).toHaveLength(3);
    expect(filterOptions(zones, "tokyo")).toEqual([]);
  });

  it("submits the value through a hidden input and renders no options until opened", () => {
    const html = renderToStaticMarkup(
      createElement(Combobox, { id: "tz", name: "timezone", label: "Time zone", options: zones, defaultValue: "Europe/London" }),
    );
    expect(html).toMatch(/role="combobox"/);
    expect(html).toMatch(/aria-expanded="false"/);
    expect(html).toContain('type="hidden" name="timezone" value="Europe/London"');
    expect(html).toContain('value="Europe/London"');
    expect(html).not.toContain('role="option"');
  });
});

describe("SegmentedControl", () => {
  it("is a labelled radio group that submits under its name", () => {
    const html = renderToStaticMarkup(createElement(SegmentedControl, { name: "role", label: "Role", defaultValue: "admin", options: opts("Editor", "Admin") }));
    expect(html).toContain("<legend");
    expect(html).toContain(">Role</legend>");
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html).toMatch(/<input type="radio"(?=[^>]*value="admin")(?=[^>]*checked)[^>]*>/);
  });
});

describe("time zone options", () => {
  it("lists UTC and IANA zones with their current offset", () => {
    const all = timeZoneOptions();
    expect(all.some((o) => o.value === "UTC")).toBe(true);
    const ny = all.find((o) => o.value === "America/New_York");
    expect(ny?.label).toBe("America/New York");
    expect(ny?.description).toMatch(/^GMT[-+]\d/);
  });
});
