import { describe, expect, it } from "vitest";
import type { PinterestDetails } from "./boards";
import {
  AFTER_PREVIEW,
  DEFAULT_POSTING_VALUES,
  PINTEREST_LINK_MAX,
  PINTEREST_TITLE_MAX,
  pinterestPosting,
  pinterestPostingSchema,
  type PinterestPostingValues,
} from "./posting";

const values = (over: Partial<PinterestPostingValues> = {}): PinterestPostingValues => ({ ...DEFAULT_POSTING_VALUES, ...over });
const details = (boards: { id: string; name: string }[], truncated = false): PinterestDetails => ({ v: 1, boards, truncated });
const view = (v: PinterestPostingValues | null, d: PinterestDetails | null) => pinterestPosting.view({ values: v, details: d, postType: "image" });
const boardField = (v: PinterestPostingValues | null, d: PinterestDetails | null) => view(v, d)[0]!;

describe("pinterestPostingSchema", () => {
  it("defaults every member", () => {
    expect(pinterestPostingSchema.parse({})).toEqual(DEFAULT_POSTING_VALUES);
  });

  it("fills a sparse submission with defaults", () => {
    expect(pinterestPostingSchema.parse({ boardId: "b1" })).toEqual(values({ boardId: "b1" }));
  });
});

describe("view: board field across the five picker states", () => {
  it("loading (details null, no stored board): disabled, no options", () => {
    const f = boardField(null, null);
    expect(f).toMatchObject({ key: "boardId", kind: "choice", required: true, labelKey: "boardName", value: null });
    expect(f.disabled?.reason).toBe("Pinterest's boards are still loading.");
    if (f.kind !== "choice") throw new Error("choice");
    expect(f.options).toEqual([]);
  });

  it("loading with a stored board: the stored board is the only option, control still disabled", () => {
    const f = boardField(values({ boardId: "b1", boardName: "Recipes" }), null);
    expect(f.disabled?.reason).toBe("Pinterest's boards are still loading.");
    if (f.kind !== "choice") throw new Error("choice");
    expect(f.options).toEqual([{ value: "b1", label: "Recipes" }]);
    expect(f.value).toBe("b1");
  });

  it("no boards: disabled, no options", () => {
    const f = boardField(null, details([]));
    expect(f.disabled?.reason).toMatch(/no public boards/);
    if (f.kind !== "choice") throw new Error("choice");
    expect(f.options).toEqual([]);
  });

  it("boards present, choice valid: one option per board, nothing disabled", () => {
    const f = boardField(values({ boardId: "b2" }), details([{ id: "b1", name: "Recipes" }, { id: "b2", name: "Travel" }]));
    expect(f.disabled).toBeUndefined();
    if (f.kind !== "choice") throw new Error("choice");
    expect(f.options).toEqual([
      { value: "b1", label: "Recipes" },
      { value: "b2", label: "Travel" },
    ]);
  });

  it("stored board missing: every board plus the stored id as a disabled option", () => {
    const f = boardField(values({ boardId: "gone", boardName: "Old Board" }), details([{ id: "b1", name: "Recipes" }]));
    expect(f.disabled).toBeUndefined();
    if (f.kind !== "choice") throw new Error("choice");
    expect(f.options).toEqual([
      { value: "b1", label: "Recipes" },
      { value: "gone", label: "Old Board — no longer on Pinterest", disabled: { reason: "This board is no longer on Pinterest." } },
    ]);
  });
});

describe("view: title and link fields", () => {
  it("are optional text fields counted in code points, with the right maxima", () => {
    const [, title, link] = view(values({ title: "Hi", link: "https://example.com" }), null);
    expect(title).toMatchObject({ key: "title", kind: "text", value: "Hi", maxLength: PINTEREST_TITLE_MAX, countingRule: "code_points", optional: true });
    expect(link).toMatchObject({ key: "link", kind: "text", value: "https://example.com", maxLength: PINTEREST_LINK_MAX, countingRule: "code_points", optional: true });
  });

  it("is total with no values and no details", () => {
    expect(() => view(null, null)).not.toThrow();
  });
});

describe("notice, targetNote, summaryNotes, afterPreview", () => {
  it("notice carries the Trial text with a doc and docLabel", () => {
    const n = pinterestPosting.notice?.();
    expect(n?.text).toMatch(/Trial access/);
    expect(n?.docLabel).toBe("Read how Pinterest's Trial access works");
    expect(n?.doc).toBeTruthy();
  });

  it("targetNote names the board, or 'Board chosen' without a stored label, or null", () => {
    expect(pinterestPosting.targetNote?.(values({ boardId: "b1", boardName: "Recipes" }))).toBe("Board: Recipes");
    expect(pinterestPosting.targetNote?.(values({ boardId: "b1", boardName: "" }))).toBe("Board chosen");
    expect(pinterestPosting.targetNote?.(values())).toBeNull();
    expect(pinterestPosting.targetNote?.(null)).toBeNull();
  });

  it("summaryNotes include the Trial line and the publish-limit line", () => {
    const notes = pinterestPosting.summaryNotes?.() ?? [];
    expect(notes.some((n) => /Trial access/.test(n))).toBe(true);
    expect(notes.some((n) => /one image and a board/.test(n))).toBe(true);
    expect(notes.some((n) => /100 pins a minute/.test(n))).toBe(true);
  });

  it("afterPreview explains the Pinterest-only fields", () => {
    expect(AFTER_PREVIEW).toMatch(/Pinterest-only/);
    expect(pinterestPosting.afterPreview).toBe(AFTER_PREVIEW);
  });
});
