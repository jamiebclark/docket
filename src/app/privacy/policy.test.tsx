import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { POLICY_LAST_UPDATED, POLICY_SECTIONS, PrivacyPolicy } from "./policy";

const DOC = readFileSync(join(process.cwd(), "docs/privacy.md"), "utf8");
const docHeadings = [...DOC.matchAll(/^## (.+)$/gm)].map((m) => m[1]!.trim());

const unset = { host: "docket.example.com", operatorName: null, operatorContact: null };
const configured = {
  host: "docket.example.com",
  operatorName: "Acme Studio",
  operatorContact: { kind: "email" as const, label: "privacy@example.com", href: "mailto:privacy@example.com" },
};

describe("privacy policy page content", () => {
  it("has every section docs/privacy.md has, in the same order, so the two cannot drift", () => {
    expect(docHeadings.length).toBeGreaterThan(3);
    expect(POLICY_SECTIONS.map((s) => s.title)).toEqual(docHeadings);
    const html = renderToStaticMarkup(<PrivacyPolicy site={unset} />);
    for (const heading of docHeadings) expect(html, heading).toContain(`>${heading.replace(/&/g, "&amp;")}</h2>`);
  });

  it("states the same last-updated date as the document", () => {
    expect(DOC).toContain(`Last updated ${POLICY_LAST_UPDATED}`);
  });

  it("names Pinterest's data and scopes exactly", () => {
    const html = renderToStaticMarkup(<PrivacyPolicy site={unset} />);
    for (const scope of ["user_accounts:read", "boards:read", "pins:write"]) expect(html).toContain(scope);
    expect(html).toContain("list of boards that account owns");
  });

  it("never invents an operator when none is configured", () => {
    const html = renderToStaticMarkup(<PrivacyPolicy site={unset} />);
    expect(html).toContain("operated by whoever deployed it");
    expect(html).not.toContain("mailto:");
  });

  it("names the configured operator and links their contact", () => {
    const html = renderToStaticMarkup(<PrivacyPolicy site={configured} />);
    expect(html).toContain("<strong>docket.example.com</strong>");
    expect(html).toContain("Acme Studio");
    expect(html).toContain('href="mailto:privacy@example.com"');
  });

  it("renders a URL contact as a link to that page", () => {
    const html = renderToStaticMarkup(
      <PrivacyPolicy
        site={{ ...configured, operatorContact: { kind: "url", label: "https://example.com/contact", href: "https://example.com/contact" } }}
      />,
    );
    expect(html).toContain('href="https://example.com/contact"');
  });
});
