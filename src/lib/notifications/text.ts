// Wording for the bell, the callout and the notification settings. Pure.
import { UNREAD_CAP } from "./attention";
import { formatLocal } from "../time/format";

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

/** "Marked as read. 2 unread problems." / "Marked as read. No unread problems." */
export function markedReadConfirmation(count: number): string {
  return `Marked as read. ${unreadLabel(count)}.`;
}

/** "Marked as read." and, when any snoozes were cleared, the added sentence naming how many (FR-013). */
export function markAllConfirmation(snoozesCleared: number): string {
  if (snoozesCleared <= 0) return "Marked as read.";
  return `Marked as read. ${snoozesCleared} snoozed ${snoozesCleared === 1 ? "problem was" : "problems were"} cleared too.`;
}

/** "Snoozed until Mon, Oct 12, 9:00 AM EDT." (FR-016). */
export function snoozedConfirmation(until: Date, timeZone: string): string {
  return `Snoozed until ${formatLocal(until, timeZone)}.`;
}

/** Shown on a row when its project has reached the per-person mark cap (FR-020). */
export function markCapText(): string {
  return "Per-problem actions are unavailable for this project until it is marked read.";
}

export type RowErrorCode = "busy" | "not_found" | "at_cap" | "invalid";

export function parseRowErrorCode(value: unknown): RowErrorCode | null {
  return value === "busy" || value === "not_found" || value === "at_cap" || value === "invalid" ? value : null;
}

/** The same "not found" sentence for an unknown id, a foreign project's id and a non-attention event (N23). */
export function rowErrorText(code: RowErrorCode): string {
  if (code === "busy") return "Could not save just now. Try again.";
  if (code === "not_found") return "That problem could not be found.";
  if (code === "at_cap") return markCapText();
  return "That change was not understood. Try again.";
}
