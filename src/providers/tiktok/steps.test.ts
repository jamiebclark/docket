import { describe, expect, it } from "vitest";
import type { StepContent } from "../types";
import { tiktokStepFor } from "./steps";

const video: StepContent = { text: "t", mediaCount: 1, videoCount: 1, postType: "video" };
const photos: StepContent = { text: "t", mediaCount: 2, postType: "carousel" };
const sentAt = "2026-01-01T00:00:00.000Z";
const base = { v: 1, restarts: 0 };
const chunks = {
  ...base, kind: "video", phase: "chunks", nickname: "A", fileUrl: "https://m.test/v.mp4", fileBytes: 20_000_000,
  chunkSize: 5_242_880, chunkCount: 3, publishId: "p", sealedUploadUrl: "a.b.c", uploadIssuedAt: sentAt,
};

describe("tiktokStepFor (data-model §6)", () => {
  it("starts at the creator check", () => {
    expect(tiktokStepFor(null, {}, video)).toEqual({ name: "check_creator", mayPublish: false });
    expect(tiktokStepFor({ ...base, kind: "video", phase: "creator" }, {}, video)).toEqual({ name: "check_creator", mayPublish: false });
  });
  it("video: start, then one chunk per step, only the last may publish", () => {
    expect(tiktokStepFor({ ...base, kind: "video", phase: "start", nickname: "A" }, {}, video)).toEqual({ name: "start_upload", mayPublish: false });
    expect(tiktokStepFor({ ...chunks, chunksSent: 0 }, {}, video)).toEqual({ name: "upload_chunk_1", mayPublish: false });
    expect(tiktokStepFor({ ...chunks, chunksSent: 1 }, {}, video)).toEqual({ name: "upload_chunk_2", mayPublish: false });
    expect(tiktokStepFor({ ...chunks, chunksSent: 2 }, {}, video)).toEqual({ name: "upload_chunk_3", mayPublish: true });
  });
  it("photo: the post request publishes", () => {
    expect(tiktokStepFor({ ...base, kind: "photo", phase: "start", nickname: "A" }, {}, photos)).toEqual({ name: "publish_photos", mayPublish: true });
  });
  it("status checks follow publishing", () => {
    const status = { ...base, kind: "video", phase: "status", publishId: "p", sentAt };
    expect(tiktokStepFor(status, {}, video)).toEqual({ name: "check_status", mayPublish: false, afterPublish: true });
    expect(tiktokStepFor(status, {}, photos)).toEqual({ name: "check_status", mayPublish: false, afterPublish: true });
  });
  it("a state of the wrong kind starts over", () => {
    expect(tiktokStepFor({ ...base, kind: "photo", phase: "start", nickname: "A" }, {}, video)).toEqual({ name: "check_creator", mayPublish: false });
  });
  it("an unreadable state with a publish id and a send time checks status", () => {
    expect(tiktokStepFor({ publishId: "p", sentAt, phase: "bogus" }, {}, video)).toMatchObject({ name: "check_status", afterPublish: true });
  });
  it("any other unreadable state restarts", () => {
    for (const bad of ["x", 5, {}, { ...chunks, chunksSent: 9 }, { v: 2 }]) {
      expect(tiktokStepFor(bad, {}, video)).toEqual({ name: "check_creator", mayPublish: false });
    }
  });
});
