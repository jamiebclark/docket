import { describe, expect, it } from "vitest";
import { problemEmailSubject, renderProblemEmail, type EmailProblem, type ProblemEmailModel } from "./problem-email";

function problem(overrides: Partial<EmailProblem> = {}): EmailProblem {
  return {
    outcome: "failed",
    outcomeLabel: "Failed",
    occurredAt: new Date("2026-06-01T15:00:00Z"),
    platforms: [{ key: "bluesky", name: "Bluesky" }],
    accountName: "Main account",
    message: "The server refused the post.",
    href: "https://docket.example.test/p/proj/failures?target=t1",
    actionLabel: "Open in Failures",
    ...overrides,
  };
}

const comment = (overrides: Partial<EmailProblem> = {}): EmailProblem =>
  problem({
    outcome: "engagement",
    outcomeLabel: "New in your Inbox",
    platforms: [{ key: "instagram", name: "Instagram" }],
    accountName: "stencilvania",
    message: "1 new comment",
    href: "https://docket.example.test/p/stencilvania/inbox?state=waiting&account=a1",
    actionLabel: "Open the Inbox",
    ...overrides,
  });

const model = (overrides: Partial<ProblemEmailModel> = {}): ProblemEmailModel => ({
  cadence: "immediate",
  timeZone: "America/New_York",
  groups: [{ name: "Project One", problems: [problem()], overflow: 0, overflowHref: "https://docket.example.test/p/one/activity" }],
  unsubscribeUrl: "https://docket.example.test/email/unsubscribe?t=abc",
  ...overrides,
});

const stencilvania = (problems: EmailProblem[], overrides: Partial<ProblemEmailModel> = {}): ProblemEmailModel =>
  model({ groups: [{ name: "Stencilvania", problems, overflow: 0, overflowHref: "https://x/sv" }], ...overrides });

describe("problemEmailSubject", () => {
  it("names the project and what happened, not a bare count (020 feedback)", () => {
    expect(problemEmailSubject(stencilvania([comment()]))).toBe("Stencilvania: 1 new inbox message");
  });

  it("never calls an inbox message a problem: engagement is an attention outcome, not a PROBLEM_OUTCOMES member", () => {
    const subject = problemEmailSubject(stencilvania([comment()]));
    expect(subject.toLowerCase()).not.toContain("problem");
  });

  it("pluralises and joins the outcomes it found", () => {
    const subject = problemEmailSubject(stencilvania([problem(), problem(), comment()]));
    expect(subject).toBe("Stencilvania: 2 failed posts and 1 new inbox message");
  });

  it("names the reconnect case in its own words", () => {
    const subject = problemEmailSubject(stencilvania([problem({ outcome: "needs_reauth", outcomeLabel: "Needs reconnecting" })]));
    expect(subject).toBe("Stencilvania: 1 account to reconnect");
  });

  it("counts projects instead of listing them once there is more than one", () => {
    const m = model({
      groups: [
        { name: "Stencilvania", problems: [problem()], overflow: 0, overflowHref: "https://x/sv" },
        { name: "Moodoodle", problems: [comment()], overflow: 0, overflowHref: "https://x/md" },
      ],
    });
    expect(problemEmailSubject(m)).toBe("Docket: 1 failed post and 1 new inbox message across 2 projects");
  });

  it("collapses a third outcome and any overflow into one 'more' phrase", () => {
    const m = stencilvania([problem(), comment(), problem({ outcome: "ambiguous", outcomeLabel: "Needs your decision" })]);
    m.groups[0]!.overflow = 4;
    expect(problemEmailSubject(m)).toBe("Stencilvania: 1 failed post, 1 new inbox message and 5 more");
  });

  it("marks a digest as covering the day", () => {
    expect(problemEmailSubject(stencilvania([comment()], { cadence: "digest" }))).toBe("Stencilvania: 1 new inbox message today");
  });

  it("stays short enough for a mail client to show, keeping the counts and trimming the name", () => {
    const m = stencilvania([problem(), comment()], {});
    m.groups[0]!.name = "A project with a really very considerably long name".repeat(3);
    const subject = problemEmailSubject(m);
    expect(subject.length).toBeLessThanOrEqual(110);
    expect(subject).toContain("…: 1 failed post and 1 new inbox message");
  });
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

  it("gives every row a link and calls the link what the row leads to (FR-011, 020 feedback)", () => {
    const { text, html } = renderProblemEmail(stencilvania([comment()]));
    expect(text).toContain("Open the Inbox: https://docket.example.test/p/stencilvania/inbox?state=waiting&account=a1");
    expect(html).toContain(`href="https://docket.example.test/p/stencilvania/inbox?state=waiting&amp;account=a1"`);
    expect(html).toContain(">Open the Inbox</a>");
  });

  it("says which engagement kind arrived, so a comment does not read as a reply", () => {
    const { text, html } = renderProblemEmail(stencilvania([comment()]));
    expect(text).toContain("1 new comment");
    expect(html).toContain("1 new comment");
  });

  it("carries the account, the platform and the instant on every row", () => {
    const { text, html } = renderProblemEmail(stencilvania([comment()]));
    expect(text).toContain("stencilvania");
    expect(text).toContain("Instagram");
    expect(html).toContain("stencilvania");
    expect(html).toContain("Instagram");
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

  it("lays the message out with inline styles a mail client keeps, not a stylesheet it strips", () => {
    const { html } = renderProblemEmail(model());
    expect(html).not.toMatch(/<style/i);
    expect(html).toMatch(/<table role="presentation"/);
    expect(html).toMatch(/style="[^"]*padding/);
  });

  it("never leaves the outcome to colour alone: the tone colour always sits beside its words (FR-014)", () => {
    const { html } = renderProblemEmail(stencilvania([problem({ outcome: "failed", outcomeLabel: "Failed" })]));
    // The danger token colours the rule and the heading, and the heading spells the outcome out.
    expect(html).toContain("#B3261E");
    expect(html).toContain(">Failed</div>");
  });

  it("states the zone the times are in", () => {
    const { text, html } = renderProblemEmail(model());
    expect(text).toContain("All times America/New_York.");
    expect(html).toContain("All times America/New_York.");
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

  it("escapes a project name and a message that contain markup", () => {
    const { html } = renderProblemEmail(stencilvania([problem({ message: `<script>x</script>` })], {}));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
