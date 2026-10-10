import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChecklistItem } from "./Checklist";
import { SetupNotice } from "./SetupNotice";

const items: ChecklistItem[] = [
  { key: "a", title: "Set up AI generation", description: "Needs a provider.", status: { kind: "todo" }, action: { label: "Open the guide", href: "/g" } },
  { key: "b", title: "Connect an account", description: "One account.", status: { kind: "done" } },
  { key: "c", title: "Create a voice profile", description: "Tone.", status: { kind: "waiting", on: "Ana" }, blocked: "Ask an admin." },
];

describe("SetupNotice", () => {
  const html = renderToStaticMarkup(<SetupNotice title="Before you can generate" items={items} icon="generate" />);

  it("is a labelled section with the dashed frame and a titled heading", () => {
    expect(html).toContain('aria-labelledby="setup-notice-title"');
    expect(html).toContain("border-dashed");
    expect(html).toContain('<h2 id="setup-notice-title"');
    expect(html).toContain("Before you can generate");
  });

  it("states status in words, one action or blocked line per row", () => {
    expect(html).toContain("To do");
    expect(html).toContain("Done");
    expect(html).toContain("Waiting on Ana");
    expect(html.match(/Open the guide/g)).toHaveLength(1);
    expect(html).toContain("Ask an admin.");
  });

  it("keeps the icon decorative and honours id, level and lead", () => {
    expect(html).toContain('aria-hidden="true"');
    const alt = renderToStaticMarkup(<SetupNotice title="T" items={items} id="x" headingLevel={3} lead="Lead sentence" />);
    expect(alt).toContain('aria-labelledby="x-title"');
    expect(alt).toContain('<h3 id="x-title"');
    expect(alt).toContain("Lead sentence");
  });
});
