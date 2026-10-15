import { describe, expect, it } from "vitest";
import { parsePublicSite } from "./public-site";

describe("parsePublicSite", () => {
  it("is all unset with an empty environment", () => {
    expect(parsePublicSite({})).toEqual({
      host: null,
      operatorName: null,
      operatorContact: null,
      pinterestDomainVerify: null,
      problems: [],
    });
  });

  it("reads the host from BETTER_AUTH_URL", () => {
    expect(parsePublicSite({ BETTER_AUTH_URL: "https://docket.example.com" }).host).toBe("docket.example.com");
    expect(parsePublicSite({ BETTER_AUTH_URL: " http://localhost:3000/ " }).host).toBe("localhost:3000");
    expect(parsePublicSite({ BETTER_AUTH_URL: "not a url" }).host).toBeNull();
  });

  it("trims the operator name and treats blank as unset", () => {
    expect(parsePublicSite({ DOCKET_OPERATOR_NAME: "  Acme Studio  " }).operatorName).toBe("Acme Studio");
    const blank = parsePublicSite({ DOCKET_OPERATOR_NAME: "   " });
    expect(blank.operatorName).toBeNull();
    expect(blank.problems).toEqual([]);
  });

  it("ignores an over-long or multi-line operator name and says so without the value", () => {
    for (const bad of ["x".repeat(101), "Acme\nStudio"]) {
      const r = parsePublicSite({ DOCKET_OPERATOR_NAME: bad });
      expect(r.operatorName).toBeNull();
      expect(r.problems.map((p) => p.name)).toEqual(["DOCKET_OPERATOR_NAME"]);
      expect(JSON.stringify(r.problems)).not.toContain("Acme");
    }
  });

  it("renders an email contact as mailto:", () => {
    expect(parsePublicSite({ DOCKET_OPERATOR_CONTACT: " Privacy@Example.com " }).operatorContact).toEqual({
      kind: "email",
      label: "privacy@example.com",
      href: "mailto:privacy@example.com",
    });
  });

  it("accepts an https URL contact", () => {
    expect(parsePublicSite({ DOCKET_OPERATOR_CONTACT: "https://example.com/contact" }).operatorContact).toEqual({
      kind: "url",
      label: "https://example.com/contact",
      href: "https://example.com/contact",
    });
  });

  it("ignores any other contact shape", () => {
    for (const bad of [
      "http://example.com/contact",
      "javascript:alert(1)",
      "ftp://example.com",
      "https://user:pw@example.com",
      "not an email",
      "mailto:someone@example.com",
      "@example.com",
    ]) {
      const r = parsePublicSite({ DOCKET_OPERATOR_CONTACT: bad });
      expect(r.operatorContact, bad).toBeNull();
      expect(r.problems.map((p) => p.name), bad).toEqual(["DOCKET_OPERATOR_CONTACT"]);
    }
    expect(parsePublicSite({ DOCKET_OPERATOR_CONTACT: "" }).problems).toEqual([]);
  });

  it("accepts a letters-and-digits Pinterest verification code only", () => {
    expect(parsePublicSite({ PINTEREST_DOMAIN_VERIFY: " a1B2c3d4e5f6 " }).pinterestDomainVerify).toBe("a1B2c3d4e5f6");
    for (const bad of ['abc" /><script>', "abc-def", "abc def", "ab_c"]) {
      const r = parsePublicSite({ PINTEREST_DOMAIN_VERIFY: bad });
      expect(r.pinterestDomainVerify, bad).toBeNull();
      expect(r.problems.map((p) => p.name), bad).toEqual(["PINTEREST_DOMAIN_VERIFY"]);
    }
    expect(parsePublicSite({ PINTEREST_DOMAIN_VERIFY: "  " }).pinterestDomainVerify).toBeNull();
  });
});
