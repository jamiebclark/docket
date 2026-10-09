import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreatorDetails } from "./creator";
import { DEFAULT_POSTING_VALUES, privacyLabel, tiktokConsent, tiktokPosting, tiktokPostingSchema, type TikTokPostingValues } from "./posting";

const details: CreatorDetails = {
  v: 1,
  nickname: "Ada",
  username: "ada",
  privacyOptions: ["PUBLIC_TO_EVERYONE", "FOLLOWER_OF_CREATOR", "SELF_ONLY"],
  commentDisabled: false,
  duetDisabled: true,
  stitchDisabled: false,
  maxVideoSeconds: 600,
};
const values = (over: Partial<TikTokPostingValues> = {}): TikTokPostingValues => ({ ...DEFAULT_POSTING_VALUES, ...over });
const view = (v: TikTokPostingValues | null, d: CreatorDetails | null, postType: "video" | "image" | "carousel" = "video") =>
  tiktokPosting.view({ values: v, details: d, postType });
const keys = (v: ReturnType<typeof view>) => v.map((f) => f.key);

afterEach(() => vi.unstubAllEnvs());

describe("audited install", () => {
  it("offers the creator's privacy options with none chosen", () => {
    vi.stubEnv("TIKTOK_APP_AUDITED", "true");
    const privacy = view(null, details)[0]!;
    expect(privacy).toMatchObject({ kind: "choice", value: null, required: true });
    if (privacy.kind !== "choice") throw new Error("choice");
    expect(privacy.options.map((o) => o.label)).toEqual(["Everyone", "Followers", "Only me"]);
    expect(privacy.options.some((o) => o.disabled)).toBe(false);
  });

  it("disables 'Only me' while branded content is on", () => {
    vi.stubEnv("TIKTOK_APP_AUDITED", "true");
    const privacy = view(values({ disclosure: true, brandedContent: true }), details)[0]!;
    if (privacy.kind !== "choice") throw new Error("choice");
    expect(privacy.options.find((o) => o.value === "SELF_ONLY")?.disabled?.reason).toBe("Branded content can't be private.");
  });

  it("has no options while details are unavailable", () => {
    vi.stubEnv("TIKTOK_APP_AUDITED", "true");
    const privacy = view(null, null)[0]!;
    if (privacy.kind !== "choice") throw new Error("choice");
    expect(privacy.options).toEqual([]);
  });

  it("enables 'Branded content' once disclosure is on", () => {
    vi.stubEnv("TIKTOK_APP_AUDITED", "true");
    const f = view(values({ disclosure: true }), details).find((x) => x.key === "brandedContent")!;
    expect(f.disabled).toBeUndefined();
  });
});

describe("unaudited install", () => {
  it("shows a fixed private level and disables 'Branded content'", () => {
    const f = view(values({ disclosure: true }), details);
    expect(f[0]).toMatchObject({ key: "privacy", kind: "fixed", value: "SELF_ONLY", display: "Only me (private)" });
    expect(f.find((x) => x.key === "brandedContent")?.disabled?.reason).toMatch(/can only post privately/);
  });
});

describe("per post type and details", () => {
  it("shows comments, duets and stitches for a video, with the creator's disabled ones explained", () => {
    const f = view(null, details, "video");
    expect(keys(f)).toEqual(["privacy", "allowComments", "allowDuets", "allowStitches", "disclosure"]);
    expect(f.find((x) => x.key === "allowDuets")?.disabled?.reason).toBe("Turned off in this TikTok account's settings.");
    expect(f.find((x) => x.key === "allowComments")?.disabled).toBeUndefined();
    expect(f.find((x) => x.key === "allowStitches")?.disabled).toBeUndefined();
  });

  it.each(["image", "carousel"] as const)("shows only comments and a photo title for a %s", (type) => {
    const f = view(null, details, type);
    expect(keys(f)).toEqual(["privacy", "allowComments", "photoTitle", "disclosure"]);
    expect(f.find((x) => x.key === "photoTitle")).toMatchObject({ kind: "text", maxLength: 90, optional: true });
  });

  it("shows 'Your brand' and 'Branded content' only when disclosure is on", () => {
    expect(keys(view(values({ disclosure: true }), details, "image"))).toEqual([
      "privacy", "allowComments", "photoTitle", "disclosure", "yourBrand", "brandedContent",
    ]);
  });

  it("is total with no values and no details", () => {
    expect(() => view(null, null, "image")).not.toThrow();
  });

  it("has unique keys matching the issue-key pattern", () => {
    const f = view(values({ disclosure: true }), details, "video");
    expect(new Set(keys(f)).size).toBe(f.length);
    for (const k of keys(f)) expect(k).toMatch(/^[a-z][a-zA-Z0-9]*$/);
  });
});

