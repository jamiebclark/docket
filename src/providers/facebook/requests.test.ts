import { describe, expect, it } from "vitest";
import {
  checkUploadUrl,
  pageVideoParams,
  publishState,
  readReelStatus,
  reelFinishParams,
  reelStartParams,
  ruploadHeaders,
  uploadState,
} from "./requests";

describe("param builders", () => {
  it("builds the Page video request, with the description only when there is text", () => {
    expect(pageVideoParams({ url: "https://m/v.mp4" }, "hi")).toEqual({ file_url: "https://m/v.mp4", description: "hi" });
    expect(pageVideoParams({ url: "https://m/v.mp4" }, "")).toEqual({ file_url: "https://m/v.mp4" });
  });
  it("builds start and finish", () => {
    expect(reelStartParams()).toEqual({ upload_phase: "start" });
    expect(reelFinishParams("55", "cap")).toEqual({ upload_phase: "finish", video_id: "55", video_state: "PUBLISHED", description: "cap" });
    expect(reelFinishParams("55", "")).not.toHaveProperty("description");
  });
  it("sends only file_url as a header, never the token", () => {
    expect(ruploadHeaders("https://m/v.mp4")).toEqual({ file_url: "https://m/v.mp4" });
  });
});

describe("checkUploadUrl", () => {
  const ok = "https://rupload.facebook.com/video-upload/123";
  it("accepts the exact address, and a versioned one", () => {
    expect(checkUploadUrl(ok, "123")?.href).toBe(ok);
    expect(checkUploadUrl("https://rupload.facebook.com/video-upload/v21.0/123", "123")).not.toBeNull();
  });
  it("refuses a wrong host, http, a port, user info, a query and a fragment", () => {
    for (const bad of [
      "https://evil.example/video-upload/123",
      "https://rupload.facebook.com.evil.example/video-upload/123",
      "http://rupload.facebook.com/video-upload/123",
      "https://rupload.facebook.com:8443/video-upload/123",
      "https://user:pw@rupload.facebook.com/video-upload/123",
      "https://rupload.facebook.com/video-upload/123?x=1",
      "https://rupload.facebook.com/video-upload/123#f",
    ]) expect(checkUploadUrl(bad, "123"), bad).toBeNull();
  });
  it("refuses a foreign path and a mismatched id", () => {
    expect(checkUploadUrl("https://rupload.facebook.com/other/123", "123")).toBeNull();
    expect(checkUploadUrl("https://rupload.facebook.com/video-upload/123/extra", "123")).toBeNull();
    expect(checkUploadUrl(ok, "124")).toBeNull();
  });
  it("refuses junk, and honours a replaced host", () => {
    expect(checkUploadUrl("not a url", "123")).toBeNull();
    expect(checkUploadUrl(undefined, "123")).toBeNull();
    expect(checkUploadUrl("https://up.test/video-upload/123", "123", "up.test")).not.toBeNull();
    expect(checkUploadUrl(ok, "123", "up.test")).toBeNull();
  });
});

const status = (s: unknown) => readReelStatus({ status: s });

describe("readReelStatus", () => {
  it("reads every phase, lower-cased", () => {
    expect(
      status({
        video_status: "READY",
        uploading_phase: { status: "Complete" },
        processing_phase: { status: "complete" },
        publishing_phase: { status: "complete", publish_status: "PUBLISHED" },
      }),
    ).toEqual({ videoStatus: "ready", uploading: "complete", processing: "complete", publishing: "complete", publishStatus: "published", detail: null });
  });
  it("reads unexpected shapes as all null", () => {
    for (const body of [null, undefined, "x", 5, [], {}, { status: "ready" }, { status: [] }, { status: { video_status: 3 } }]) {
      expect(readReelStatus(body)).toEqual({ videoStatus: null, uploading: null, processing: null, publishing: null, publishStatus: null, detail: null });
    }
  });
  it("takes the first error message, cleaned and capped", () => {
    const r = status({ processing_phase: { status: "error", errors: [{ code: 1 }, { message: `bad\nvideo${"x".repeat(400)}` }] } });
    expect(r.detail).toMatch(/^bad video/);
    expect(r.detail).toHaveLength(300);
  });
});

describe("classifiers", () => {
  const up = (s: unknown) => uploadState(readReelStatus({ status: s }));
  const pub = (s: unknown) => publishState(readReelStatus({ status: s }));

  it("uploadState: complete for upload_complete, processing and ready, or a complete phase", () => {
    for (const v of ["upload_complete", "processing", "ready"]) expect(up({ video_status: v })).toBe("complete");
    expect(up({ uploading_phase: { status: "complete" } })).toBe("complete");
  });
  it("uploadState: failed for error states, pending for anything else", () => {
    for (const v of ["error", "upload_failed", "expired"]) expect(up({ video_status: v })).toBe("failed");
    expect(up({ uploading_phase: { status: "error" } })).toBe("failed");
    for (const s of [{ video_status: "uploading" }, { video_status: "mystery" }, {}, null]) expect(up(s)).toBe("pending");
  });
  it("publishState: published only when ready and the publishing phase agrees", () => {
    expect(pub({ video_status: "ready", publishing_phase: { status: "complete" } })).toBe("published");
    expect(pub({ video_status: "ready", publishing_phase: { publish_status: "published" } })).toBe("published");
    expect(pub({ video_status: "ready" })).toBe("pending");
    expect(pub({ publishing_phase: { status: "complete" } })).toBe("pending");
  });
  it("publishState: failed for error states, pending for the rest", () => {
    for (const s of [{ video_status: "error" }, { video_status: "expired" }, { processing_phase: { status: "error" } }, { publishing_phase: { status: "error" } }]) expect(pub(s)).toBe("failed");
    for (const s of [{ video_status: "processing" }, { video_status: "weird" }, {}, "x"]) expect(pub(s)).toBe("pending");
  });
});
