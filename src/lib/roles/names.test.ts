import { describe, expect, it } from "vitest";
import { askManagers, askOwners, joinNames, managersOf } from "./names";

describe("joinNames", () => {
  it("uses the default and a custom fallback", () => {
    expect(joinNames([], "or")).toBe("an owner or admin");
    expect(joinNames([" "], "or", "an owner")).toBe("an owner");
    expect(joinNames(["A", "B", "C", "D"], "and")).toBe("A, B, C and 1 other");
  });
});

describe("managersOf", () => {
  const rows = [
    { name: "Ed", role: "editor", email: "ed@x.test", userId: "u1" },
    { name: "Ada", role: "admin", email: "ada@x.test", userId: "u2" },
    { name: "Olu", role: "owner", email: "olu@x.test", userId: "u3" },
    { name: "Bo", role: "admin", email: "bo@x.test", userId: "u4" },
  ];
  it("lists owners first, then admins, in input order", () => {
    expect(managersOf(rows).map((m) => m.name)).toEqual(["Olu", "Ada", "Bo"]);
  });
  it("returns only name and role", () => {
    for (const m of managersOf(rows)) expect(Object.keys(m).sort()).toEqual(["name", "role"]);
  });
});

describe("askManagers / askOwners", () => {
  const m = managersOf([
    { name: "Olu", role: "owner" },
    { name: "Ada", role: "admin" },
  ]);
  it("names managers or owners", () => {
    expect(askManagers(m, "or")).toBe("Olu or Ada");
    expect(askOwners(m, "and")).toBe("Olu");
  });
  it("falls back when nobody is named", () => {
    expect(askManagers([], "or")).toBe("an owner or admin");
    expect(askOwners([{ name: "Ada", role: "admin" }], "or")).toBe("an owner");
  });
});
