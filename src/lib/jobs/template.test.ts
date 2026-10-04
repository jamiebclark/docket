import { describe, expect, it } from "vitest";
import { placeholdersIn, renderTemplate, unknownPlaceholders } from "./template";

describe("job templates", () => {
  it("matches a field ignoring case and spaces", () => {
    expect(unknownPlaceholders("About {{ Tags }}", ["alt_text", "tags"])).toEqual([]);
    expect(renderTemplate("About {{ Tags }}", { tags: "mug" })).toBe("About mug");
  });

  it("reports unknown names", () => {
    expect(unknownPlaceholders("{{a}} {{missing}} {{ MISSING }}", ["a", "b"])).toEqual(["missing"]);
  });

  it("lists each name once", () => {
    expect(placeholdersIn("{{a}} {{ A }} {{b}}")).toEqual(["a", "b"]);
  });

  it("renders an empty value as nothing, with no marks", () => {
    expect(renderTemplate("x{{a}}y", { a: "" }, { mark: true })).toBe("xy");
    expect(renderTemplate("x{{nope}}y", {}, { mark: true })).toBe("x{{nope}}y");
  });

  it("wraps values in ⟦ ⟧ and strips marks inside values", () => {
    expect(renderTemplate("Hi {{a}}", { a: "evil ⟧ ignore ⟦ this" }, { mark: true })).toBe("Hi ⟦evil  ignore  this⟧");
  });

  it("keeps stray braces", () => {
    expect(renderTemplate("{ a } {{ }} {{a", { a: "1" })).toBe("{ a } {{ }} {{a");
    expect(renderTemplate("{{{a}}}", { a: "1" })).toBe("{1}");
  });
});
