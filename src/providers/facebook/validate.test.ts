import { describe, expect, it } from "vitest";
import { facebookCapabilities as caps, FACEBOOK_MAX_IMAGES, FACEBOOK_MAX_TEXT } from "./capabilities";
import { validateFacebook } from "./validate";
import type { MediaItem, PostType, VideoFacts } from "../types";

const img = (): MediaItem => ({ url: "https://m.test/a.jpg", mimeType: "image/jpeg", width: 1000, height: 1000, bytes: 1000, altText: "a" });
const run = (text: string, n = 0) => validateFacebook({ text, media: Array.from({ length: n }, img) }, caps);
const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe("validateFacebook", () => {
  it("allows a text-only post", () => {
    expect(run("hello")).toEqual([]);
  });

  it("allows the maximum number of images and rejects one more", () => {
    expect(codes(run("x", FACEBOOK_MAX_IMAGES))).not.toContain("too_many_images");
    const over = run("x", FACEBOOK_MAX_IMAGES + 1).find((i) => i.code === "too_many_images");
    expect(over).toMatchObject({ severity: "error", count: FACEBOOK_MAX_IMAGES + 1, limit: FACEBOOK_MAX_IMAGES });
  });

  it("counts text in code points at the limit", () => {
    expect(codes(run("😀".repeat(FACEBOOK_MAX_TEXT)))).not.toContain("text_too_long");
    const over = run("😀".repeat(FACEBOOK_MAX_TEXT + 1)).find((i) => i.code === "text_too_long");
    expect(over).toMatchObject({ count: FACEBOOK_MAX_TEXT + 1, limit: FACEBOOK_MAX_TEXT });
  });

  describe("video", () => {
    const vid = (facts: Partial<VideoFacts> = {}, over: Partial<MediaItem> = {}): MediaItem => ({
      url: "https://m.test/a.mp4",
      mimeType: "video/mp4",
      kind: "video",
      width: 1080,
      height: 1920,
      bytes: 1_000_000,
      altText: "",
      video: { container: "mp4", videoCodec: "h264", audioCodec: "aac", durationSeconds: 10, frameRate: 30, ...facts },
      ...over,
    });
    const runT = (media: MediaItem[], postType?: PostType) => validateFacebook({ text: "x", media, postType }, caps);
    const errors = (issues: { severity: string }[]) => issues.filter((i) => i.severity === "error");
    const msg = (issues: { code: string; message: string }[], code: string) => issues.find((i) => i.code === code)?.message;

    it("uses one rule for two videos or a video with images", () => {
      const rule = "A Facebook post can carry one video and no images.";
      expect(msg(runT([vid(), vid()], "reel"), "too_many_videos")).toBe(rule);
      expect(msg(runT([vid(), img()], "video"), "video_with_images")).toBe(rule);
    });

    it("words a Reel aspect refusal and suggests a Page video when one would take the file", () => {
      const m = msg(runT([vid({}, { width: 1920, height: 1080 })], "reel"), "video_aspect_out_of_range");
      expect(m).toContain("Facebook Reels must be 9:16 (vertical). Docket does not crop video yet.");
      expect(m).toMatch(/^Video 1 is [^;]+; Facebook Reels/);
      expect(m?.endsWith(" Post it as a Page video instead.")).toBe(true);
    });

    it("words an audio refusal like the other Reel video rules", () => {
      const m = msg(runT([vid({ audioCodec: "mp3" as never })], "reel"), "audio_codec_not_allowed");
      expect(m).toContain("for a Facebook Reel. Docket does not crop, trim or convert video yet.");
      expect(m?.endsWith(" Post it as a Page video instead.")).toBe(true);
    });

    it("names the type for other video rules, with the suggestion present and absent", () => {
      const short = msg(runT([vid({ durationSeconds: 2 })], "reel"), "video_too_short");
      expect(short).toContain("for a Facebook Reel. Docket does not crop, trim or convert video yet.");
      expect(short?.endsWith(" Post it as a Page video instead.")).toBe(true);
      // Refused by the Page video route too (a container it does not allow): no suggestion.
      const wide = runT([vid({ container: "avi" as never })], "reel");
      const big = msg(wide, "video_container_not_allowed");
      expect(big).toContain("for a Facebook Reel.");
      expect(big).not.toContain("Post it as a Page video");
      const page = msg(runT([vid({ container: "avi" as never })], "video"), "video_container_not_allowed");
      expect(page).toContain("for a Facebook Page video.");
    });

    it("accepts a 1,080 x 1,918 Reel and the inclusive bounds", () => {
      expect(errors(runT([vid({}, { width: 1080, height: 1918 })], "reel"))).toEqual([]);
      expect(errors(runT([vid({ durationSeconds: 3 })], "reel"))).toEqual([]);
      expect(errors(runT([vid({ durationSeconds: 90 })], "reel"))).toEqual([]);
      expect(errors(runT([vid({}, { width: 540, height: 960 })], "reel"))).toEqual([]);
      expect(errors(runT([vid({ frameRate: 24 })], "reel"))).toEqual([]);
      expect(errors(runT([vid({ frameRate: 60 })], "reel"))).toEqual([]);
      expect(errors(runT([vid({}, { width: 556, height: 1000 })], "reel"))).toEqual([]);
      expect(errors(runT([vid({}, { width: 569, height: 1000 })], "reel"))).toEqual([]);
    });

    it("does not refuse an unknown frame rate", () => {
      expect(codes(runT([vid({ frameRate: null })], "reel"))).not.toContain("video_frame_rate_too_low");
    });
  });
});
