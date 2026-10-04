import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/p/[projectSlug]/media/actions", () => ({
  listMediaAction: async () => ({ ok: false, error: "conflict", message: "n/a" }),
  updateMediaAction: async () => ({ ok: false, error: "conflict", message: "n/a" }),
  uploadMediaAction: async () => ({ ok: false, error: "conflict", message: "n/a" }),
}));

import type { MediaView } from "@/server/services/media";
import { MediaPicker, moveItem } from "./MediaPicker";

const view = (id: string, name: string): MediaView => ({
  id,
  thumbnailUrl: `https://m.test/${id}.webp`,
  publicUrl: `https://m.test/${id}.png`,
  mimeType: "image/png",
  width: 10,
  height: 10,
  byteSize: 100,
  altText: "",
  missingAlt: true,
  tags: [],
  inUse: false,
  reservedByJobId: null,
  originalFilename: name,
  createdAt: new Date(0),
});

const render = (props: Partial<Parameters<typeof MediaPicker>[0]>) =>
  renderToStaticMarkup(
    createElement(MediaPicker, { slug: "p", enabled: true, canEdit: true, value: [], onChange: () => {}, ...props }),
  );

describe("moveItem", () => {
  it("moves within range and ignores out-of-range moves", () => {
    expect(moveItem(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveItem(["a", "b", "c"], 2, 1)).toEqual(["a", "c", "b"]);
    expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    expect(moveItem(["a", "b"], 1, 2)).toEqual(["a", "b"]);
  });
});

describe("MediaPicker", () => {
  it("renders up/down reorder buttons, disabled at the ends", () => {
    const html = render({ value: [view("1", "one.png"), view("2", "two.png")] });
    expect(html).toContain('aria-label="Move image 1 up"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Move image 1 up"|aria-label="Move image 1 up"[^>]*disabled=""/);
    expect(html).toContain('aria-label="Move image 2 down"');
    expect(html).toContain('aria-label="Remove image 2"');
    expect(html).toContain(">Add images</button>");
  });

  it("shows the storage-disabled state and no controls", () => {
    const html = render({ enabled: false, value: [] });
    expect(html).toContain("Media storage is not set up");
    expect(html).not.toContain(">Add images</button>");
  });

  it("hides editing controls for read-only users", () => {
    const html = render({ canEdit: false, value: [view("1", "one.png")] });
    expect(html).not.toContain("Move image");
    expect(html).not.toContain(">Add images</button>");
  });
});
