import { describe, expect, it } from "vitest";
import {
  renderInvitationEmail,
  renderPasswordResetEmail,
  renderProblemEmail,
  type EmailProblem,
  type ProblemEmailModel,
} from "./render";

function problem(overrides: Partial<EmailProblem> = {}): EmailProblem {
  return {
    outcomeLabel: "Failed to post",
    occurredAt: new Date("2026-06-01T15:00:00Z"),
    platforms: [{ key: "bluesky", name: "Bluesky" }],
    accountName: "Main account",
    message: "The server refused the post.",
    href: "https://docket.example.test/p/proj/activity/123",
    ...overrides,
  };
}

const model = (overrides: Partial<ProblemEmailModel> = {}): ProblemEmailModel => ({
  cadence: "immediate",
  timeZone: "America/New_York",
  groups: [{ name: "Project One", problems: [problem()], overflow: 0, overflowHref: "https://docket.example.test/p/one/activity" }],
  unsubscribeUrl: "https://docket.example.test/email/unsubscribe?t=abc",
  ...overrides,
});

describe("renderProblemEmail", () => {
  it("groups problems by project", () => {
    const m = model({
      groups: [
        { name: "Project One", problems: [problem()], overflow: 0, overflowHref: "https://x/one" },
        { name: "Project Two", problems: [problem({ message: "Second problem." })], overflow: 0, overflowHref: "https://x/two" },
      ],
    });
    const { text, html } = renderProblemEmail(m);
    expect(text).toContain("Project One");
    expect(text).toContain("Project Two");
    expect(html).toContain("Project One");
    expect(html).toContain("Project Two");
  });

  it("states the overflow sentence with the exact count and a link", () => {
    const m = model({ groups: [{ name: "Project One", problems: [problem()], overflow: 7, overflowHref: "https://x/overflow" }] });
    const { text, html } = renderProblemEmail(m);
    expect(text).toContain("...and 7 more. See: https://x/overflow");
    expect(html).toContain("...and 7 more");
    expect(html).toContain("https://x/overflow");
  });

  it("contains no remote content", () => {
    const { html } = renderProblemEmail(model());
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/url\(/i);
    expect(html).not.toMatch(/<link/i);
    expect(html).not.toMatch(/<script/i);
  });

  it("renders every instant through the one date format", () => {
    const { text } = renderProblemEmail(model());
    // formatLocal produces e.g. "Mon, Jun 1, 11:00 AM EDT"
    expect(text).toMatch(/\b\w{3}, \w{3} \d{1,2}, \d{1,2}:\d{2} [AP]M [A-Z]{2,5}\b/);
  });

  it("throws rather than mailing an empty page", () => {
    expect(() => renderProblemEmail(model({ groups: [] }))).toThrow();
    expect(() => renderProblemEmail(model({ groups: [{ name: "P", problems: [], overflow: 0, overflowHref: "https://x" }] }))).toThrow();
  });

  it("includes the unsubscribe link", () => {
    const { text, html } = renderProblemEmail(model());
    expect(text).toContain(model().unsubscribeUrl);
    expect(html).toContain(model().unsubscribeUrl);
  });
});

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
