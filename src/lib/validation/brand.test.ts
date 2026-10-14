import { describe, expect, it } from "vitest";
import {
  BRAND_DESCRIPTION_MAX,
  brandDescriptionSchema,
  brandWebsiteSchema,
  normaliseBrandLine,
  normaliseBrandText,
  TAGLINE_MAX,
  taglineSchema,
} from "./brand";
import { HTTP_LINK_MESSAGE, LINK_URL_LENGTH_MESSAGE, LINK_URL_MAX } from "./link";

describe("taglineSchema", () => {
  it("accepts exactly 200 characters and refuses 201", () => {
    expect(taglineSchema.safeParse("x".repeat(TAGLINE_MAX)).success).toBe(true);
    const over = taglineSchema.safeParse("x".repeat(TAGLINE_MAX + 1));
    expect(over.success).toBe(false);
    expect(over.error?.issues[0]?.message).toBe(`Keep this to ${TAGLINE_MAX} characters or fewer`);
  });

  it("collapses newlines (and surrounding spaces) to a single space", () => {
    expect(taglineSchema.parse("Ships your posts.\r\n  On time.")).toBe("Ships your posts. On time.");
    expect(taglineSchema.parse("A\n\n\nB")).toBe("A B");
  });

  it("normalises whitespace-only input to null", () => {
    expect(taglineSchema.parse("")).toBeNull();
    expect(taglineSchema.parse("   ")).toBeNull();
    expect(taglineSchema.parse("\r\n \n")).toBeNull();
  });

  it("accepts a value that normalises under the limit even if the raw input is over", () => {
    const raw = "x".repeat(99) + "\r\n".repeat(55) + "x".repeat(99);
    expect(raw.length).toBeGreaterThan(TAGLINE_MAX);
    const result = taglineSchema.safeParse(raw);
    expect(result.success).toBe(true);
    expect((result.data ?? "").length).toBeLessThanOrEqual(TAGLINE_MAX);
  });

  it("refuses a value with no whitespace to collapse once over the limit", () => {
    expect(taglineSchema.safeParse("x".repeat(205)).success).toBe(false);
  });
});

describe("brandDescriptionSchema", () => {
  it("accepts exactly 1000 characters and refuses 1001", () => {
    expect(brandDescriptionSchema.safeParse("x".repeat(BRAND_DESCRIPTION_MAX)).success).toBe(true);
    const over = brandDescriptionSchema.safeParse("x".repeat(BRAND_DESCRIPTION_MAX + 1));
    expect(over.success).toBe(false);
    expect(over.error?.issues[0]?.message).toBe(`Keep this to ${BRAND_DESCRIPTION_MAX} characters or fewer`);
  });

  it("preserves paragraph breaks while normalising CRLF to LF", () => {
    expect(brandDescriptionSchema.parse("Para one.\r\n\r\nPara two.  ")).toBe("Para one.\n\nPara two.");
  });

  it("normalises whitespace-only input to null", () => {
    expect(brandDescriptionSchema.parse("")).toBeNull();
    expect(brandDescriptionSchema.parse("   ")).toBeNull();
  });
});

describe("normaliseBrandLine / normaliseBrandText", () => {
  it("normaliseBrandLine collapses runs of CR/LF with surrounding spaces to one space", () => {
    expect(normaliseBrandLine("a \n b")).toBe("a b");
    expect(normaliseBrandLine("   ")).toBeNull();
  });

  it("normaliseBrandText keeps interior blank lines", () => {
    expect(normaliseBrandText("a\r\n\r\nb")).toBe("a\n\nb");
    expect(normaliseBrandText("   ")).toBeNull();
  });
});

describe("brandWebsiteSchema", () => {
  it("accepts a valid http(s) link and trims it", () => {
    expect(brandWebsiteSchema.parse("  https://x.test ")).toBe("https://x.test");
  });

  it("normalises empty/whitespace-only input to null", () => {
    expect(brandWebsiteSchema.parse("")).toBeNull();
    expect(brandWebsiteSchema.parse("   ")).toBeNull();
  });

  it.each([
    ["example.com", HTTP_LINK_MESSAGE],
    ["//example.test", HTTP_LINK_MESSAGE],
    ["/about", HTTP_LINK_MESSAGE],
    ["ftp://x.test", HTTP_LINK_MESSAGE],
    ["javascript:alert(1)", HTTP_LINK_MESSAGE],
    ["data:text/html,x", HTTP_LINK_MESSAGE],
    ["file:///x", HTTP_LINK_MESSAGE],
    ["https://example.test/" + "x".repeat(500), LINK_URL_LENGTH_MESSAGE],
  ])("refuses %s with %s", (input, message) => {
    const result = brandWebsiteSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(message);
  });

  it("accepts an uppercase scheme (the WHATWG parser lower-cases it)", () => {
    expect(brandWebsiteSchema.parse("HTTPS://example.test/x")).toBe("HTTPS://example.test/x");
  });

  it("accepts a URL of exactly LINK_URL_MAX characters and refuses one over", () => {
    const prefix = "https://example.test/";
    const atMax = prefix + "x".repeat(LINK_URL_MAX - prefix.length);
    expect(atMax.length).toBe(LINK_URL_MAX);
    expect(brandWebsiteSchema.safeParse(atMax).success).toBe(true);

    const overMax = atMax + "x";
    expect(overMax.length).toBe(LINK_URL_MAX + 1);
    const over = brandWebsiteSchema.safeParse(overMax);
    expect(over.success).toBe(false);
    expect(over.error?.issues[0]?.message).toBe(LINK_URL_LENGTH_MESSAGE);
  });

  it("stores a non-canonical but valid website verbatim apart from the trim (FR-011)", () => {
    const input = "  HTTPS://Example.TEST/Some/Path  ";
    expect(brandWebsiteSchema.parse(input)).toBe("HTTPS://Example.TEST/Some/Path");
  });
});
