import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

let pathname = "/p/acme";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => createElement("a", { href, ...rest }, children),
}));

import { isNavItemActive, LeftNav } from "../../../src/components/shell/LeftNav";

function render(path: string): string {
  pathname = path;
  return renderToStaticMarkup(createElement(LeftNav, { projectSlug: "acme" }));
}

describe("Overview nav entry", () => {
  it("is the first link", () => {
    expect(/<a [^>]*href="([^"]*)"/.exec(render("/p/acme"))?.[1]).toBe("/p/acme");
  });

  it.each([
    ["/p/acme", "/p/acme"],
    ["/p/acme/", "/p/acme"],
    ["/p/acme/calendar", "/p/acme/calendar"],
    ["/p/acme/settings/members", "/p/acme/settings"],
  ])("marks exactly one item current at %s", (path, expected) => {
    const html = render(path);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(new RegExp(`href="${expected}"[^>]*aria-current="page"|aria-current="page"[^>]*href="${expected}"`).test(html)).toBe(true);
  });

  it("matches exactly only when asked", () => {
    expect(isNavItemActive("/p/acme/calendar", "/p/acme", true)).toBe(false);
    expect(isNavItemActive("/p/acme/calendar", "/p/acme")).toBe(true);
  });
});
