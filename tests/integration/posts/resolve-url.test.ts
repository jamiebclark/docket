import { describe, expect, it } from "vitest";
import { externalUrlSchema } from "../../../src/lib/validation/scheduling";
import { safeExternalHref } from "../../../src/lib/safe-redirect";

describe("resolve link rules", () => {
  it.each(["http://example.test/a", "https://example.test/a?b=1#c", "https://bsky.app/profile/x/post/1"])("accepts %s", (u) => {
    expect(externalUrlSchema.safeParse(u).success).toBe(true);
    expect(safeExternalHref(u)).not.toBeNull();
  });

  it.each(["javascript:alert(1)", "data:text/html,x", "ftp://example.test", "https://u:p@example.test", "//example.test", ""])("refuses %j", (u) => {
    expect(externalUrlSchema.safeParse(u).success).toBe(false);
    expect(safeExternalHref(u)).toBeNull();
  });
});
