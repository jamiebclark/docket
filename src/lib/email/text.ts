// Every sentence and confirmation code FR-038 asks for, in words. Pure, and subject to the
// date-format lint (no instant is ever stringified here directly).

/** A wall hour (0-23) as "7:00 AM" — used by the settings card and by the `digest` confirmation. */
export function formatHourLabel(hour: number): string {
  const period = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:00 ${period}`;
}

export function onlyProblemsText(): string {
  return "Email carries problems only — failed posts, uncertain results and accounts that need reconnecting. Successes are never emailed.";
}

export function followsSwitchesText(): string {
  return "Which problems are emailed follows the notification switches you have already set for each project.";
}

export function offKeepsBellText(): string {
  return "Turning email off leaves your in-app notifications exactly as they are.";
}

export function digestBeatsQuietText(): string {
  return "A digest is sent at the hour you choose, even if that hour is inside your quiet hours — you asked for it.";
}

/** `n` is the install's scheduler interval, in seconds. */
export function immediateMeansText(n: number): string {
  return `Immediate means on the next scheduler run, about every ${n} seconds on this install.`;
}

export function unavailableText(): string {
  return "This install has no mail server configured, so email is unavailable. Ask an owner to set one up — see the deployment guide.";
}

export function noProjectsText(): string {
  return "You are not in any project yet, so there is nothing to email you about.";
}

export function allSwitchesOffText(): string {
  return "Every notification switch is off in all of your projects, so email would have nothing to send.";
}

export function pausedRejectedText(): string {
  return "Email is paused because your address was rejected. Check the address on your account, then resume.";
}

export function pausedFailingText(): string {
  return "Email is paused after repeated delivery failures. Resume when you think it is fixed.";
}

export function zoneDerivedText(zone: string): string {
  return `Using ${zone}, the time zone your projects use. Choose your own below.`;
}

export function zoneDerivedUtcText(): string {
  return "Using UTC, because your projects do not all use the same time zone. Choose your own below.";
}

export function zoneUnknownText(): string {
  return "The time zone saved on your settings is not one this server recognises, so UTC is being used. Choose another below.";
}

export const EMAIL_CONFIRMATION_CODES = [
  "saved",
  "resumed",
  "off",
  "digest",
  "immediate",
  "project_off",
] as const;
export type EmailConfirmationCode = (typeof EMAIL_CONFIRMATION_CODES)[number];

/** From the redirect's `email` query param; unrecognised values -> null (043's Q20 shape). */
export function parseEmailConfirmation(value: unknown): EmailConfirmationCode | null {
  return typeof value === "string" && (EMAIL_CONFIRMATION_CODES as readonly string[]).includes(value)
    ? (value as EmailConfirmationCode)
    : null;
}

export interface EmailConfirmationParams {
  /** Already formatted for display, e.g. "7 AM" — needed for `digest`. */
  hour?: string;
  /** Needed for `digest`. */
  zone?: string;
  /** Needed for `project_off`. */
  projectName?: string;
}

/** `null` renders the generic sentence rather than erroring — the http.md §3 rule. */
export function emailConfirmationText(
  code: EmailConfirmationCode | null,
  params: EmailConfirmationParams = {},
): string {
  switch (code) {
    case "saved":
      return "Email settings saved.";
    case "resumed":
      return "Email resumed. You will get the next due message.";
    case "off":
      return "Email is off. You will not be emailed about problems.";
    case "digest":
      return `Switched to one email a day at ${params.hour} ${params.zone}.`;
    case "immediate":
      return "Switched to immediate email.";
    case "project_off":
      return `${params.projectName} problems will not be emailed. Your other projects still will.`;
    default:
      return "Email settings updated.";
  }
}
