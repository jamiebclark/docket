import { afterAll, describe, expect, it } from "vitest";
import { api, createKey, world } from "../../../helpers/api";
import { closeDb } from "../../../helpers/db";
import { postsEnv } from "../../../helpers/posts-env";
import { listVoiceProfiles } from "../../../../src/server/services/voice";

afterAll(closeDb);

const content = { voiceAndTone: "Warm, a little playful, never salesy." };

describe("POST /voice-profiles", () => {
  it("creates version 1 and marks it the default when the project had none", async () => {
    const env = await postsEnv();
    const key = (await createKey(env.scope, ["manage_setup"], { rateLimitPerMinute: 1000 })).secret;
    const r = await api("POST", "/voice-profiles", { key, body: { name: "House voice", content } });
    expect(r.status).toBe(201);
    expect(r.json).toEqual({ id: expect.any(String), version: 1, isDefault: true });
  });

  it("rejects an over-length name, an over-limit content field naming its details.path, a bad link and a malformed hashtag", async () => {
    const env = await postsEnv();
    const key = (await createKey(env.scope, ["manage_setup"], { rateLimitPerMinute: 1000 })).secret;
    const tooLongName = await api("POST", "/voice-profiles", { key, body: { name: "x".repeat(81), content } });
    expect(tooLongName.status).toBe(400);
    expect(tooLongName.json.error.code).toBe("validation_failed");

    const overLimitField = await api("POST", "/voice-profiles", {
      key,
      body: { name: "House voice", content: { ...content, examplePosts: ["ok", "ok", "x".repeat(3001)] } },
    });
    expect(overLimitField.status).toBe(400);
    expect(overLimitField.json.error.details).toContainEqual(expect.objectContaining({ path: "content.examplePosts.2" }));

    const badLink = await api("POST", "/voice-profiles", {
      key,
      body: { name: "House voice", content: { ...content, preferredLinks: [{ url: "not-a-url", label: "x" }] } },
    });
    expect(badLink.status).toBe(400);

    const badHashtag = await api("POST", "/voice-profiles", {
      key,
      body: { name: "House voice", content: { ...content, preferredHashtags: ["this is not valid"] } },
    });
    expect(badHashtag.status).toBe(400);
  });

  it("answers 403 for a key lacking manage_setup", async () => {
    const env = await postsEnv();
    const key = (await createKey(env.scope, ["read"], { rateLimitPerMinute: 1000 })).secret;
    const r = await api("POST", "/voice-profiles", { key, body: { name: "House voice", content } });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("missing_permission");
    expect(r.json.error.details).toEqual({ permission: "manage_setup" });
  });

  it("creates in the caller's own project only, not the default when one already exists", async () => {
    const w = await world();
    const r = await api("POST", "/voice-profiles", { key: w.a.keys.manageSetup.secret, body: { name: "Second voice", content } });
    expect(r.status).toBe(201);
    expect(r.json.isDefault).toBe(false);
    const aProfiles = await listVoiceProfiles(w.a.scope);
    const bProfiles = await listVoiceProfiles(w.b.scope);
    expect(aProfiles.map((p) => p.id)).toContain(r.json.id);
    expect(bProfiles.map((p) => p.id)).not.toContain(r.json.id);
  });

  it("replays the stored response for a repeated Idempotency-Key and creates nothing new", async () => {
    const env = await postsEnv();
    const key = (await createKey(env.scope, ["manage_setup"], { rateLimitPerMinute: 1000 })).secret;
    const body = { name: "House voice", content };
    const first = await api("POST", "/voice-profiles", { key, idem: "voice-1", body });
    expect(first.status).toBe(201);
    const second = await api("POST", "/voice-profiles", { key, idem: "voice-1", body });
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(second.json).toEqual(first.json);
  });
});
