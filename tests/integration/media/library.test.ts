import { afterAll, describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError } from "../../../src/server/dal/errors";
import * as media from "../../../src/server/services/media";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";
import { createMediaAsset } from "../../helpers/scheduling";

afterAll(async () => {
  await closeDb();
});

describe("media library", () => {
  it("filters by tag, unused, missing alt and search", async () => {
    const { scope, project } = await postsEnv();
    const a = await createMediaAsset(project.id, { altText: "A red barn" });
    const b = await createMediaAsset(project.id);
    await media.updateMedia(scope, a.id, { tags: ["Farm", " farm ", "red"] });
    await scope.media.markUsed([a.id], new Date());
    const ids = async (f: object) => (await media.listMedia(scope, f)).items.map((i) => i.id);
    expect(await ids({ tag: "farm" })).toEqual([a.id]);
    expect(await ids({ unused: true })).toEqual([b.id]);
    expect(await ids({ missingAlt: true })).toEqual([b.id]);
    expect(await ids({ q: "BARN" })).toEqual([a.id]);
    expect(await ids({ q: "%" })).toEqual([]);
    expect((await media.listMedia(scope)).tags).toEqual(["farm", "red"]);
  });

  it("paginates 24 per page", async () => {
    const { scope, project } = await postsEnv();
    for (let i = 0; i < 25; i++) await createMediaAsset(project.id);
    const p1 = await media.listMedia(scope, { page: 1 });
    const p2 = await media.listMedia(scope, { page: 2 });
    expect([p1.items.length, p2.items.length, p1.total, p1.pageCount]).toEqual([24, 1, 25, 2]);
  });

  it("normalises tags, caps them at 20 and alt text at 2,000", async () => {
    const { scope, project } = await postsEnv();
    const a = await createMediaAsset(project.id);
    expect((await media.updateMedia(scope, a.id, { tags: ["B", "a", "b"] })).tags).toEqual(["b", "a"]);
    const many = Array.from({ length: 21 }, (_, i) => `t${i}`);
    await expect(media.updateMedia(scope, a.id, { tags: many })).rejects.toThrow();
    await expect(media.updateMedia(scope, a.id, { tags: ["bad!"] })).rejects.toThrow();
    await expect(media.updateMedia(scope, a.id, { altText: "x".repeat(2001) })).rejects.toThrow();
    expect((await media.updateMedia(scope, a.id, { altText: "x".repeat(2000) })).missingAlt).toBe(false);
  });

  it("checks roles on edit", async () => {
    const { scope, project } = await postsEnv();
    const a = await createMediaAsset(project.id);
    const readOnly = Object.create(scope, { can: { value: (r: { media?: string[] }) => !r.media?.includes("edit") } }) as typeof scope;
    await expect(media.updateMedia(readOnly, a.id, { altText: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(media.deleteMedia(readOnly, a.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await media.listMedia(readOnly)).total).toBe(1);
  });

  it("treats other projects' and deleted ids as not found", async () => {
    const mine = await postsEnv();
    const other = await postsEnv();
    const theirs = await createMediaAsset(other.project.id);
    await expect(media.getMedia(mine.scope, theirs.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(media.updateMedia(mine.scope, theirs.id, { altText: "x" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(media.updateAltText(mine.scope, theirs.id, "x")).rejects.toBeInstanceOf(NotFoundError);
    await expect(media.deleteMediaImpact(mine.scope, theirs.id)).rejects.toBeInstanceOf(NotFoundError);
    const own = await createMediaAsset(mine.project.id);
    await media.deleteMedia(mine.scope, own.id);
    await expect(media.updateAltText(mine.scope, own.id, "x")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("falls back to the public URL when there is no thumbnail", async () => {
    const { scope, project } = await postsEnv();
    const a = await createMediaAsset(project.id);
    const v = await media.getMedia(scope, a.id);
    expect(v.thumbnailUrl).toBe(v.publicUrl);
  });
});

describe("media library URL filters (F1)", () => {
  it("passes ?unused=1 and ?missingAlt=1 from the page's search params through to listMedia", async () => {
    const { mediaSearchParamsSchema, toMediaListInput } = await import("../../../src/lib/validation/media");
    const env = await postsEnv();
    await createMediaAsset(env.project.id, { altText: "" });
    const parsed = mediaSearchParamsSchema.parse({ unused: "1", missingAlt: "1" });
    const result = await media.listMedia(env.scope, toMediaListInput(parsed));
    expect(result.total).toBeGreaterThanOrEqual(1);
  });
});
