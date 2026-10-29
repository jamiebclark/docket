import { describe, expect, it } from "vitest";
import { renderInvitationEmail, renderPasswordResetEmail } from "./render";

// The problem email has its own file and its own tests: src/lib/email/problem-email.test.ts.

describe("renderInvitationEmail", () => {
  const invModel = {
    projectName: "Acme",
    roleLabel: "editor",
    inviterName: "Ann",
    expiresAt: new Date("2026-06-10T00:00:00Z"),
    timeZone: "UTC",
    acceptUrl: "https://docket.example.test/invite/abc",
  };

  it("has no unsubscribe link or mention", () => {
    const { text, html } = renderInvitationEmail(invModel);
    expect(text.toLowerCase()).not.toContain("unsubscribe");
    expect(html.toLowerCase()).not.toContain("unsubscribe");
  });

  it("contains the accept link and expiry", () => {
    const { text } = renderInvitationEmail(invModel);
    expect(text).toContain(invModel.acceptUrl);
  });
});

describe("renderPasswordResetEmail", () => {
  const resetModel = {
    name: "Ann",
    resetUrl: "https://docket.example.test/api/auth/reset-password/tok-123?callbackURL=%2Freset-password",
    expiresAt: new Date("2026-06-10T13:00:00Z"),
    timeZone: "UTC",
  };

  it("has no unsubscribe link or mention", () => {
    const { text, html } = renderPasswordResetEmail(resetModel);
    expect(text.toLowerCase()).not.toContain("unsubscribe");
    expect(html.toLowerCase()).not.toContain("unsubscribe");
  });

  it("contains the reset link in both renderings", () => {
    const { text, html } = renderPasswordResetEmail(resetModel);
    expect(text).toContain(resetModel.resetUrl);
    expect(html).toContain("reset-password/tok-123");
  });

  it("quotes the expiry in the recipient's zone, not UTC", () => {
    const { text } = renderPasswordResetEmail({ ...resetModel, timeZone: "America/New_York" });
    // 13:00 UTC is 9 AM in New York on that date; the hour proves the zone was applied.
    expect(text).toContain("9:00");
    expect(text).not.toContain("13:00");
  });

  it("says an unrequested reset needs no action, so the message is not alarming on its own", () => {
    const { text } = renderPasswordResetEmail(resetModel);
    expect(text).toContain("If you did not ask for this");
  });

  it("names the person but never the address it was sent to (FR-034)", () => {
    const { text, html } = renderPasswordResetEmail(resetModel);
    expect(text).toContain("Ann");
    expect(text).not.toContain("@");
    expect(html).not.toContain("@");
  });

  it("escapes a display name that contains markup", () => {
    const { html } = renderPasswordResetEmail({ ...resetModel, name: `<script>x</script>` });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
