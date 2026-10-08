import { afterAll, describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "../../../src/server/api/openapi";
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
  const video = await createVideoAsset(env.project.id, { width: 1080, height: 1920 });
  const create = (body: Record<string, unknown>) =>
    api("POST", "/posts", { key, body: { text: "Hello", accountIds: [instagram.id], mediaIds: [video.id], ...body } });
  return { env, key, instagram, facebook, video, create };
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

  it("refuses story, naming what Instagram offers", async () => {
    const { instagram, create } = await setup();
    const r = await create({ postTypes: { [instagram.id]: "story" } });
    expect(r.status).toBe(400);
    expect(r.text).toContain("video, reel");
    expect(r.text).toContain(instagram.id);
  });

  it("refuses a choice for an account whose provider offers none", async () => {
    const { facebook, create } = await setup();
    const r = await create({ accountIds: [facebook.id], postTypes: { [facebook.id]: "reel" } });
    expect(r.status).toBe(400);
    expect(r.text).toContain("offers no post type choice");
  });

  it("refuses a key that is not in accountIds", async () => {
    const { create } = await setup();
    const r = await create({ postTypes: { "00000000-0000-4000-8000-000000000000": "reel" } });
    expect(r.status).toBe(400);
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
