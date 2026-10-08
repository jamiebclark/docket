import { MIN_TRIM_MS } from "@/lib/video/edit";

export interface Focal {
  /** 0..1 of the displayed width. */
  x: number;
  /** 0..1 of the displayed height. */
  y: number;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
/** Positions are kept to whole percents so the spoken text and the stored value agree. */
const whole = (n: number) => Math.round(clamp01(n) * 100) / 100;

/** "1:05.3" for 65 300; the form the trim fields show and accept. */
export function formatTrim(ms: number): string {
  const tenths = Math.round(ms / 100);
  const minutes = Math.floor(tenths / 600);
  const rest = tenths - minutes * 600;
  const seconds = Math.floor(rest / 10);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${rest % 10}`;
}

/** A video's length for display, "3:12.4". */
export const lengthText = formatTrim;

const FORMS = /^(?:(\d+):)?(\d+)(?:\.(\d+))?$/;

export type TrimParse = { ok: true; ms: number } | { ok: false; message: string };

/** Accepts "m:ss.s", "m:ss", "ss" and "ss.s"; only tenths of a second are kept, so "0:00.05" is refused. */
export function parseTrim(text: string): TrimParse {
  const m = FORMS.exec(text.trim());
  if (!m) return { ok: false, message: "Enter a time like 1:05.3." };
  const [, minutes, seconds, fraction] = m;
  if (fraction !== undefined && fraction.length > 1) return { ok: false, message: "Use whole tenths of a second, like 1:05.3." };
  const secs = Number(seconds);
  if (minutes !== undefined && secs >= 60) return { ok: false, message: "Seconds must be under 60 when minutes are given." };
  return { ok: true, ms: (Number(minutes ?? 0) * 60 + secs) * 1000 + Number(fraction ?? 0) * 100 };
}

export type TrimCheck = { ok: true; startMs: number; endMs: number | null } | { ok: false; field: "start" | "end"; message: string };

/**
 * Validates the two fields against the video's length. An empty end means the end of the video. An error keeps the
 * previous edit: the caller applies nothing unless this is `ok`.
 */
export function checkTrim(startText: string, endText: string, durationMs: number): TrimCheck {
  const start = startText.trim() === "" ? ({ ok: true, ms: 0 } as const) : parseTrim(startText);
  if (!start.ok) return { ok: false, field: "start", message: start.message };
  const end = endText.trim() === "" ? null : parseTrim(endText);
  if (end && !end.ok) return { ok: false, field: "end", message: end.message };
  if (start.ms > durationMs - MIN_TRIM_MS) {
    return { ok: false, field: "start", message: `The start must be inside the video (length ${lengthText(durationMs)}).` };
  }
  if (end) {
    if (end.ms <= start.ms) return { ok: false, field: "end", message: "The end must be after the start." };
    if (end.ms > durationMs) return { ok: false, field: "end", message: `The end must be inside the video (length ${lengthText(durationMs)}).` };
  }
  const endMs = end ? end.ms : null;
  if ((endMs ?? durationMs) - start.ms < MIN_TRIM_MS) return { ok: false, field: "end", message: "Keep at least 1 second." };
  return { ok: true, startMs: start.ms, endMs: endMs === durationMs ? null : endMs };
}

/** The point under the pointer, from the displayed image's box; clamped to the image. */
export function focalFromPointer(clientX: number, clientY: number, box: { left: number; top: number; width: number; height: number }): Focal {
  if (box.width <= 0 || box.height <= 0) return { x: 0.5, y: 0.5 };
  return { x: whole((clientX - box.left) / box.width), y: whole((clientY - box.top) / box.height) };
}

const STEP = 0.05;
const FINE_STEP = 0.01;

/** The point after an arrow key (5%, Shift 1%) or Home (centre), or `null` for any other key. */
export function focalFromKey(focal: Focal, key: string, shift = false): Focal | null {
  const step = shift ? FINE_STEP : STEP;
  switch (key) {
    case "ArrowLeft":
      return { x: whole(focal.x - step), y: focal.y };
    case "ArrowRight":
      return { x: whole(focal.x + step), y: focal.y };
    case "ArrowUp":
      return { x: focal.x, y: whole(focal.y - step) };
    case "ArrowDown":
      return { x: focal.x, y: whole(focal.y + step) };
    case "Home":
      return { x: 0.5, y: 0.5 };
    default:
      return null;
  }
}

/** The spoken position, "20% across, 50% down". */
export function focalText(focal: Focal): string {
  return `${Math.round(focal.x * 100)}% across, ${Math.round(focal.y * 100)}% down`;
}

/** The planner's "will be cut" notes for one attached item (by its position), across every checked target. */
export function cutNotes(targets: { issues: { code: string; message: string; field: string }[] }[], mediaIndex: number): string[] {
  const field = `media.${mediaIndex}`;
  return targets.flatMap((t) => t.issues.filter((i) => i.code === "video_will_cut" && i.field === field).map((i) => i.message));
}
