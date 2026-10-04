import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));
vi.mock("./actions", () => ({ generateSingleAction: async () => ({ ok: true }) }));
vi.mock("@/components/media/MediaPicker", () => ({ MediaPicker: () => null }));

import { GenerateForm } from "./GenerateForm";
import { PolicyPicker, type PolicyChoice } from "./PolicyPicker";

const none: PolicyChoice = { approval: null, scheduling: null, confirmUnreviewedQueue: false };
const review = { approval: "review_required", scheduling: "leave_as_draft" } as const;
const autoQueue = { approval: "auto_approve", scheduling: "add_to_queue" } as const;

const picker = (over: Partial<Parameters<typeof PolicyPicker>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(PolicyPicker, {
      idPrefix: "p",
      defaults: review,
      canAutoApprove: true,
      value: none,
      onChange: () => {},
      ...over,
    }),
  );

describe("PolicyPicker", () => {
  it("offers the project default and both explicit choices", () => {
    const html = picker();
    expect(html).toContain("Use project default (Review required)");
    expect(html).toContain("Use project default (Leave as draft)");
    expect(html).toContain("Review required");
    expect(html).toContain("Approve automatically");
    expect(html).toContain("Add to queue");
    expect(html).toContain("<fieldset");
    expect(html).not.toContain("I understand");
  });

  it("disables auto-approve for an editor and says why", () => {
    const html = picker({ canAutoApprove: false });
    expect(html).toMatch(/<input[^>]*disabled[^>]*aria-describedby="p-auto-help"|<input[^>]*aria-describedby="p-auto-help"[^>]*disabled/);
    expect(html).toContain("Only owners and admins can auto-approve");
  });

  it("collapses to one highlighted option with a required checkbox for auto + queue", () => {
    const html = picker({ value: { ...none, approval: "auto_approve", scheduling: "add_to_queue" } });
    expect(html).toContain("Approve and queue automatically — no review");
    expect(html).toContain("without anyone reviewing them");
    expect(html).toContain("I understand these posts will be queued without review");
    expect(html).toMatch(/type="checkbox"[^>]*required|required=""[^>]*type="checkbox"/);
    expect(html).not.toContain('type="radio"');
  });

  it("collapses when the project default is the unreviewed pair", () => {
    const html = picker({ defaults: autoQueue });
    expect(html).toContain("Approve and queue automatically — no review");
  });
});

describe("GenerateForm default banner", () => {
  const form = (defaults: typeof review | typeof autoQueue) =>
    renderToStaticMarkup(
      createElement(GenerateForm, { slug: "s", profiles: [], accounts: [], defaults, mediaEnabled: false }),
    );

  it("shows the unreviewed label at the top when it is the project default", () => {
    const html = form(autoQueue);
    expect(html).toContain("This project is set to: Approve and queue automatically — no review");
    expect(html.indexOf("This project is set to")).toBeLessThan(html.indexOf("Brief"));
  });

  it("does not show it for other defaults", () => {
    expect(form(review)).not.toContain("This project is set to");
  });
});
