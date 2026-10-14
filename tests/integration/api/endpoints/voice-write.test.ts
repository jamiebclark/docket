import { afterAll, describe, expect, it } from "vitest";
import { api, createKey, world } from "../../../helpers/api";
import { closeDb } from "../../../helpers/db";
import { postsEnv } from "../../../helpers/posts-env";
import { createVoiceProfile as createVoiceProfileFactory } from "../../../helpers/factories";
import { archiveVoiceProfile, getVersion, getVoiceProfile, listVoiceProfiles } from "../../../../src/server/services/voice";

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

describe("PATCH /voice-profiles/{profileId}", () => {
  it("appends a version, leaving the earlier one unchanged", async () => {
    const w = await world();
    const { isDefault, current: before } = await getVoiceProfile(w.a.scope, w.a.voiceProfile.id);
    const r = await api("PATCH", `/voice-profiles/${w.a.voiceProfile.id}`, {
      key: w.a.keys.manageSetup.secret,
      body: { name: "Renamed voice", content: { ...content, voiceAndTone: "Punchier." }, baseVersion: 1 },
    });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ id: w.a.voiceProfile.id, version: 2, isDefault });

    const earlier = await getVersion(w.a.scope, w.a.voiceProfile.id, 1);
    expect(earlier.content).toEqual(before.content);
    const current = await getVersion(w.a.scope, w.a.voiceProfile.id, 2);
    expect(current.content.voiceAndTone).toBe("Punchier.");
  });

  it("refuses a stale baseVersion with 409 and appends nothing", async () => {
    const w = await world();
    const r = await api("PATCH", `/voice-profiles/${w.a.voiceProfile.id}`, {
      key: w.a.keys.manageSetup.secret,
      body: { name: "House voice", content, baseVersion: 2 },
    });
    expect(r.status).toBe(409);
    const profiles = await listVoiceProfiles(w.a.scope);
    expect(profiles.find((p) => p.id === w.a.voiceProfile.id)!.currentVersion).toBe(1);
  });

  it("answers 200 with the same version and appends nothing for an identical name and content", async () => {
    const w = await world();
    const { current: before } = await getVoiceProfile(w.a.scope, w.a.voiceProfile.id);
    const r = await api("PATCH", `/voice-profiles/${w.a.voiceProfile.id}`, {
      key: w.a.keys.manageSetup.secret,
      body: { name: w.a.voiceProfile.name, content: before.content, baseVersion: 1 },
    });
    expect(r.status).toBe(200);
    expect(r.json.version).toBe(1);
    const profiles = await listVoiceProfiles(w.a.scope);
    expect(profiles.find((p) => p.id === w.a.voiceProfile.id)!.currentVersion).toBe(1);
  });

  it("answers 409 for an archived profile, telling the caller to restore it first", async () => {
    const w = await world();
    const extra = await createVoiceProfileFactory(w.a.project.id, { name: "Side voice" });
    await archiveVoiceProfile(w.a.scope, extra.id);
    const r = await api("PATCH", `/voice-profiles/${extra.id}`, {
      key: w.a.keys.manageSetup.secret,
      body: { name: "Side voice", content, baseVersion: 1 },
    });
    expect(r.status).toBe(409);
    expect(r.json.error.message).toMatch(/restore/i);
  });

  it("answers byte-identical 404s for another project's profile id and a random UUID", async () => {
    const w = await world();
    const random = "00000000-0000-4000-8000-0000000000ab";
    const other = await api("PATCH", `/voice-profiles/${w.b.voiceProfile.id}`, {
      key: w.a.keys.manageSetup.secret,
      body: { name: "House voice", content, baseVersion: 1 },
    });
    const unknown = await api("PATCH", `/voice-profiles/${random}`, {
      key: w.a.keys.manageSetup.secret,
      body: { name: "House voice", content, baseVersion: 1 },
    });
    expect(other.status).toBe(404);
    const strip = (r: typeof other) => ({ code: r.json.error.code, message: r.json.error.message, details: r.json.error.details });
    expect(strip(other)).toEqual(strip(unknown));
  });

  it("answers 403 for a key lacking manage_setup", async () => {
    const w = await world();
    const r = await api("PATCH", `/voice-profiles/${w.a.voiceProfile.id}`, {
      key: w.a.keys.read.secret,
      body: { name: "House voice", content, baseVersion: 1 },
    });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("missing_permission");
    expect(r.json.error.details).toEqual({ permission: "manage_setup" });
  });

  it("replays the stored response for a repeated Idempotency-Key and appends nothing new", async () => {
    const env = await postsEnv();
    const key = (await createKey(env.scope, ["manage_setup"], { rateLimitPerMinute: 1000 })).secret;
    const profile = await createVoiceProfileFactory(env.project.id, { name: "Replay voice" });
    const body = { name: "Replay voice", content, baseVersion: 1 };
    const first = await api("PATCH", `/voice-profiles/${profile.id}`, { key, idem: "voice-patch-1", body });
    expect(first.status).toBe(200);
    const second = await api("PATCH", `/voice-profiles/${profile.id}`, { key, idem: "voice-patch-1", body });
    expect(second.status).toBe(200);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(second.json).toEqual(first.json);
  });
});
