import { describe, expect, it } from "vitest";
import { canConfirm, confirmLabel, retryAnnouncement } from "./retry-ui";

const okPreview = { ok: true as const, scheduledAt: "2026-10-12T09:00:00.000Z", localTime: "Mon 9:00", slotId: "s" };
const badPreview = { ok: false as const, code: "no_free_occurrence" as const, message: "none" };
const time = (inPast: boolean) => ({ kind: "exact" as const, instant: "2026-10-12T09:00:00.000Z", resolvedLocal: "2026-10-12T09:00", inPast, warnings: [] });
const scheduled = (over: object) => ({
  status: "scheduled" as const,
  mode: "now" as const,
  scheduledAt: "2026-10-12T09:00:00.000Z",
  localTime: "Mon 12 Oct, 9:00",
  slotId: null,
  changedFromPreview: false,
  warnings: [],
  ...over,
});

describe("canConfirm", () => {
  it("always allows now", () => {
    expect(canConfirm("now", "loading", null)).toBe(true);
    expect(canConfirm("now", null, null)).toBe(true);
  });
  it("requeue needs an ok preview", () => {
    expect(canConfirm("requeue", okPreview, null)).toBe(true);
    expect(canConfirm("requeue", "loading", null)).toBe(false);
    expect(canConfirm("requeue", null, null)).toBe(false);
    expect(canConfirm("requeue", badPreview, null)).toBe(false);
  });
  it("at needs a time that is not in the past", () => {
    expect(canConfirm("at", null, time(false))).toBe(true);
    expect(canConfirm("at", null, time(true))).toBe(false);
    expect(canConfirm("at", null, null)).toBe(false);
  });
});

describe("retryAnnouncement", () => {
  it("now", () => {
    expect(retryAnnouncement(scheduled({}))).toBe("Retry queued for the next tick.");
  });
  it("requeue, with and without a changed slot", () => {
    expect(retryAnnouncement(scheduled({ mode: "requeue" }))).toBe("Retry scheduled for Mon 12 Oct, 9:00 in the next free slot.");
    expect(retryAnnouncement(scheduled({ mode: "requeue", changedFromPreview: true }))).toBe(
      "Retry scheduled for Mon 12 Oct, 9:00 in the next free slot. The previewed slot was taken, so the time changed.",
    );
  });
  it("at, with warnings", () => {
    expect(retryAnnouncement(scheduled({ mode: "at" }))).toBe("Retry scheduled for Mon 12 Oct, 9:00.");
    expect(retryAnnouncement(scheduled({ mode: "at", warnings: [{ message: "Close to another post." }] }))).toBe(
      "Retry scheduled for Mon 12 Oct, 9:00. Close to another post.",
    );
  });
});

describe("confirmLabel", () => {
  it("names each mode", () => {
    expect(confirmLabel("now")).toBe("Retry now");
    expect(confirmLabel("requeue")).toBe("Retry in next free slot");
    expect(confirmLabel("at")).toBe("Retry at this time");
  });
});
