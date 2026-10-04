import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./actions", () => ({ updateProjectSettings: async () => null }));

import { SettingsForm, type SettingsValues } from "./settings-form";

const values = (over: Partial<SettingsValues> = {}): SettingsValues => ({
  name: "P",
  slug: "p",
  timezone: "UTC",
  defaultApprovalPolicy: "review_required",
  defaultSchedulingPolicy: "leave_as_draft",
  ...over,
});
const render = (v: SettingsValues) => renderToStaticMarkup(createElement(SettingsForm, { values: v, canEdit: true }));

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
