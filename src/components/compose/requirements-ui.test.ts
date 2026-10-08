import { describe, expect, it } from "vitest";
import { UPLOAD_MIME_TYPES } from "@/lib/media/types";
import { findProvider } from "@/providers/registry";
import { requirementsOf, type RequirementsSummary } from "@/providers/requirements";
import { carouselLine, conversionText, detailRows, rangeText, summaryLine, videoLine } from "./requirements-ui";

const of = (key: string): RequirementsSummary => requirementsOf(findProvider(key)!.capabilities, { uploadTypes: UPLOAD_MIME_TYPES });
const row = (r: RequirementsSummary, term: string) => detailRows(r).find((d) => d.term === term)?.detail;

describe("summaryLine", () => {
  it("shows text, images and formats", () => {
    expect(summaryLine(of("instagram"))).toBe("2,200 characters · up to 10 images · JPEG");
    expect(summaryLine(of("bluesky"))).toBe("300 graphemes · up to 4 images · JPEG, PNG");
  });
  it('says "no images" when none are accepted', () => {
    const r = of("bluesky");
    expect(summaryLine({ ...r, image: { ...r.image, maxImages: 0 } })).toBe("300 graphemes · no images");
  });
});

describe("detailRows", () => {
  it("lists every Instagram field", () => {
    const r = of("instagram");
    expect(row(r, "Text")).toBe("2,200 characters (code points)");
    expect(row(r, "Hashtags")).toBe("up to 30");
    expect(row(r, "Mentions")).toBe("up to 20");
    expect(row(r, "Images")).toBe("up to 10");
    expect(row(r, "Maximum file size")).toBe("8 MB");
    expect(row(r, "Width")).toBe("320 px – 1440 px");
    expect(row(r, "Aspect ratio")).toBe("4:5 – 1.91:1");
    expect(row(r, "Alt text")).toBe("up to 1,000 characters");
    expect(row(r, "Image required")).toBe("yes");
    expect(row(r, "Text-only posts")).toBe("not allowed");
  });
  it("omits hashtag and mention rows when not checked", () => {
    expect(row(of("facebook"), "Hashtags")).toBeUndefined();
    expect(row(of("facebook"), "Mentions")).toBeUndefined();
  });
  it('says "No limit checked" and "No limit documented" for null', () => {
    const r = of("bluesky");
    expect(row(r, "Width")).toBe("No limit checked");
    expect(row(r, "Height")).toBe("No limit checked");
    expect(row(r, "Aspect ratio")).toBe("No limit checked");
    expect(row(r, "Alt text")).toBe("No limit documented");
    expect(row(r, "Text-only posts")).toBe("allowed");
  });
  it("puts the conversion sentence with the formats", () => {
    expect(row(of("instagram"), "Formats")).toBe("JPEG. PNG and WebP uploads are converted to JPEG");
    expect(row(of("x"), "Formats")).toBe("JPEG, PNG, WebP");
  });
});

describe("counting rule name", () => {
  it("shows the rule next to the unit, and omits it when it only repeats the unit", () => {
    expect(row(of("instagram"), "Text")).toBe("2,200 characters (code points)");
    expect(row(of("bluesky"), "Text")).toBe("300 graphemes");
    expect(row(of("threads"), "Text")).toBe("500 characters (threads)");
    expect(row(of("x"), "Text")).toBe("280 characters (x-weighted)");
  });
});

describe("conversionText / rangeText", () => {
  it("words the conversion, or returns null when none", () => {
    expect(conversionText(of("facebook"))).toBe("WebP uploads are converted to JPEG");
    expect(conversionText(of("x"))).toBeNull();
  });
  it("words one-sided ranges", () => {
    expect(rangeText({ min: { value: 5, label: "5 px" }, max: null })).toBe("at least 5 px");
    expect(rangeText({ min: null, max: { value: 9, label: "9 px" } })).toBe("at most 9 px");
  });
});

describe("videoLine and the video rows", () => {
  it("says video is not accepted yet", () => {
    expect(videoLine(of("facebook"))).toBe("Video: not accepted yet");
    expect(row(of("facebook"), "Video")).toBe("not accepted yet");
    expect(row(of("facebook"), "Video width")).toBeUndefined();
  });
  it("describes the mock's limits and marks undeclared ones", () => {
    const r = of("mock");
    expect(videoLine(r)).toBe(
      "Video: 1 video per post, MP4, MOV, H.264, up to 50 MB, 1 second – 1 minute, aspect 9:16 – 16:9, up to 60 fps, not with images",
    );
    expect(row(r, "Video containers")).toBe("MP4, MOV");
    expect(row(r, "Video width")).toBe("no limit Docket checks");
    expect(row(r, "Video frame rate")).toBe("up to 60 fps");
  });
});

describe("Instagram video summary", () => {
  const ig = (postType?: "video" | "reel" | "carousel") =>
    requirementsOf(findProvider("instagram")!.capabilities, { uploadTypes: UPLOAD_MIME_TYPES, postType });

  it("prefixes the chosen type, shows the frame-rate range and the placement", () => {
    expect(videoLine(ig("reel"))).toBe(
      "Reel: 1 video per post, MP4, MOV, H.264, HEVC, up to 300 MB, 3 seconds – 15 minutes, aspect 1:100 – 10:1, 23 fps – 60 fps, not with images, Shown in the Reels tab only",
    );
    expect(videoLine(ig())).toMatch(/^Feed video: /);
  });

  it("lists the post type, frame rate and carousel rows", () => {
    const r = ig("reel");
    expect(row(r, "Post as")).toBe("Reel. Shown in the Reels tab only.");
    expect(row(r, "Video frame rate")).toBe("23 fps – 60 fps");
    expect(row(r, "Carousel items")).toBe("up to 10; images and videos may be mixed");
    expect(row(r, "Carousel video aspect ratio")).toBe("4:5 – 1.91:1");
    expect(detailRows(r).filter((d) => d.term === "Note").map((d) => d.detail)).toEqual(["Reels cannot be carousel items."]);
  });

  it("describes the carousel, and has none for other providers", () => {
    expect(carouselLine(ig())).toBe(
      "Carousel: up to 10 items; images and videos may be mixed; video items 4:5 – 1.91:1; Reels cannot be carousel items.",
    );
    expect(carouselLine(of("mock"))).toBeNull();
  });
});
