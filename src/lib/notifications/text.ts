// Wording for the bell, the callout and the notification settings. Pure.
import { UNREAD_CAP } from "./attention";

const MAX_SHOWN = UNREAD_CAP - 1;

/** The badge text: nothing at zero, then "1" … "99", then "99+". */
export function unreadDisplay(n: number): string {
  if (n <= 0) return "";
  return n > MAX_SHOWN ? `${MAX_SHOWN}+` : String(n);
}

/** The bell's accessible name. */
export function unreadLabel(n: number): string {
  if (n <= 0) return "No unread problems";
  if (n > MAX_SHOWN) return `More than ${MAX_SHOWN} unread problems`;
  return `${n} unread ${n === 1 ? "problem" : "problems"}`;
}

/** The callout's count, as text. */
export function calloutCountText(n: number): string {
  if (n > MAX_SHOWN) return `More than ${MAX_SHOWN} problems`;
  return `${n} ${n === 1 ? "problem" : "problems"}`;
}

export function mutedConfirmation(name: string, on: boolean): string {
  return on
    ? `Notifications for ${name} are on. Earlier problems are marked as read.`
    : `Notifications for ${name} are off. Its problems still appear in Activity.`;
}

export type MuteErrorCode = "busy" | "not_found" | "invalid";

export function parseMuteError(value: unknown): MuteErrorCode | null {
  return value === "busy" || value === "not_found" || value === "invalid" ? value : null;
}

/** Shown when turning notifications on or off did not take effect. */
export function muteErrorText(code: MuteErrorCode): string {
  if (code === "busy") return "Could not change notifications just now. Try again.";
  if (code === "not_found") return "That project could not be found.";
  return "That change was not understood. Try again.";
}
