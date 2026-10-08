import { describe, expect, it } from "vitest";
import { docsUrl } from "@/lib/docs";
import { THREADS_VIDEO } from "./capabilities";
import { THREADS_VIDEO_ERROR_CODES, VIDEO_CEILING_TEXT, videoErrorExplanation, videoErrorText } from "./video-errors";

const TAIL = "Nothing was published; retry the post after fixing the video.";

describe("videoErrorExplanation", () => {
  it("explains every documented code alone and inside a sentence", () => {
    for (const code of THREADS_VIDEO_ERROR_CODES) {
      const alone = videoErrorExplanation(code);
      expect(alone, code).not.toBeNull();
      expect(videoErrorExplanation(`Upload failed: ${code}. Try later.`)).toBe(alone);
    }
  });

  it("matches only the whole, exact-case token", () => {
    expect(videoErrorExplanation("INVALID_ASPECT_RATIO")).toBeNull();
    expect(videoErrorExplanation("invalid_duration")).toBeNull();
    expect(videoErrorExplanation("NOT_INVALID_DURATION_AT_ALL")).toBeNull();
    expect(videoErrorExplanation("something else")).toBeNull();
    expect(videoErrorExplanation("")).toBeNull();
  });

  it("takes figures from the declaration", () => {
    expect(videoErrorExplanation("INVALID_DURATION")).toBe(`Threads videos can be at most ${THREADS_VIDEO.maxDurationSeconds} seconds.`);
    expect(videoErrorExplanation("INVALID_FRAME_RATE")).toBe("Threads videos must be 23 to 60 frames per second.");
    expect(videoErrorExplanation("INVALID_ASPEC_RATIO")).toBe("Threads videos must have an aspect ratio between 1:100 and 10:1.");
    expect(videoErrorExplanation("FAILED_DOWNLOADING_VIDEO")).toContain(docsUrl("storage"));
  });
});

describe("videoErrorText", () => {
  it("builds the three places", () => {
    expect(videoErrorText({ kind: "single" }, "INVALID_DURATION.")).toBe(
      `Threads could not process the video: INVALID_DURATION. Threads videos can be at most 300 seconds. ${TAIL}`,
    );
    expect(videoErrorText({ kind: "item", position: 2 }, "FAILED_PROCESSING_VIDEO")).toMatch(
      /^Threads could not process the video in item 2 of the carousel: FAILED_PROCESSING_VIDEO\. Threads could not process the file/,
    );
    expect(videoErrorText({ kind: "carousel" }, "odd")).toBe(`Threads could not process the video carousel: odd. ${TAIL}`);
  });

  it("has no colon for an empty message", () => {
    expect(videoErrorText({ kind: "single" }, "")).toBe(`Threads could not process the video (status ERROR). ${TAIL}`);
    expect(videoErrorText({ kind: "single" }, "  ")).not.toContain(":");
  });

  it("states the 60-minute ceiling", () => {
    expect(VIDEO_CEILING_TEXT).toContain("within 60 minutes");
  });
});
