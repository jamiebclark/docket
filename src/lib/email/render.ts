// Pure, the message. No images, no remote content, no colour-only meaning (FR-014).

import { formatLocal } from "../time/format";

export interface EmailProblem {
  outcomeLabel: string;
  occurredAt: Date;
  platforms: { key: string; name: string }[];
  accountName: string | null;
  message: string;
  href: string | null;
}

export interface EmailProjectGroup {
  name: string;
  problems: EmailProblem[];
  /** How many more than `problems` there are, exactly, within EMAIL_SCAN_LIMIT (FR-011, E16). */
  overflow: number;
  overflowHref: string;
}

export interface ProblemEmailModel {
  cadence: "immediate" | "digest";
  timeZone: string;
  groups: EmailProjectGroup[];
  unsubscribeUrl: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function problemText(p: EmailProblem, zone: string): string {
  const platforms = p.platforms.map((x) => x.name).join(", ");
  const who = p.accountName ? ` (${p.accountName})` : "";
  const when = formatLocal(p.occurredAt, zone);
  const lines = [`${p.outcomeLabel}${who} — ${platforms} — ${when}`, p.message];
  if (p.href) lines.push(p.href);
  return lines.join("\n");
}

function problemHtml(p: EmailProblem, zone: string): string {
  const platforms = escapeHtml(p.platforms.map((x) => x.name).join(", "));
  const who = p.accountName ? ` (${escapeHtml(p.accountName)})` : "";
  const when = escapeHtml(formatLocal(p.occurredAt, zone));
  const link = p.href ? `<p><a href="${escapeHtml(p.href)}">View in Activity</a></p>` : "";
  return [
    `<li>`,
    `<p><strong>${escapeHtml(p.outcomeLabel)}</strong>${who} — ${platforms} — ${when}</p>`,
    `<p>${escapeHtml(p.message)}</p>`,
    link,
    `</li>`,
  ].join("\n");
}

/** Text is authoritative; HTML renders the same content with no images and no remote content (FR-014). */
export function renderProblemEmail(m: ProblemEmailModel): { subject: string; text: string; html: string } {
  const total = m.groups.reduce((n, g) => n + g.problems.length + g.overflow, 0);
  if (total === 0) throw new Error("renderProblemEmail: no problems to render");

  const subject = m.cadence === "digest" ? `Docket: ${total} problem${total === 1 ? "" : "s"} today` : `Docket: ${total} problem${total === 1 ? "" : "s"}`;

  const textParts: string[] = [];
  const htmlParts: string[] = [];
  for (const group of m.groups) {
    textParts.push(`${group.name}`, "");
    for (const p of group.problems) textParts.push(problemText(p, m.timeZone), "");
    if (group.overflow > 0) textParts.push(`...and ${group.overflow} more. See: ${group.overflowHref}`, "");

    htmlParts.push(`<h2>${escapeHtml(group.name)}</h2>`, `<ul>`);
    for (const p of group.problems) htmlParts.push(problemHtml(p, m.timeZone));
    htmlParts.push(`</ul>`);
    if (group.overflow > 0) {
      htmlParts.push(`<p>...and ${group.overflow} more. <a href="${escapeHtml(group.overflowHref)}">See them all</a>.</p>`);
    }
  }

  textParts.push(`Unsubscribe: ${m.unsubscribeUrl}`);
  htmlParts.push(`<p><a href="${escapeHtml(m.unsubscribeUrl)}">Unsubscribe</a></p>`);

  return {
    subject,
    text: textParts.join("\n"),
    html: `<html><body>${htmlParts.join("\n")}</body></html>`,
  };
}

export interface InvitationEmailModel {
  projectName: string;
  roleLabel: string;
  inviterName: string;
  expiresAt: Date;
  timeZone: string;
  acceptUrl: string;
}

/** No unsubscribe link and no unsubscribe header: there is nothing recurring to leave (N64, FR-040). */
export function renderInvitationEmail(m: InvitationEmailModel): { subject: string; text: string; html: string } {
  const expires = formatLocal(m.expiresAt, m.timeZone);
  const subject = `${m.inviterName} invited you to ${m.projectName} on Docket`;
  const text = [
    `${m.inviterName} invited you to join ${m.projectName} on Docket as ${m.roleLabel}.`,
    `Accept: ${m.acceptUrl}`,
    `This invitation expires ${expires}.`,
  ].join("\n");
  const html = [
    `<html><body>`,
    `<p>${escapeHtml(m.inviterName)} invited you to join ${escapeHtml(m.projectName)} on Docket as ${escapeHtml(m.roleLabel)}.</p>`,
    `<p><a href="${escapeHtml(m.acceptUrl)}">Accept the invitation</a></p>`,
    `<p>This invitation expires ${escapeHtml(expires)}.</p>`,
    `</body></html>`,
  ].join("\n");
  return { subject, text, html };
}
