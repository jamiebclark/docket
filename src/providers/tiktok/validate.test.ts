import { describe, expect, it } from "vitest";
import type { MediaItem, PostContent, PostType } from "../types";
import { tiktokCapabilities } from "./capabilities";
import type { CreatorDetails } from "./creator";
import { DEFAULT_POSTING_VALUES, type TikTokPostingValues } from "./posting";
import { validateTikTok } from "./validate";

const details: CreatorDetails = {
  v: 1,
  nickname: "Ada",
  username: "ada",
  privacyOptions: ["PUBLIC_TO_EVERYONE", "FOLLOWER_OF_CREATOR", "SELF_ONLY"],
  commentDisabled: false,
  duetDisabled: false,
  stitchDisabled: false,
  maxVideoSeconds: 60,
};
const photo = (url = "https://media.example/a.jpg"): MediaItem => ({ url, mimeType: "image/jpeg", width: 1000, height: 1500, bytes: 1000, altText: "" });
const video = (seconds = 30): MediaItem => ({
  url: "https://media.example/v.mp4",
  mimeType: "video/mp4",
  width: 1080,
  height: 1920,
  bytes: 1_000_000,
  altText: "",
  kind: "video",
  status: "ready",
  video: { container: "mp4", durationSeconds: seconds, frameRate: 30, videoCodec: "h264", audioCodec: "aac" },
});
const vals = (over: Partial<TikTokPostingValues> = {}): TikTokPostingValues => ({ ...DEFAULT_POSTING_VALUES, privacy: "PUBLIC_TO_EVERYONE", ...over });

function run(over: { values?: unknown; details?: CreatorDetails | null; media?: MediaItem[]; postType?: PostType; audited?: boolean; text?: string }) {
  const postType = over.postType ?? "image";
  const content: PostContent = {
    text: over.text ?? "hi",
    media: over.media ?? (postType === "video" ? [video()] : [photo()]),
    postType,
    posting: { values: "values" in over ? over.values : vals(), details: "details" in over ? over.details : details },
  };
  return validateTikTok(content, tiktokCapabilities, over.audited ?? true);
}
const msg = (r: ReturnType<typeof run>, code: string) => r.find((i) => i.code === code)?.message;
const codes = (r: ReturnType<typeof run>) => r.filter((i) => i.severity === "error").map((i) => `${i.code}@${i.field}`);

