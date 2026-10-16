import { afterAll, describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "../../../src/server/api/openapi";
import * as posts from "../../../src/server/services/posts";
import { api, createKey } from "../../helpers/api";
import { closeDb } from "../../helpers/db";
import { createVideoAsset } from "../../helpers/factories";
import { postsEnv } from "../../helpers/posts-env";
import { createMockAccount } from "../../helpers/scheduling";

afterAll(closeDb);

async function setup() {
  const env = await postsEnv();
  const key = (await createKey(env.scope, ["read", "write_posts"], { rateLimitPerMinute: 1000 })).secret;
  const instagram = await createMockAccount(env.project.id, {}, { providerKey: "instagram" });
  const facebook = await createMockAccount(env.project.id, {}, { providerKey: "facebook" });
  const mock = await createMockAccount(env.project.id, {});
  const video = await createVideoAsset(env.project.id, { width: 1080, height: 1920 });
  const create = (body: Record<string, unknown>) =>
    api("POST", "/posts", { key, body: { text: "Hello", accountIds: [instagram.id], mediaIds: [video.id], ...body } });
  return { env, key, instagram, facebook, mock, video, create };
}

describe("createPost postTypes", () => {
  it("defaults an Instagram single-video target to video", async () => {
    const { create } = await setup();
    const r = await create({});
    expect(r.status).toBe(201);
    expect(r.json.post.targets[0].postType).toBe("video");
  });

  it("stores reel and reports it on the post and the target", async () => {
    const { key, instagram, create } = await setup();
    const r = await create({ postTypes: { [instagram.id]: "reel" } });
    expect(r.status).toBe(201);
    expect(r.json.post.targets[0].postType).toBe("reel");
    const target = await api("GET", `/posts/${r.json.post.id}/targets/${r.json.post.targets[0].id}`, { key });
    expect(target.json.postType).toBe("reel");
    const post = await api("GET", `/posts/${r.json.post.id}`, { key });
    expect(post.json.targets[0].postType).toBe("reel");
  });

  it("accepts story and reports it on the post and the target", async () => {
    const { key, instagram, create } = await setup();
    const r = await create({ postTypes: { [instagram.id]: "story" } });
    expect(r.status).toBe(201);
    expect(r.json.post.targets[0].postType).toBe("story");
    const target = await api("GET", `/posts/${r.json.post.id}/targets/${r.json.post.targets[0].id}`, { key });
    expect(target.json.postType).toBe("story");
  });

  it("refuses an unoffered value, naming what Instagram offers", async () => {
    const { instagram, create } = await setup();
    const r = await create({ postTypes: { [instagram.id]: "carousel" } });
    expect(r.status).toBe(400);
    expect(r.text).toContain("image, story, video, reel");
    expect(r.text).toContain(instagram.id);
  });

  it("defaults a Facebook single-video target to video, and accepts reel", async () => {
    const { facebook, create } = await setup();
    const dflt = await create({ accountIds: [facebook.id] });
    expect(dflt.status).toBe(201);
    expect(dflt.json.post.targets[0].postType).toBe("video");
    const reel = await create({ accountIds: [facebook.id], postTypes: { [facebook.id]: "reel" } });
    expect(reel.status).toBe(201);
    expect(reel.json.post.targets[0].postType).toBe("reel");
  });

  it("refuses story for Facebook, naming video, reel", async () => {
    const { facebook, create } = await setup();
    const r = await create({ accountIds: [facebook.id], postTypes: { [facebook.id]: "story" } });
    expect(r.status).toBe(400);
    expect(r.text).toContain("video, reel");
  });

  it("refuses a choice for an account whose provider offers none", async () => {
    const { mock, create } = await setup();
    const r = await create({ accountIds: [mock.id], postTypes: { [mock.id]: "reel" } });
    expect(r.status).toBe(400);
    expect(r.text).toContain("offers no post type choice");
  });

  it("refuses a key that is not in accountIds", async () => {
    const { create } = await setup();
    const r = await create({ postTypes: { "00000000-0000-4000-8000-000000000000": "reel" } });
    expect(r.status).toBe(400);
  });

  it("reads story among Instagram's post types, with its label and description", async () => {
    const { env, instagram, video } = await setup();
    const check = await posts.checkComposition(env.scope, {
      baseText: "Hello",
      mediaIds: [video.id],
      targets: [{ accountId: instagram.id }],
    });
    const story = check.targets[0]!.postTypeChoice!.options.find((o) => o.type === "story")!;
    expect(story).toMatchObject({
      label: "Story",
      description: "Shown for 24 hours in Stories. A Story carries no caption, no link and no stickers.",
    });
  });

  it("reports a story target's dropped-text, dropped-alt-text and crop notices, each with its severity", async () => {
    const { env, key, instagram } = await setup();
    const image = await env.scope.media.insert({
      storageKey: `test/${crypto.randomUUID()}.jpg`,
      publicUrl: "https://media.example.test/x",
      mimeType: "image/jpeg",
      byteSize: 50_000,
      width: 1200,
      height: 900,
      altText: "A description",
    });
    const r = await api("POST", "/posts", {
      key,
      body: { text: "Hello", accountIds: [instagram.id], mediaIds: [image.id], postTypes: { [instagram.id]: "story" } },
    });
    expect(r.status).toBe(201);
    const issues = r.json.validation[0].issues as { code: string; severity: string }[];
    expect(issues).toContainEqual(expect.objectContaining({ code: "story_text_dropped", severity: "info" }));
    expect(issues).toContainEqual(expect.objectContaining({ code: "story_alt_text_dropped", severity: "info" }));
    expect(issues).toContainEqual(expect.objectContaining({ code: "story_will_crop", severity: "info" }));
  });

  it("reports a story target's own requirements, not the feed's or the Reel's", async () => {
    const { env, instagram, video } = await setup();
    const image = await env.scope.media.insert({
      storageKey: `test/${crypto.randomUUID()}.png`,
      publicUrl: "https://media.example.test/x",
      mimeType: "image/png",
      byteSize: 50_000,
      altText: "a",
    });
    const imageCheck = await posts.checkComposition(env.scope, {
      baseText: "Hello",
      mediaIds: [image.id],
      targets: [{ accountId: instagram.id, postType: "story" }],
    });
    const imageReqs = imageCheck.targets[0]!.requirements!.image;
    expect(imageReqs.aspectRatio).toEqual({ min: null, max: null });
    expect(imageReqs.recommendedAspectRatio).toMatchObject({ value: 0.5625, label: "9:16" });
    expect(imageReqs.notes).toHaveLength(1);

    const videoCheck = await posts.checkComposition(env.scope, {
      baseText: "Hello",
      mediaIds: [video.id],
      targets: [{ accountId: instagram.id, postType: "story" }],
    });
    const videoReqs = videoCheck.targets[0]!.requirements!.video;
    expect(videoReqs).toMatchObject({
      maxBytes: { value: 100_000_000 },
      duration: { min: { value: 3 }, max: { value: 60 } },
      aspectRatio: { min: { value: 0.1 }, max: { value: 10 } },
      postType: { value: "story", label: "Story" },
    });
    const reelCheck = await posts.checkComposition(env.scope, {
      baseText: "Hello",
      mediaIds: [video.id],
      targets: [{ accountId: instagram.id, postType: "reel" }],
    });
    expect(reelCheck.targets[0]!.requirements!.video.maxBytes).not.toEqual(videoReqs.maxBytes);
    expect(reelCheck.targets[0]!.requirements!.video.duration).not.toEqual(videoReqs.duration);
  });

  it("lists postTypes and Target.postType in the OpenAPI document", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the document is arbitrary JSON
    const doc = buildOpenApiDocument() as any;
    const body = doc.paths["/posts"].post.requestBody.content["application/json"].schema;
    const schema = body.$ref ? doc.components.schemas[body.$ref.split("/").pop()] : body;
    expect(Object.keys(schema.properties)).toContain("postTypes");
    expect(Object.keys(doc.components.schemas.Target.properties)).toContain("postType");
  });
});
