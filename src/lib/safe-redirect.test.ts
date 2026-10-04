import { describe, expect, it } from "vitest";
import { safeExternalHref, safeRedirect } from "./safe-redirect";

describe("safeRedirect", () => {
  it("accepts same-origin relative paths", () => {
    expect(safeRedirect("/p/acme")).toBe("/p/acme");
    expect(safeRedirect("/invitations?x=1")).toBe("/invitations?x=1");
  });

  it.each(["//evil.com", "https://evil.com", "/\\evil.com", "\\\\evil", "evil", "", "/a\nb"])(
    "rejects %j",
    (value) => {
      expect(safeRedirect(value, "/fallback")).toBe("/fallback");
    },
  );

  it("rejects non-strings and defaults the fallback to /", () => {
    expect(safeRedirect(undefined)).toBe("/");
    expect(safeRedirect(42)).toBe("/");
  });
});

describe("safeExternalHref", () => {
  it("returns http(s) links", () => {
    expect(safeExternalHref("https://example.com/a")).toBe("https://example.com/a");
  });

  it.each(["javascript:alert(1)", "data:text/html,x", "//evil.com", "/relative", "https://u:p@example.com", "", null, 5])(
    "returns null for %j",
    (value) => {
      expect(safeExternalHref(value)).toBeNull();
    },
  );
});
