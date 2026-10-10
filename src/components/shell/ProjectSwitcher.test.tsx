import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { ProjectSwitcher } from "./ProjectSwitcher";

describe("ProjectSwitcher", () => {
  const html = renderToStaticMarkup(
    <ProjectSwitcher projects={[{ slug: "a", name: "Alpha" } as never]} currentName="Alpha" />,
  );

  it("advertises the shortcut and hides the kbd hint from the name", () => {
    expect(html).toContain('aria-keyshortcuts="Control+K Meta+K"');
    expect(html).toMatch(/<kbd[^>]*aria-hidden="true"/);
    expect(html).toContain("Alpha");
  });
});
