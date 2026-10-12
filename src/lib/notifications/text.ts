// Wording for the bell, the callout and the notification settings. Pure.
import { UNREAD_CAP } from "./attention";
import { formatLocal } from "../time/format";
import { OUTCOME_LABEL, type ActivityOutcome } from "../activity/outcomes";
import type { SwitchAxis } from "./eligibility";

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

/** One switch, by name, for one project (FR-017). */
export function switchConfirmation(projectName: string, label: string, on: boolean): string {
  return on
    ? `${label} notifications for ${projectName} are on. Problems from now on will reach you.`
    : `${label} notifications for ${projectName} are off. Its problems still appear in Activity.`;
}

/** The project-level "This project" control (FR-017); the off sentence is the old `mutedConfirmation` wording, kept word-for-word. */
export function projectSwitchConfirmation(projectName: string, on: boolean): string {
  return on
    ? `Notifications for ${projectName} are on. Problems from now on will reach you.`
    : `Notifications for ${projectName} are off. Its problems still appear in Activity.`;
}

export interface SwitchChangeQuery {
  axis: SwitchAxis | "project";
  key?: string;
  on: boolean;
}

/** From the redirect's query string; unknown axis or malformed key -> null, and the page renders "Notifications updated." */
export function parseSwitchChange(raw: { axis?: unknown; key?: unknown; on?: unknown }): SwitchChangeQuery | null {
  const axis = raw.axis;
  if (axis !== "kind" && axis !== "platform" && axis !== "project") return null;
  const key = typeof raw.key === "string" && raw.key.length > 0 ? raw.key : undefined;
  if (axis === "project" ? key !== undefined : key === undefined) return null;
  const on = raw.on === "1" ? true : raw.on === "0" ? false : null;
  if (on === null) return null;
  return key === undefined ? { axis, on } : { axis, key, on };
}

/** Below the preference grid (FR-018). */
export function preferenceHelpText(): string {
  return "Turning a switch off only hides its notifications — the problems stay in Activity for everyone. Turning one back on starts from that moment: anything from while it was off is never delivered later.";
}

/** The roll-up, said the same way everywhere (FR-005). */
export function projectOffText(): string {
  return "Notifications for this project are off.";
}

/** What the spec's edge case asks for when every kind is on but platforms are off. */
export function platformsOffNote(labels: readonly string[]): string {
  return `Switched off: ${labels.join(", ")}.`;
}

/** `OUTCOME_LABEL[key]` for a kind; the platform's display name otherwise. Takes the resolved name so this module stays pure and registry-free. */
export function switchLabel(axis: SwitchAxis, key: string, platformName?: string): string {
  if (axis === "kind") return OUTCOME_LABEL[key as ActivityOutcome] ?? key;
  return platformName ?? key;
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
