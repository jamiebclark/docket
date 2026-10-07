import { describe, expect, it } from "vitest";
import type { EngineEvent, Reason, UploadRowState } from "@/lib/upload/engine";
import { MIB, TEST_LIMITS } from "@/lib/upload/test-support";
import { announcementFor, acceptAttribute, byteLabel, durationLabel, helpText, reasonText, rowStatusText } from "./upload-ui";

const row = (over: Partial<UploadRowState>): UploadRowState => ({
  id: "1",
  name: "clip.mp4",
  state: "waiting",
  kind: "video",
  bytesSent: 0,
  total: 400_000_000,
  reason: null,
  step: null,
  waitingForWorker: false,
  checksAfterUpload: false,
  assetId: null,
  ...over,
});

describe("upload wording", () => {
  it("builds the help text and the accept list from the served limits", () => {
    expect(helpText(TEST_LIMITS)).toBe(
      "Drop files here or choose them. Images: JPEG, PNG or WebP up to 20 MB. Videos: MP4 or MOV up to 1024 MB and 15 minutes.",
    );
    expect(acceptAttribute(TEST_LIMITS)).toBe("image/jpeg,image/png,image/webp,video/mp4,video/quicktime");
  });

  it("labels bytes in decimal megabytes and durations in words", () => {
    expect(byteLabel(12_500_000)).toBe("12.5 MB");
    expect(durationLabel(60)).toBe("1 minute");
    expect(durationLabel(900)).toBe("15 minutes");
    expect(durationLabel(45)).toBe("45 seconds");
    expect(durationLabel(75)).toBe("1:15");
  });

  it("says what every row state shows", () => {
    const text = (r: Partial<UploadRowState>) => rowStatusText(row(r), TEST_LIMITS);
    expect(text({ state: "checking" })).toBe("Checking…");
    expect(text({ state: "waiting" })).toBe("Waiting");
    expect(text({ state: "uploading", bytesSent: 12_500_000, total: 400_000_000 })).toBe("12.5 MB of 400 MB (3 %)");
    expect(text({ state: "cancelled" })).toBe("Cancelled");
    expect(text({ state: "ready" })).toBe("Ready");
    expect(text({ state: "processing" })).toBe("Processing");
    expect(text({ state: "processing", step: "probing" })).toBe("Processing: reading the video");
    expect(text({ state: "processing", step: "poster" })).toBe("Processing: making the poster frame");
    expect(text({ state: "processing", step: "queued", waitingForWorker: true })).toBe("Processing is waiting for the worker");
    expect(text({ state: "refused", reason: { kind: "precheck", code: "no_video", values: {} } })).toBe("Not uploaded: This file has no video.");
    expect(text({ state: "interrupted", reason: { kind: "network" } })).toBe("Upload interrupted: the connection was lost");
    expect(text({ state: "failed", reason: { kind: "server", message: "Docket could not read this video." } })).toBe(
      "Failed: Docket could not read this video.",
    );
  });

  it("words every refusal and interruption from the limits", () => {
    const text = (r: Reason) => reasonText(r, TEST_LIMITS);
    expect(text({ kind: "precheck", code: "unsupported_type", values: {} })).toBe(
      "This is not a JPEG, PNG or WebP image, or a MP4 or MOV video.",
    );
    expect(text({ kind: "precheck", code: "too_large", values: { size: 1310 * MIB, kind: "video" } })).toBe("Videos can be up to 1024 MB; this one is 1310 MB.");
    expect(text({ kind: "precheck", code: "too_large", values: { size: 21 * MIB, kind: "image" } })).toBe("Images can be up to 20 MB; this one is 21 MB.");
    expect(text({ kind: "precheck", code: "too_long", values: { seconds: 1200 } })).toBe("Videos can be up to 15 minutes; this one is 20 minutes.");
    expect(text({ kind: "precheck", code: "too_big", values: { side: 7680 } })).toBe("Videos can be up to 4096 px on a side; this one is 7680 px.");
    expect(text({ kind: "docket", message: "x" })).toBe("Docket refused it: x");
    expect(text({ kind: "access" })).toBe("You no longer have access to this project");
    expect(text({ kind: "storage" })).toBe("Storage refused the upload");
    expect(text({ kind: "parts_missing" })).toBe("Some parts did not arrive. Retry to send them.");
    expect(text({ kind: "deleted" })).toBe("This item was deleted.");
  });

  it("announces each event with the file name", () => {
    const say = (e: EngineEvent<unknown>) => announcementFor(e, TEST_LIMITS);
    expect(say({ type: "started", id: "1", name: "a.mp4" })).toBe("a.mp4: upload started");
    expect(say({ type: "milestone", id: "1", name: "a.mp4", pct: 25 })).toBe("a.mp4: 25 percent uploaded");
    expect(say({ type: "uploaded", id: "1", name: "a.mp4", asset: {} })).toBe("a.mp4: uploaded");
    expect(say({ type: "interrupted", id: "1", name: "a.mp4", reason: { kind: "network" } })).toBe(
      "a.mp4: upload interrupted, the connection was lost",
    );
    expect(say({ type: "refused", id: "1", name: "a.mp4", reason: { kind: "precheck", code: "no_video", values: {} } })).toBe(
      "a.mp4: not uploaded, This file has no video.",
    );
    expect(say({ type: "ready", id: "1", name: "a.mp4", asset: null })).toBe("a.mp4: ready");
    expect(say({ type: "failed", id: "1", name: "a.mp4", reason: { kind: "deleted" } })).toBe("a.mp4: failed, This item was deleted.");
  });
});

describe("limitsIdentity", () => {
  it("is equal for equal limits in a new object, so the engine is not rebuilt", async () => {
    const { limitsIdentity } = await import("./upload-ui");
    const { TEST_LIMITS } = await import("@/lib/upload/test-support");
    expect(limitsIdentity({ ...TEST_LIMITS })).toBe(limitsIdentity(TEST_LIMITS));
    expect(limitsIdentity({ ...TEST_LIMITS, maxVideoBytes: 1 })).not.toBe(limitsIdentity(TEST_LIMITS));
  });
});
