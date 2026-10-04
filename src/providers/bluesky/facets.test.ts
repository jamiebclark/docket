import { describe, expect, it } from "vitest";
import { buildFacets } from "./facets";

const slice = (text: string, f: { index: { byteStart: number; byteEnd: number } }) =>
  Buffer.from(text).subarray(f.index.byteStart, f.index.byteEnd).toString();

describe("buildFacets", () => {
  it.each([
    ["emoji", "👨‍👩‍👧 look"],
    ["accents", "café résumé"],
    ["CJK", "日本語のテキスト"],
  ])("byte ranges are right after %s", (_name, prefix) => {
    const text = `${prefix} https://example.com/a @alice.bsky.social #tag`;
    const { facets, counts } = buildFacets(text, { "alice.bsky.social": "did:plc:alice" });
    expect(facets.map((f) => slice(text, f))).toEqual(["https://example.com/a", "@alice.bsky.social", "#tag"]);
    expect(facets[1]!.features[0]).toMatchObject({ did: "did:plc:alice" });
    expect(counts).toEqual({ links: 1, mentions: 1, tags: 1, droppedMentions: 0 });
  });

  it("drops an unresolved mention and leaves the text unchanged", () => {
    const text = "hi @ghost.bsky.social #x";
    const built = buildFacets(text, { "ghost.bsky.social": null });
    expect(built.text).toBe(text);
    expect(built.facets).toHaveLength(1);
    expect(built.counts).toMatchObject({ mentions: 0, tags: 1, droppedMentions: 1 });
  });

  it("handles a resolved and unresolved pair", () => {
    const text = "@a.bsky.social and @b.bsky.social";
    const { facets, counts } = buildFacets(text, { "a.bsky.social": "did:plc:a", "b.bsky.social": null });
    expect(facets).toHaveLength(1);
    expect(slice(text, facets[0]!)).toBe("@a.bsky.social");
    expect(counts).toMatchObject({ mentions: 1, droppedMentions: 1 });
  });

  it("treats a mention missing from the map as unresolved", () => {
    expect(buildFacets("@x.bsky.social", {}).facets).toEqual([]);
  });
});
