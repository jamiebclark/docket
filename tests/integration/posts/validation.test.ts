import { afterAll, describe, expect, it } from "vitest";
import { ValidationIssuesError } from "../../../src/server/dal/errors";
import * as media from "../../../src/server/services/media";
import * as posts from "../../../src/server/services/posts";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});

const NOW = new Date("2026-10-01T12:00:00Z");

const asset = (scope: Parameters<typeof media.registerAsset>[0], n: number, over: Record<string, unknown> = {}) =>
  media.registerAsset(scope, {
    storageKey: `k/${n}-${Math.random()}.png`, publicUrl: `http://localhost:3000/m/${n}.png`, mimeType: "image/png", byteSize: 100, altText: "alt", ...over,
  });

describe("validation refusal", () => {
  it("refuses over-limit text with the limit in the message and writes nothing", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const p = await posts.createDraft(env.scope, { baseText: "x".repeat(501), targets: [{ accountId: a.id }] });
    const [res] = await atTime(NOW, () => posts.addToQueue(env.scope, p.post.id));
    expect(res).toMatchObject({ ok: false, code: "validation" });
    expect((res as { issues: { code: string; limit?: number }[] }).issues[0]).toMatchObject({ code: "text_too_long", limit: 500 });
    expect((await posts.getPost(env.scope, p.post.id)).targets[0]!.status).toBe("draft");
  });

  it("refuses too many images and wrong types", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const many = await Promise.all([1, 2, 3, 4, 5].map((n) => asset(env.scope, n)));
    const p1 = await posts.createDraft(env.scope, { baseText: "t", mediaIds: many.map((m) => m.id), targets: [{ accountId: a.id }] });
    const [r1] = await atTime(NOW, () => posts.addToQueue(env.scope, p1.post.id));
    expect((r1 as { issues: { code: string }[] }).issues.map((i) => i.code)).toContain("too_many_images");
    const gif = await asset(env.scope, 9, { mimeType: "image/gif" });
    const p2 = await posts.createDraft(env.scope, { baseText: "t", mediaIds: [gif.id], targets: [{ accountId: a.id }] });
    const [r2] = await atTime(NOW, () => posts.addToQueue(env.scope, p2.post.id));
    expect((r2 as { issues: { code: string }[] }).issues.map((i) => i.code)).toContain("mime_not_allowed");
  });

  it("a per-target override can fix one target, and one failure never blocks the others", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const b = await env.account();
    const p = await posts.createDraft(env.scope, {
      baseText: "x".repeat(600),
      targets: [{ accountId: a.id, overrideText: "short" }, { accountId: b.id }],
    });
    const results = await atTime(NOW, () => posts.addToQueue(env.scope, p.post.id));
    const byAccount = Object.fromEntries(results.map((r) => [r.accountId, r]));
    expect(byAccount[a.id]).toMatchObject({ ok: true });
    expect(byAccount[b.id]).toMatchObject({ ok: false, code: "validation" });
    expect((await posts.getPost(env.scope, p.post.id)).post.status).toBe("scheduled");
  });

  it("refuses an edit that would break a scheduled target, grouped by target", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const p = await posts.createDraft(env.scope, { baseText: "ok", targets: [{ accountId: a.id }] });
    await atTime(NOW, () => posts.addToQueue(env.scope, p.post.id));
    const err = await posts.updatePost(env.scope, p.post.id, { baseText: "x".repeat(501) }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationIssuesError);
    expect(Object.keys(err.issues)).toEqual([p.targets[0]!.id]);
    expect((await posts.getPost(env.scope, p.post.id)).post.baseText).toBe("ok");
  });

  it("validatePost reports issues per target without changing anything", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const p = await posts.createDraft(env.scope, { baseText: "", targets: [{ accountId: a.id }] });
    const [v] = await posts.validatePost(env.scope, p.post.id);
    expect(v!.issues.map((i) => i.code)).toContain("empty_post");
  });
});