describe("heading, notice, notes", () => {
  it("heads the panel with the nickname, falling back to the username", () => {
    expect(tiktokPosting.heading?.(details)).toBe("Posting to Ada");
    expect(tiktokPosting.heading?.({ ...details, nickname: "" })).toBe("Posting to ada");
    expect(tiktokPosting.heading?.(null)).toBeNull();
  });

  it("explains an unaudited install only", () => {
    expect(tiktokPosting.notice?.()?.text).toMatch(/audit/);
    vi.stubEnv("TIKTOK_APP_AUDITED", "true");
    expect(tiktokPosting.notice?.()).toBeNull();
  });

  it("notes 'Private on TikTok' for a private choice, or for no values on an unaudited install", () => {
    expect(tiktokPosting.targetNote?.(null)).toBe("Private on TikTok");
    expect(tiktokPosting.targetNote?.(values({ privacy: "SELF_ONLY" }))).toBe("Private on TikTok");
    vi.stubEnv("TIKTOK_APP_AUDITED", "true");
    expect(tiktokPosting.targetNote?.(null)).toBeNull();
    expect(tiktokPosting.targetNote?.(values({ privacy: "PUBLIC_TO_EVERYONE" }))).toBeNull();
    expect(tiktokPosting.targetNote?.(values({ privacy: "SELF_ONLY" }))).toBe("Private on TikTok");
  });

  it("adds the unaudited summary note only when unaudited", () => {
    expect(tiktokPosting.summaryNotes?.().some((n) => /audit/.test(n))).toBe(true);
    vi.stubEnv("TIKTOK_APP_AUDITED", "true");
    const notes = tiktokPosting.summaryNotes?.() ?? [];
    expect(notes.some((n) => /audit/.test(n))).toBe(false);
    expect(notes.some((n) => /media domain/.test(n))).toBe(true);
    expect(notes.some((n) => /15 posts/.test(n))).toBe(true);
  });
});

describe("consent and values", () => {
  it("declares the music confirmation, and the branded content policy when branded", () => {
    expect(tiktokConsent.declaration(null)).toBe("By posting, you agree to TikTok's Music Usage Confirmation.");
    expect(tiktokConsent.declaration(values({ brandedContent: true }))).toBe(
      "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation.",
    );
  });

  it("labels privacy levels, showing an unknown one as its code", () => {
    expect(privacyLabel("MUTUAL_FOLLOW_FRIENDS")).toBe("Friends (mutual followers)");
    expect(privacyLabel("NEW_LEVEL")).toBe("NEW_LEVEL");
  });

  it("parses stored values and rejects malformed ones", () => {
    expect(tiktokPostingSchema.safeParse(DEFAULT_POSTING_VALUES).success).toBe(true);
    expect(tiktokPostingSchema.safeParse({ ...DEFAULT_POSTING_VALUES, privacy: "public" }).success).toBe(false);
    expect(tiktokPostingSchema.safeParse({ v: 2 }).success).toBe(false);
  });

  it("fills a sparse submission with defaults and clears hidden brand boxes", () => {
    expect(tiktokPostingSchema.parse({ privacy: "SELF_ONLY" })).toEqual({ ...DEFAULT_POSTING_VALUES, privacy: "SELF_ONLY" });
    expect(tiktokPostingSchema.parse({ yourBrand: true, brandedContent: true })).toMatchObject({ yourBrand: false, brandedContent: false });
    expect(tiktokPostingSchema.parse({ disclosure: true, yourBrand: true })).toMatchObject({ yourBrand: true });
  });
});