describe("validateTikTok (contracts/tiktok-publishing.md §2)", () => {
  it("accepts a complete audited post", () => {
    expect(codes(run({}))).toEqual([]);
  });

  it("requires the posting values", () => {
    expect(codes(run({ values: null }))).toEqual(["posting_required@posting"]);
    expect(codes(run({ values: { v: 9 } }))).toEqual(["posting_required@posting"]);
  });

  it("requires a privacy choice", () => {
    expect(codes(run({ values: vals({ privacy: null }) }))).toEqual(["privacy_required@posting.privacy"]);
  });

  it("refuses a non-private choice on an unaudited install", () => {
    expect(codes(run({ audited: false }))).toEqual(["privacy_not_private@posting.privacy"]);
    expect(codes(run({ audited: false, values: vals({ privacy: "SELF_ONLY" }) }))).toEqual([]);
  });

  it("refuses a privacy level the creator is not offered", () => {
    const r = run({ values: vals({ privacy: "MUTUAL_FOLLOW_FRIENDS" }) });
    expect(codes(r)).toEqual(["privacy_not_offered@posting.privacy"]);
    expect(msg(r, "privacy_not_offered")).toBe("TikTok doesn't offer 'Friends (mutual followers)' for Ada. Choose again.");
  });

  it("refuses an unaudited account that cannot post privately", () => {
    const r = run({ audited: false, values: vals({ privacy: "SELF_ONLY" }), details: { ...details, privacyOptions: ["PUBLIC_TO_EVERYONE"] } });
    expect(codes(r)).toEqual(["private_not_offered@posting.privacy"]);
    expect(msg(r, "private_not_offered")).toContain("Ada can't post through this app");
  });

  it("refuses private branded content", () => {
    expect(codes(run({ values: vals({ privacy: "SELF_ONLY", disclosure: true, brandedContent: true }) }))).toEqual(["branded_private@posting.privacy"]);
  });

  it("needs a choice when disclosing commercial content", () => {
    expect(codes(run({ values: vals({ disclosure: true }) }))).toEqual(["disclosure_incomplete@posting.disclosure"]);
    expect(codes(run({ values: vals({ disclosure: true, yourBrand: true }) }))).toEqual([]);
  });

  it("refuses an interaction the creator turned off, naming the account", () => {
    const off = { ...details, commentDisabled: true, duetDisabled: true, stitchDisabled: true };
    const on = vals({ allowComments: true, allowDuets: true, allowStitches: true });
    expect(codes(run({ values: on, details: off, postType: "video" }))).toEqual([
      "interaction_disabled@posting.allowComments",
      "interaction_disabled@posting.allowDuets",
      "interaction_disabled@posting.allowStitches",
    ]);
    // Duets and stitches do not apply to photos.
    expect(codes(run({ values: on, details: off, postType: "image" }))).toEqual(["interaction_disabled@posting.allowComments"]);
    expect(msg(run({ values: on, details: off, postType: "image" }), "interaction_disabled")).toBe("Ada has turned off comments on TikTok.");
  });

  it("falls back to a generic name when details are missing", () => {
    expect(msg(run({ details: null, values: vals({ privacy: "SELF_ONLY", disclosure: true, brandedContent: true }) }), "branded_private")).toBe("Branded content can't be private.");
    expect(msg(run({ details: { ...details, nickname: "", username: "", commentDisabled: true }, values: vals({ allowComments: true }) }), "interaction_disabled")).toBe(
      "this TikTok account has turned off comments on TikTok.",
    );
  });

  it("limits the photo title to 90 UTF-16 units, and not for a video", () => {
    const long = "a".repeat(91);
    const r = run({ values: vals({ photoTitle: long }) });
    expect(codes(r)).toEqual(["photo_title_too_long@posting.photoTitle"]);
    expect(msg(r, "photo_title_too_long")).toBe("The photo title is 91 UTF-16 units; TikTok allows 90.");
    expect(codes(run({ values: vals({ photoTitle: "a".repeat(90) }) }))).toEqual([]);
    expect(codes(run({ values: vals({ photoTitle: long }), postType: "video" }))).toEqual([]);
  });

  it("refuses a video longer than the creator's maximum, at the video's position", () => {
    const r = run({ postType: "video", media: [video(61)] });
    expect(codes(r)).toEqual(["creator_duration_exceeded@media.0"]);
    expect(msg(r, "creator_duration_exceeded")).toBe("This TikTok account can post videos up to 60 seconds.");
    expect(codes(run({ postType: "video", media: [video(60)] }))).toEqual([]);
    expect(codes(run({ postType: "video", media: [video(61)], details: { ...details, maxVideoSeconds: null } }))).toEqual([]);
    expect(codes(run({ postType: "video", media: [video(61)], details: null }))).toEqual([]);
  });

  it("refuses photo addresses that are not https", () => {
    expect(codes(run({ media: [photo("http://media.example/a.jpg")] }))).toEqual(["photo_url_not_https@media"]);
    expect(codes(run({ postType: "video", media: [{ ...video(), url: "http://media.example/v.mp4" }] }))).toEqual([]);
  });

  it("words a video with images and two videos in TikTok's terms", () => {
    const mixed = validateTikTok({ text: "hi", media: [video(), photo()], postType: "video" }, tiktokCapabilities, true);
    expect(mixed.find((i) => i.code === "video_with_images")?.message).toBe("TikTok posts a video on its own, without images.");
    const two = validateTikTok({ text: "hi", media: [video(), video()], postType: "video" }, tiktokCapabilities, true);
    expect(two.find((i) => i.code === "too_many_videos")?.message).toBe("TikTok takes one video per post.");
  });

  it("keeps the shared capability checks", () => {
    expect(run({ text: "x".repeat(2201) }).some((i) => i.code === "text_too_long")).toBe(true);
  });
});
