// Pure helpers for the series screens, kept out of the client components so tests can import them.
import type { ActionResult } from "@/lib/action-result";

export interface Angle {
  title: string;
  description: string;
}

export const SERIES_COUNT_MIN = 2;
export const SERIES_COUNT_MAX = 10;
export const ANGLES_MIN = 1;
export const ANGLES_MAX = 10;
export const TITLE_MAX = 120;
export const DESCRIPTION_MAX = 300;

export const editAngle = (angles: readonly Angle[], index: number, patch: Partial<Angle>): Angle[] =>
  angles.map((a, i) => (i === index ? { ...a, ...patch } : a));

export function moveAngle(angles: readonly Angle[], index: number, by: -1 | 1): Angle[] {
  const to = index + by;
  if (to < 0 || to >= angles.length) return [...angles];
  const next = [...angles];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}

export const removeAngle = (angles: readonly Angle[], index: number): Angle[] => angles.filter((_, i) => i !== index);

export const addAngle = (angles: readonly Angle[]): Angle[] =>
  angles.length >= ANGLES_MAX ? [...angles] : [...angles, { title: "", description: "" }];

/** The reason posts cannot be written yet, or null when the plan is ready. */
export function planProblem(angles: readonly Angle[]): string | null {
  if (angles.length < ANGLES_MIN) return `Keep at least ${ANGLES_MIN} angle.`;
  if (angles.length > ANGLES_MAX) return `A series can have at most ${ANGLES_MAX} angles.`;
  const blank = angles.findIndex((a) => a.title.trim() === "" || a.description.trim() === "");
  if (blank >= 0) return `Angle ${blank + 1} needs a title and a description.`;
  return null;
}

export type Slot =
  | { state: "pending" }
  | { state: "writing" }
  | { state: "done"; postId: string }
  | { state: "failed"; message: string };

export type WriteOutcome = ActionResult<
  { ok: true; postId: string; position: number } | { ok: false; message: string; position: number }
>;

export function slotFromOutcome(result: WriteOutcome): Slot {
  if (!result.ok) return { state: "failed", message: result.message };
  if (!result.data.ok) return { state: "failed", message: result.data.message };
  return { state: "done", postId: result.data.postId };
}

/** Writes the positions one after the other, never concurrently, so queued posts take slots in plan order. */
export async function writeInOrder(
  positions: readonly number[],
  write: (position: number) => Promise<WriteOutcome>,
  onSlot: (position: number, slot: Slot) => void,
): Promise<void> {
  for (const position of positions) {
    onSlot(position, { state: "writing" });
    let slot: Slot;
    try {
      slot = slotFromOutcome(await write(position));
    } catch {
      slot = { state: "failed", message: "Something went wrong. Try again." };
    }
    onSlot(position, slot);
  }
}

export function progressLabel(slots: readonly Slot[]): string {
  const total = slots.length;
  const done = slots.filter((s) => s.state === "done").length;
  const failed = slots.filter((s) => s.state === "failed").length;
  const busy = slots.some((s) => s.state === "writing" || s.state === "pending");
  if (busy) return `Writing post ${Math.min(done + failed + 1, total)} of ${total}…`;
  if (failed === 0) return `All ${total} posts are written.`;
  return `${done} of ${total} posts written. ${failed} failed.`;
}
