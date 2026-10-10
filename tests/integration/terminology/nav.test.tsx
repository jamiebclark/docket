import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { vi } from "vitest";

const nav = vi.hoisted(() => ({ pathname: "/p/x/calendar" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => createElement("a", { href, ...rest }, children),
}));

import { LeftNav } from "../../../src/components/shell/LeftNav";

function render(pathname: string, props: { reviewCount?: number; failuresCount?: number } = {}): string {
  nav.pathname = pathname;
  return renderToStaticMarkup(createElement(LeftNav, { projectSlug: "x", ...props }));
}

/** Link texts (tags stripped) in document order. */
function labels(html: string): string[] {
  return [...html.matchAll(/<a [^>]*>(.*?)<\/a>/g)].map((m) => (m[1] ?? "").replace(/<[^>]*>/g, ""));
}

describe("project nav order and wording", () => {
  it("lists the 13 entries in newcomer order", () => {
    expect(labels(render("/p/x/calendar"))).toEqual([
      "Overview", "Compose", "Calendar", "Posts", "Review", "Failures",
      "Generate", "Brand voice", "Media", "Batch jobs", "Accounts", "Settings", "Activity",
    ]);
  });

  it("shows group headings in order with their items", () => {
    const html = render("/p/x/calendar");
    const groups = [...html.matchAll(/<p [^>]*>(Publish|Create|Project)<\/p>/g)].map((m) => m[1] ?? "");
    expect(groups).toEqual(["Publish", "Create", "Project"]);
    const [, publish, create, project] = html.split(/<p [^>]*>(?:Publish|Create|Project)<\/p>/);
    expect(labels(publish ?? "")).toEqual(["Compose", "Calendar", "Posts", "Review", "Failures"]);
    expect(labels(create ?? "")).toEqual(["Generate", "Brand voice", "Media", "Batch jobs"]);
    expect(labels(project ?? "")).toEqual(["Accounts", "Settings", "Activity"]);
  });

  it("keeps Review directly above Failures", () => {
    const l = labels(render("/p/x/calendar"));
    expect(l.indexOf("Failures")).toBe(l.indexOf("Review") + 1);
  });

  it("marks Brand voice and Batch jobs current at their unchanged URLs", () => {
    expect(render("/p/x/voice")).toMatch(/<a [^>]*aria-current="page"[^>]*>.*?Brand voice/);
    expect(render("/p/x/voice")).toContain('href="/p/x/voice"');
    expect(render("/p/x/jobs")).toMatch(/<a [^>]*aria-current="page"[^>]*>.*?Batch jobs/);
    expect(render("/p/x/jobs")).toContain('href="/p/x/jobs"');
  });

  it("no longer uses the bare Voice or Jobs labels", () => {
    const l = labels(render("/p/x/calendar"));
    expect(l).not.toContain("Voice");
    expect(l).not.toContain("Jobs");
  });

  it("does not mark Overview current on a sub-page", () => {
    expect(render("/p/x/compose")).not.toMatch(/<a [^>]*href="\/p\/x"[^>]*aria-current/);
    expect(render("/p/x/compose")).not.toMatch(/aria-current="page"[^>]*href="\/p\/x"/);
  });
});
