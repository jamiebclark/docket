/**
 * The problem email's shape: its subject and its one layout. Pure, so both are tested without a mailer.
 *
 * FR-014 governs everything here: a plain-text part that is authoritative, an HTML alternative
 * carrying the same content, no images, no remote content, and nothing whose meaning rests on colour
 * alone. "Minimal HTML" is read as *self-contained* — one inline-styled table, no stylesheet, no web
 * font, no tracking pixel — not as unformatted, because the unformatted version was unreadable (020
 * feedback).
 */

import { OUTCOME_COUNT_NOUN, OUTCOME_TONE, type ActivityOutcome, type ActivityTone } from "../activity/outcomes";
import { joinPhrases } from "../engagement/kinds";
import { formatLocal } from "../time/format";

export interface EmailProblem {
  outcome: ActivityOutcome;
  /** `outcomeHeading(outcome)` — passed in rather than derived, so the email never re-words the app. */
  outcomeLabel: string;
  occurredAt: Date;
  platforms: { key: string; name: string }[];
  accountName: string | null;
  message: string;
  /** Where the row leads, and what the link calls itself. Never null: FR-011 requires a link. */
  href: string;
  actionLabel: string;
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

/** Clients truncate around 70 characters; this is the point past which nothing is gained by going on. */
const SUBJECT_MAX = 110;

/** At most this many outcome phrases are named before the rest collapse into "and N more". */
const SUBJECT_PHRASES = 2;

// The light-theme design tokens (docs/design-system.md §3), written out: an email cannot read a CSS
// variable, and a mail client may drop a <style> block but will keep a style attribute.
const C = {
  background: "#F8F9FA",
  surface: "#FFFFFF",
  foreground: "#212121",
  mutedForeground: "#5E5768",
  heading: "#4A148C",
  border: "#E4DDEB",
  primary: "#4A148C",
  primaryForeground: "#FFFFFF",
} as const;

const TONE_COLOR: Record<ActivityTone, string> = {
  danger: "#B3261E",
  warning: "#8A4B00",
  success: "#1B6E3A",
  info: "#1F5BA8",
  neutral: "#5E5768",
};

const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** "2 failed posts", "1 new inbox message". */
function countPhrase(outcome: ActivityOutcome, count: number): string {
  const noun = OUTCOME_COUNT_NOUN[outcome];
  return `${count} ${count === 1 ? noun.one : noun.many}`;
}

/** Counted in the order they first appear, so the subject leads with the project's newest news. */
function countByOutcome(groups: EmailProjectGroup[]): Map<ActivityOutcome, number> {
  const counts = new Map<ActivityOutcome, number>();
  for (const group of groups) {
    for (const problem of group.problems) counts.set(problem.outcome, (counts.get(problem.outcome) ?? 0) + 1);
  }
  return counts;
}

/**
 * A subject that names what happened and where: "Stencilvania: 1 new inbox message".
 *
 * It replaced "Docket: 1 problem", which said neither — the recipient had to open the message to
 * learn the project, and the one word it did spend was wrong for the commonest case (020 feedback).
 */
export function problemEmailSubject(m: ProblemEmailModel): string {
  const counts = countByOutcome(m.groups);
  const overflow = m.groups.reduce((n, g) => n + g.overflow, 0);

  const named = [...counts.entries()].slice(0, SUBJECT_PHRASES).map(([outcome, n]) => countPhrase(outcome, n));
  const unnamed = [...counts.entries()].slice(SUBJECT_PHRASES).reduce((n, [, count]) => n + count, 0) + overflow;
  if (unnamed > 0) named.push(`${unnamed} more`);

  const across = m.groups.length === 1 ? "" : ` across ${m.groups.length} projects`;
  const when = m.cadence === "digest" ? " today" : "";
  const tail = `: ${joinPhrases(named)}${when}${across}`;

  // The counts are the part worth keeping, so a very long project name gives way to them rather than
  // filling the whole line and leaving the reader exactly where the old "1 problem" subject did.
  const scope = m.groups.length === 1 ? m.groups[0]!.name : "Docket";
  const room = SUBJECT_MAX - tail.length;
  return `${scope.length <= room ? scope : `${scope.slice(0, Math.max(room - 1, 1)).trimEnd()}…`}${tail}`;
}

/** The meta line: the account, the platforms and the instant, in that order, wherever they exist. */
function metaParts(p: EmailProblem, zone: string): string[] {
  const platforms = p.platforms.map((x) => x.name).join(", ");
  return [p.accountName, platforms, formatLocal(p.occurredAt, zone)].filter((x): x is string => Boolean(x));
}

function problemText(p: EmailProblem, zone: string): string {
  return [`${p.outcomeLabel} — ${metaParts(p, zone).join(" — ")}`, p.message, `${p.actionLabel}: ${p.href}`].join("\n");
}

function problemHtml(p: EmailProblem, zone: string): string {
  // A tone-coloured rule down the left edge, never the only carrier of the meaning: the outcome is
  // spelled out in the heading immediately beside it (FR-014).
  const tone = TONE_COLOR[OUTCOME_TONE[p.outcome]];
  return [
    `<tr><td style="padding:0 0 12px">`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:separate;background:${C.surface};border:1px solid ${C.border};border-left:4px solid ${tone};border-radius:8px">`,
    `<tr><td style="padding:14px 16px">`,
    `<div style="font:600 15px/1.4 ${FONT};color:${tone}">${escapeHtml(p.outcomeLabel)}</div>`,
    `<div style="margin-top:2px;font:400 13px/1.5 ${FONT};color:${C.mutedForeground}">${escapeHtml(metaParts(p, zone).join(" · "))}</div>`,
    `<div style="margin-top:8px;font:400 15px/1.5 ${FONT};color:${C.foreground}">${escapeHtml(p.message)}</div>`,
    `<div style="margin-top:12px"><a href="${escapeHtml(p.href)}" style="display:inline-block;padding:8px 14px;border-radius:6px;background:${C.primary};color:${C.primaryForeground};font:600 14px/1 ${FONT};text-decoration:none">${escapeHtml(p.actionLabel)}</a></div>`,
    `</td></tr></table>`,
    `</td></tr>`,
  ].join("\n");
}

function groupHtml(group: EmailProjectGroup, zone: string): string {
  const parts = [
    `<tr><td style="padding:8px 0 10px">`,
    `<div style="font:700 13px/1.3 ${FONT};letter-spacing:.06em;text-transform:uppercase;color:${C.heading}">${escapeHtml(group.name)}</div>`,
    `</td></tr>`,
    ...group.problems.map((p) => problemHtml(p, zone)),
  ];
  if (group.overflow > 0) {
    parts.push(
      `<tr><td style="padding:0 0 12px;font:400 14px/1.5 ${FONT};color:${C.mutedForeground}">` +
        `...and ${group.overflow} more. <a href="${escapeHtml(group.overflowHref)}" style="color:${C.primary}">See them all</a>.` +
        `</td></tr>`,
    );
  }
  return parts.join("\n");
}

/** Text is authoritative; HTML renders the same content with no images and no remote content (FR-014). */
export function renderProblemEmail(m: ProblemEmailModel): { subject: string; text: string; html: string } {
  const total = m.groups.reduce((n, g) => n + g.problems.length + g.overflow, 0);
  if (total === 0) throw new Error("renderProblemEmail: no problems to render");

  const subject = problemEmailSubject(m);
  const intro = m.cadence === "digest" ? "Here is what needed you in Docket today." : "Here is what just happened in Docket.";

  const textParts: string[] = [intro, ""];
  for (const group of m.groups) {
    textParts.push(group.name, "");
    for (const p of group.problems) textParts.push(problemText(p, m.timeZone), "");
    if (group.overflow > 0) textParts.push(`...and ${group.overflow} more. See: ${group.overflowHref}`, "");
  }
  textParts.push(`All times ${m.timeZone}.`, `Unsubscribe: ${m.unsubscribeUrl}`);

  const html = [
    `<!doctype html>`,
    `<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(subject)}</title></head>`,
    `<body style="margin:0;padding:0;background:${C.background};color:${C.foreground}">`,
    // One centring table: flexbox and max-width behave in a browser, not in a mail client.
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${C.background}">`,
    `<tr><td align="center" style="padding:24px 12px">`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:100%;max-width:600px">`,
    `<tr><td style="padding:0 0 4px;font:700 20px/1.3 ${FONT};color:${C.heading}">Docket</td></tr>`,
    `<tr><td style="padding:0 0 12px;font:400 15px/1.5 ${FONT};color:${C.mutedForeground}">${escapeHtml(intro)}</td></tr>`,
    ...m.groups.map((group) => groupHtml(group, m.timeZone)),
    `<tr><td style="padding:12px 0 0;border-top:1px solid ${C.border};font:400 13px/1.6 ${FONT};color:${C.mutedForeground}">`,
    `All times ${escapeHtml(m.timeZone)}.<br>`,
    `<a href="${escapeHtml(m.unsubscribeUrl)}" style="color:${C.mutedForeground}">Unsubscribe from these emails</a>`,
    `</td></tr>`,
    `</table></td></tr></table></body></html>`,
  ].join("\n");

  return { subject, text: textParts.join("\n"), html };
}
