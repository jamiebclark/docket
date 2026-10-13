import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelPanel } from "../../../src/app/p/[projectSlug]/settings/model/ModelPanel";
import type { ProjectLlmDto } from "../../../src/app/p/[projectSlug]/settings/model/dto";

const withKey: ProjectLlmDto = {
  inUse: { source: "project", provider: "openai", model: "gpt-5.4-mini" },
  hasKey: true,
  lastChange: { by: { id: "u1", name: "Ada" }, at: "2026-10-13T00:00:00.000Z" },
  keyMaxLength: 400,
};

const markup = () => renderToStaticMarkup(<ModelPanel slug="demo" timeZone="UTC" view={withKey} />);

/**
 * The server-rendered markup is exactly what a visitor with client JavaScript disabled gets, so these
 * assertions are the no-JavaScript contract from quickstart.md §4 part 4. They are deliberately about
 * *reachability*, not about rendering: the earlier three-role test rendered the panel and passed while
 * remove sat inside a `<dialog>`, which is `display: none` until `showModal()` runs — present in the
 * markup, impossible to reach without JavaScript.
 */
describe("the model settings panel without client JavaScript", () => {
  it("offers save, check and remove, all as real forms", () => {
    const html = markup();
    expect(html).toContain('name="apiKey"');
    expect(html).toMatch(/Check this credential/i);
    expect(html).toMatch(/Remove credential/i);
    // Three server-action forms, not buttons wired up in the browser.
    expect([...html.matchAll(/<form/g)].length).toBeGreaterThanOrEqual(3);
  });

  it("puts the remove confirmation in a disclosure, not a dialog that only JavaScript can open", () => {
    const html = markup();
    const removeAt = html.search(/Remove credential/i);
    expect(removeAt).toBeGreaterThan(-1);

    const inDetails = html.lastIndexOf("<details", removeAt);
    const inDialog = html.lastIndexOf("<dialog", removeAt);
    expect(inDetails).toBeGreaterThan(inDialog);

    // And nothing in this panel hides behind a dialog that starts closed.
    expect([...html.matchAll(/<dialog(?![^>]*\bopen\b)/g)].length).toBe(0);
  });

  it("renders no part of a stored key, only that one exists", () => {
    const html = markup();
    expect(html).not.toMatch(/sk-/);
    expect(html).toMatch(/gpt-5\.4-mini/);
  });
});
