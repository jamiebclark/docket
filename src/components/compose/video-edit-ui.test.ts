import { describe, expect, it } from "vitest";
import { checkTrim, cutNotes, focalFromKey, focalFromPointer, focalText, formatTrim, parseTrim } from "./video-edit-ui";

describe("trim text", () => {
  it("parses the accepted forms to milliseconds", () => {
    expect(parseTrim("2:15.0")).toEqual({ ok: true, ms: 135_000 });
    expect(parseTrim("75")).toEqual({ ok: true, ms: 75_000 });
    expect(parseTrim("0:01.5")).toEqual({ ok: true, ms: 1500 });
    expect(parseTrim(" 12.3 ")).toEqual({ ok: true, ms: 12_300 });
  });

  it("refuses anything finer than a tenth, and text that is not a time", () => {
    expect(parseTrim("0:00.05").ok).toBe(false);
    expect(parseTrim("abc").ok).toBe(false);
    expect(parseTrim("1:75").ok).toBe(false);
    expect(parseTrim("").ok).toBe(false);
  });

  it("formats as m:ss.s", () => {
    expect(formatTrim(135_000)).toBe("2:15.0");
    expect(formatTrim(65_300)).toBe("1:05.3");
    expect(formatTrim(0)).toBe("0:00.0");
  });
});

describe("checkTrim", () => {
  const length = 192_400;

  it("accepts a part of the video; an empty end is the end of the video", () => {
    expect(checkTrim("0:10.0", "1:00.0", length)).toEqual({ ok: true, startMs: 10_000, endMs: 60_000 });
    expect(checkTrim("", "", length)).toEqual({ ok: true, startMs: 0, endMs: null });
    expect(checkTrim("0:00.0", "3:12.4", length)).toEqual({ ok: true, startMs: 0, endMs: null });
  });

  it("words each refusal", () => {
    expect(checkTrim("1:00.0", "0:30.0", length)).toMatchObject({ ok: false, field: "end", message: "The end must be after the start." });
    expect(checkTrim("5:00.0", "", length)).toMatchObject({
      ok: false,
      field: "start",
      message: "The start must be inside the video (length 3:12.4).",
    });
    expect(checkTrim("0:10.0", "0:10.5", length)).toMatchObject({ ok: false, message: "Keep at least 1 second." });
    expect(checkTrim("0:10.0", "9:00.0", length)).toMatchObject({ ok: false, field: "end" });
    expect(checkTrim("x", "", length)).toMatchObject({ ok: false, field: "start" });
  });
});

describe("focal point", () => {
  it("maps the pointer to a clamped fraction of the displayed image", () => {
    const box = { left: 100, top: 50, width: 200, height: 100 };
    expect(focalFromPointer(140, 100, box)).toEqual({ x: 0.2, y: 0.5 });
    expect(focalFromPointer(0, 1000, box)).toEqual({ x: 0, y: 1 });
  });

  it("moves 5% per arrow, 1% with Shift, and centres on Home", () => {
    expect(focalFromKey({ x: 0.5, y: 0.5 }, "ArrowRight")).toEqual({ x: 0.55, y: 0.5 });
    expect(focalFromKey({ x: 0.5, y: 0.5 }, "ArrowUp", true)).toEqual({ x: 0.5, y: 0.49 });
    expect(focalFromKey({ x: 0.98, y: 0.02 }, "ArrowRight")).toEqual({ x: 1, y: 0.02 });
    expect(focalFromKey({ x: 0.98, y: 0.02 }, "ArrowUp")).toEqual({ x: 0.98, y: 0 });
    expect(focalFromKey({ x: 0.1, y: 0.9 }, "Home")).toEqual({ x: 0.5, y: 0.5 });
    expect(focalFromKey({ x: 0.1, y: 0.9 }, "a")).toBeNull();
  });

  it("speaks the position", () => {
    expect(focalText({ x: 0.2, y: 0.5 })).toBe("20% across, 50% down");
  });
});

describe("cutNotes", () => {
  const issue = (code: string, field: string, message: string) => ({ code, field, message });
  const targets = [
    { issues: [issue("video_will_cut", "media.0", "Video 1 will be cut to the first 1:30 for Instagram."), issue("video_will_pad", "media.0", "padded")] },
    { issues: [issue("video_will_cut", "media.1", "Video 2 will be cut to 0:60 for Threads.")] },
    { issues: [] },
  ];

  it("keeps only the cut notes for that item, across targets", () => {
    expect(cutNotes(targets, 0)).toEqual(["Video 1 will be cut to the first 1:30 for Instagram."]);
    expect(cutNotes(targets, 1)).toEqual(["Video 2 will be cut to 0:60 for Threads."]);
    expect(cutNotes(targets, 2)).toEqual([]);
  });
});
