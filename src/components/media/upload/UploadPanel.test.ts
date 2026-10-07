import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/app/p/[projectSlug]/media/upload-actions", () => ({}));

import type { RowState, UploadRowState } from "@/lib/upload/engine";
import { TEST_LIMITS } from "@/lib/upload/test-support";
import { UploadPanelView } from "./UploadPanel";

const row = (state: RowState, over: Partial<UploadRowState> = {}): UploadRowState => ({
  id: state,
  name: `${state}.mp4`,
  state,
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

const noop = () => {};
const render = (rows: UploadRowState[]) =>
  renderToStaticMarkup(
    createElement(UploadPanelView, {
      limits: TEST_LIMITS,
      rows,
      announcement: "",
      actions: { onRetry: noop, onCancel: noop, onDismiss: noop },
    }),
  );

describe("UploadPanelView", () => {
  it("shows an uploading row as a labelled progressbar with the text beside it", () => {
    const html = render([row("uploading", { bytesSent: 12_500_000 })]);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-label="Uploading uploading.mp4"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="400000000"');
    expect(html).toContain('aria-valuenow="12500000"');
    expect(html).toContain('aria-valuetext="12.5 MB of 400 MB, 3 percent"');
    expect(html).toContain("12.5 MB of 400 MB (3 %)</span>");
    expect(html).toContain('aria-label="Cancel uploading.mp4"');
  });

  it("gives each state its controls, every button naming its file", () => {
    const buttons = (state: RowState) => [...render([row(state)]).matchAll(/aria-label="((?:Retry|Cancel|Dismiss)[^"]*)"/g)].map((m) => m[1]);
    expect(buttons("checking")).toEqual(["Cancel checking.mp4"]);
    expect(buttons("waiting")).toEqual(["Cancel waiting.mp4"]);
    expect(buttons("uploading")).toEqual(["Cancel uploading.mp4"]);
    expect(buttons("interrupted")).toEqual(["Retry interrupted.mp4", "Cancel interrupted.mp4"]);
    for (const s of ["refused", "cancelled", "failed"] as const) expect(buttons(s)).toEqual([`Dismiss ${s}.mp4`]);
    for (const s of ["processing", "ready"] as const) expect(buttons(s)).toEqual([]);
  });

  it("puts the text of each state on its row", () => {
    expect(render([row("checking")])).toContain("Checking…");
    expect(render([row("refused", { reason: { kind: "precheck", code: "no_video", values: {} } })])).toContain("Not uploaded: This file has no video.");
    expect(render([row("interrupted", { reason: { kind: "network" } })])).toContain("Upload interrupted: the connection was lost");
    expect(render([row("processing", { step: "probing" })])).toContain("Processing: reading the video");
    expect(render([row("ready")])).toContain("Ready");
    expect(render([row("uploading", { checksAfterUpload: true })])).toContain("Checks happen after upload");
  });

  it("has one live region, the file input labelled, and the help text", () => {
    const html = render([row("waiting"), row("ready")]);
    expect(html.match(/aria-live="polite"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Image or video files"');
    expect(html).toContain('accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime"');
    expect(html).toContain("Drop files here or choose them.");
  });
});
