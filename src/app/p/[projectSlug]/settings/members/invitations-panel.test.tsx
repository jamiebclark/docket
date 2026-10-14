import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./actions", () => ({
  inviteMember: async () => null,
  regenerateInvitation: async () => null,
  revokeInvitation: async () => null,
}));

import { InvitationsPanel, linkMessage, type InvitationView } from "./invitations-panel";

const TZ = "America/New_York";

const inv = (over: Partial<InvitationView> = {}): InvitationView => ({
  id: "11111111-1111-4111-8111-111111111111",
  email: "robin@example.test",
  role: "editor",
  status: "pending",
  inviterName: "Sam",
  expiresAt: "2026-10-20T13:00:00.000Z",
  canManage: true,
  ...over,
});

const render = (invitations: InvitationView[]) =>
  renderToStaticMarkup(
    createElement(InvitationsPanel, { slug: "studio", timeZone: TZ, invitations, canInvite: true, canInviteOwner: false }),
  );

const link = (over: Partial<Parameters<typeof linkMessage>[0]> = {}) => ({
  url: "https://docket.test/signup?token=abc",
  expiresAt: "2026-10-20T13:00:00.000Z",
  email: "robin@example.test",
  kind: "manual_link" as const,
  deliveryEmail: "unavailable" as const,
  ...over,
});

describe("invitation link wording", () => {
  it("tells an inviter to send the link when the invitee has no account", () => {
    const text = linkMessage(link(), TZ);
    expect(text).toContain("Send this link to robin@example.test.");
    expect(text).toContain("shown only once");
  });

  it("still offers the link when the invitee already has an account, with in-app wording", () => {
    const text = linkMessage(link({ kind: "in_app" }), TZ);
    expect(text).toContain("already has a Docket account");
    expect(text).toContain("under Invitations");
    // The point of the fix: the in-app case is a wording difference, not a missing link.
    expect(text).toContain("shown only once");
  });

  it("leads with the email outcome when there was one, for either kind", () => {
    expect(linkMessage(link({ deliveryEmail: "sent" }), TZ)).toMatch(/^Invitation emailed\./);
    expect(linkMessage(link({ kind: "in_app", deliveryEmail: "sent" }), TZ)).toMatch(/^Invitation emailed\./);
    expect(linkMessage(link({ kind: "in_app", deliveryEmail: "failed" }), TZ)).toMatch(/^The invitation was created, but the email did not go out\./);
  });

  it("formats the expiry through formatLocal in the project time zone", () => {
    // Not an ISO slice and not UTC: 13:00Z is 9:00 AM in New York.
    expect(linkMessage(link(), TZ)).toContain("Tue, Oct 20, 9:00 AM EDT");
  });
});

describe("InvitationsPanel rows", () => {
  it("offers Copy new link beside Regenerate on a pending row", () => {
    const html = render([inv()]);
    expect(html).toContain('aria-label="Copy a new invitation link for robin@example.test"');
    expect(html).toContain('aria-label="Regenerate invitation for robin@example.test"');
    expect(html).toContain("Copy new link");
  });

  it("offers Copy new link on an expired row too", () => {
    expect(render([inv({ status: "expired" })])).toContain('aria-label="Copy a new invitation link for robin@example.test"');
  });

  it("offers neither on a row that is closed or not manageable", () => {
    for (const status of ["accepted", "declined", "revoked"] as const) {
      expect(render([inv({ status })])).not.toContain("Copy new link");
    }
    expect(render([inv({ canManage: false })])).not.toContain("Copy new link");
  });

  it("names the invitee in each row's copy button, so two rows are distinguishable", () => {
    const html = render([inv(), inv({ id: "22222222-2222-4222-8222-222222222222", email: "ash@example.test" })]);
    expect(html).toContain('aria-label="Copy a new invitation link for robin@example.test"');
    expect(html).toContain('aria-label="Copy a new invitation link for ash@example.test"');
  });

  it("renders no link panel until a link arrives, and keeps one live region for announcements", () => {
    const html = render([inv()]);
    expect(html).not.toContain('aria-label="Invitation link"');
    expect(html).toContain('aria-live="polite"');
  });
});
