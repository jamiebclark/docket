import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./actions", () => ({ updateProjectSettings: async () => null }));

import { SettingsForm, type SettingsValues } from "./settings-form";

const values = (over: Partial<SettingsValues> = {}): SettingsValues => ({
  name: "P",
  slug: "p",
  tagline: null,
  description: null,
  websiteUrl: null,
  timezone: "UTC",
  defaultApprovalPolicy: "review_required",
  defaultSchedulingPolicy: "leave_as_draft",
  ...over,
});
const render = (v: SettingsValues, canEdit = true) => renderToStaticMarkup(createElement(SettingsForm, { values: v, canEdit }));

describe("SettingsForm unreviewed-queue confirmation", () => {
  it("shows the explanation and required checkbox for auto + queue", () => {
    const html = render(values({ defaultApprovalPolicy: "auto_approve", defaultSchedulingPolicy: "add_to_queue" }));
    expect(html).toContain("Approve and queue automatically — no review");
    expect(html).toContain("without anyone reviewing them");
    expect(html).toContain("I understand these posts will be queued without review");
    expect(html).toMatch(/name="confirmUnreviewedQueue"/);
  });

  it("shows nothing extra for other combinations", () => {
    expect(render(values())).not.toContain("I understand");
    expect(render(values({ defaultApprovalPolicy: "auto_approve" }))).not.toContain("I understand");
  });
});

describe("SettingsForm brand fields", () => {
  it("renders the tagline, description and website with their current values, editable", () => {
    const html = render(
      values({ tagline: "Make it snappy", description: "A longer explanation of the brand.", websiteUrl: "https://example.com" }),
    );
    expect(html).toContain('name="tagline"');
    expect(html).toMatch(/name="tagline"[^>]*value="Make it snappy"/);
    expect(html).not.toMatch(/name="tagline"[^>]*disabled/);
    expect(html).toContain('name="description"');
    expect(html).toContain("A longer explanation of the brand.");
    expect(html).not.toMatch(/name="description"[^>]*disabled/);
    expect(html).toContain('name="websiteUrl"');
    expect(html).toMatch(/name="websiteUrl"[^>]*value="https:\/\/example\.com"/);
    expect(html).not.toMatch(/name="websiteUrl"[^>]*disabled/);
  });

  it("has an error region for each brand field for surfacing field errors", () => {
    const html = render(values());
    expect(html).toContain('id="tagline-error"');
    expect(html).toContain('id="description-error"');
    expect(html).toContain('id="websiteUrl-error"');
  });

  it("for an editor, renders the brand fields' current values, disabled, under the owner/admin note, with no save button", () => {
    const html = render(
      values({ tagline: "Make it snappy", description: "A longer explanation of the brand.", websiteUrl: "https://example.com" }),
      false,
    );
    const noteIndex = html.indexOf("Only owners and admins can change project settings.");
    const taglineIndex = html.indexOf('name="tagline"');
    expect(noteIndex).toBeGreaterThan(-1);
    expect(taglineIndex).toBeGreaterThan(noteIndex);
    expect(html).toMatch(/name="tagline"[^>]*value="Make it snappy"/);
    expect(html).toMatch(/<input id="tagline"[^>]*disabled="" name="tagline"/);
    expect(html).toContain("A longer explanation of the brand.");
    expect(html).toMatch(/<textarea id="description"[^>]*name="description" disabled=""/);
    expect(html).toMatch(/name="websiteUrl"[^>]*value="https:\/\/example\.com"/);
    expect(html).toMatch(/<input id="websiteUrl"[^>]*disabled="" name="websiteUrl"/);
    expect(html).not.toContain("Save settings");
  });
});
