import { describe, expect, it } from "vitest";
import { DOCS_BASE_URL, docsHref, docsUrl } from "./docs";

describe("docsHref", () => {
  it("resolves a page#anchor pointer the same way docsUrl would", () => {
    expect(docsHref("meta-setup#engagement")).toBe(docsUrl("meta-setup", "engagement"));
  });

  it("resolves a bare page with no anchor", () => {
    expect(docsHref("accounts")).toBe(docsUrl("accounts"));
  });

  it("returns the docs base rather than throwing on an unknown page", () => {
    expect(docsHref("not-a-real-page#anchor")).toBe(DOCS_BASE_URL);
  });
});
