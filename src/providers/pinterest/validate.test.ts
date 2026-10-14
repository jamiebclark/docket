import { describe, expect, it } from "vitest";
import type { MediaItem, PostContent } from "../types";
import { PINTEREST_LINK_MAX, PINTEREST_TITLE_MAX } from "./posting";
import { pinterestCapabilities } from "./capabilities";
import { validatePinterest } from "./validate";

const image = (over: Partial<MediaItem> = {}): MediaItem => ({
  url: "https://cdn.example.com/a.jpg",
  mimeType: "image/jpeg",
  width: 1000,
  height: 1500,
  bytes: 1000,
  altText: "",
  ...over,
});

const content = (over: Partial<PostContent> = {}): PostContent => ({
  text: "hello",
  media: [image()],
  posting: { values: { v: 1, boardId: "b1", boardName: "Recipes", title: "", link: "" }, details: { v: 1, boards: [{ id: "b1", name: "Recipes" }], truncated: false } },
  ...over,
});

const codes = (c: PostContent) => validatePinterest(c, pinterestCapabilities).map((i) => i.code);
const issueFor = (c: PostContent, code: string) => validatePinterest(c, pinterestCapabilities).find((i) => i.code === code);

describe("re-worded capability messages", () => {
  it("text_too_long names the pin's description", () => {
    const c = content({ text: "x".repeat(801) });
    expect(issueFor(c, "text_too_long")?.message).toMatch(/pin's description: 801 characters; Pinterest allows 800\./);
  });

  it("text_only_not_allowed explains there is no text-only pin", () => {
    expect(issueFor(content({ media: [] }), "text_only_not_allowed")?.message).toBe("Pinterest needs one image: there is no text-only pin.");
  });

  it("too_many_images names the Pinterest rule", () => {
    const c = content({ media: [image(), image()] });
    expect(issueFor(c, "too_many_images")?.message).toBe("This post has 2 images; a Pinterest pin takes exactly one.");
  });

  it("unsupported_post_type names carousels as not yet supported", () => {
    const c = content({ media: [image(), image(), image()] });
    expect(issueFor(c, "unsupported_post_type")?.message).toBe("Pinterest takes one image per pin; carousels are not supported yet.");
  });

  it("video_not_accepted keeps the generic cross-provider message (matches facebook/instagram/threads)", () => {
    const videoItem: MediaItem = { ...image(), kind: "video", video: { durationSeconds: 5, container: "mp4", videoCodec: "h264", audioCodec: "aac" } as never };
    const c = content({ media: [videoItem] });
    expect(issueFor(c, "video_not_accepted")?.message).toBe("This account does not accept video yet.");
  });
});

describe("posting rules", () => {
  it("posting_required when posting.values is missing", () => {
    expect(codes(content({ posting: { values: null, details: null } }))).toContain("posting_required");
  });

  it("no_boards when details.boards is empty", () => {
    const c = content({ posting: { values: { v: 1, boardId: null, boardName: "", title: "", link: "" }, details: { v: 1, boards: [], truncated: false } } });
    expect(codes(c)).toContain("no_boards");
    expect(codes(c)).not.toContain("board_required");
  });

  it("board_required when boardId is null and boards exist", () => {
    const c = content({ posting: { values: { v: 1, boardId: null, boardName: "", title: "", link: "" }, details: { v: 1, boards: [{ id: "b1", name: "Recipes" }], truncated: false } } });
    expect(codes(c)).toContain("board_required");
  });

  it("board_not_found when the stored board is missing from details", () => {
    const c = content({ posting: { values: { v: 1, boardId: "gone", boardName: "Old", title: "", link: "" }, details: { v: 1, boards: [{ id: "b1", name: "Recipes" }], truncated: false } } });
    expect(issueFor(c, "board_not_found")?.message).toBe('The board "Old" is no longer on Pinterest. Choose another.');
  });

  it("no board checks when details are null (composer-only, F11)", () => {
    const c = content({ posting: { values: { v: 1, boardId: null, boardName: "", title: "", link: "" }, details: null } });
    expect(codes(c)).not.toContain("no_boards");
    expect(codes(c)).not.toContain("board_not_found");
  });

  it("title_too_long at 101, publishes at 100", () => {
    const over = content({ posting: { values: { v: 1, boardId: "b1", boardName: "Recipes", title: "x".repeat(101), link: "" }, details: { v: 1, boards: [{ id: "b1", name: "Recipes" }], truncated: false } } });
    expect(issueFor(over, "title_too_long")).toMatchObject({ count: 101, limit: PINTEREST_TITLE_MAX });
    const at = content({ posting: { values: { v: 1, boardId: "b1", boardName: "Recipes", title: "x".repeat(100), link: "" }, details: { v: 1, boards: [{ id: "b1", name: "Recipes" }], truncated: false } } });
    expect(codes(at)).not.toContain("title_too_long");
  });

  it("counts the title in code points, not UTF-16 units", () => {
    const emoji = "😀";
    const publishes = content({ posting: { values: { v: 1, boardId: "b1", boardName: "Recipes", title: emoji.repeat(51), link: "" }, details: { v: 1, boards: [{ id: "b1", name: "Recipes" }], truncated: false } } });
    expect(codes(publishes)).not.toContain("title_too_long");
    const refused = content({ posting: { values: { v: 1, boardId: "b1", boardName: "Recipes", title: emoji.repeat(101), link: "" }, details: { v: 1, boards: [{ id: "b1", name: "Recipes" }], truncated: false } } });
    expect(issueFor(refused, "title_too_long")).toMatchObject({ count: 101, limit: PINTEREST_TITLE_MAX });
  });

  it("link_too_long at 2049, publishes at 2048", () => {
    const base = "https://example.com/";
    const over = content({ posting: { values: { v: 1, boardId: "b1", boardName: "Recipes", title: "", link: base + "x".repeat(2049 - base.length) }, details: { v: 1, boards: [{ id: "b1", name: "Recipes" }], truncated: false } } });
    expect(issueFor(over, "link_too_long")).toMatchObject({ count: 2049, limit: PINTEREST_LINK_MAX });
    const at = content({ posting: { values: { v: 1, boardId: "b1", boardName: "Recipes", title: "", link: base + "x".repeat(2048 - base.length) }, details: { v: 1, boards: [{ id: "b1", name: "Recipes" }], truncated: false } } });
    expect(codes(at)).not.toContain("link_too_long");
  });

  it("link_invalid for a non-absolute or non-http(s) link", () => {
    const c = content({ posting: { values: { v: 1, boardId: "b1", boardName: "Recipes", title: "", link: "example.com" }, details: { v: 1, boards: [{ id: "b1", name: "Recipes" }], truncated: false } } });
    expect(codes(c)).toContain("link_invalid");
  });

  it("aspect_far_from_recommended is a warning and still publishes", () => {
    const c = content({ media: [image({ width: 1000, height: 300 })] });
    const issue = issueFor(c, "aspect_far_from_recommended");
    expect(issue?.severity).toBe("warning");
    const errors = validatePinterest(c, pinterestCapabilities).filter((i) => i.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("a 2:3 image produces no aspect issue", () => {
    const c = content({ media: [image({ width: 1000, height: 1500 })] });
    expect(codes(c)).not.toContain("aspect_far_from_recommended");
  });

  it("image_url_not_https refuses a non-https image URL", () => {
    const c = content({ media: [image({ url: "http://cdn.example.com/a.jpg" })] });
    expect(codes(c)).toContain("image_url_not_https");
  });
});

describe("is pure and never throws", () => {
  it("handles an unparseable posting.values object", () => {
    expect(() => validatePinterest(content({ posting: { values: { nonsense: true }, details: null } }), pinterestCapabilities)).not.toThrow();
  });
});
