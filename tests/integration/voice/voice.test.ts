import { afterAll, describe, expect, it } from "vitest";
import { ConflictError, ForbiddenError, NotFoundError } from "../../../src/server/dal/errors";
import { forProject } from "../../../src/server/dal/scope";
import * as voice from "../../../src/server/services/voice";
import { fakeSession } from "../../helpers/auth";
import { closeDb } from "../../helpers/db";
import { createProject, createUser } from "../../helpers/factories";
import { postsEnv } from "../../helpers/posts-env";

afterAll(closeDb);

const content = (over: Record<string, unknown> = {}) => ({ voiceAndTone: "Warm", ...over });
const make = (scope: Awaited<ReturnType<typeof postsEnv>>["scope"], name = "Brand") =>
  voice.createVoiceProfile(scope, { name, content: content() });

describe("voice profiles", () => {
  it("creates v1, makes the first profile the default, and versions on edit", async () => {
    const env = await postsEnv();
    const { profileId } = await make(env.scope);
    const first = await voice.getVoiceProfile(env.scope, profileId);
    expect(first.isDefault).toBe(true);
    expect(first.current.version).toBe(1);
    const v1 = JSON.stringify(first.current.content);

    const saved = await voice.saveVoiceProfile(env.scope, profileId, { name: "Brand", content: content({ voiceAndTone: "Bold" }), baseVersion: 1 });
    expect(saved.version).toBe(2);
    expect(JSON.stringify((await voice.getVersion(env.scope, profileId, 1)).content)).toBe(v1);
    expect((await voice.getVoiceProfile(env.scope, profileId)).current.version).toBe(2);
    const history = await voice.listVersions(env.scope, profileId);
    expect(history.map((h) => h.version)).toEqual([2, 1]);
    expect(history[0]!.authorName).toBeTruthy();

    const second = await make(env.scope, "Second");
    expect((await voice.getVoiceProfile(env.scope, second.profileId)).isDefault).toBe(false);
  });

  it("refuses a stale baseVersion without writing, and treats an identical save as a no-op", async () => {
    const env = await postsEnv();
    const { profileId } = await make(env.scope);
    await voice.saveVoiceProfile(env.scope, profileId, { name: "Brand", content: content({ audience: "x" }), baseVersion: 1 });
    await expect(
      voice.saveVoiceProfile(env.scope, profileId, { name: "Brand", content: content({ audience: "y" }), baseVersion: 1 }),
    ).rejects.toThrow(new ConflictError("This profile changed since you opened it"));
    expect((await voice.listVersions(env.scope, profileId)).length).toBe(2);

    const same = await voice.saveVoiceProfile(env.scope, profileId, { name: "Brand", content: content({ audience: "x" }), baseVersion: 2 });
    expect(same.version).toBe(2);
    expect((await voice.listVersions(env.scope, profileId)).length).toBe(2);
  });

  it("strips platformGuidance from input, and an unchanged save of a pre-upgrade version is a no-op", async () => {
    const env = await postsEnv();
    const { profileId } = await make(env.scope, "Legacy");
    await voice.saveVoiceProfile(env.scope, profileId, {
      name: "Legacy",
      content: content({ audience: "x", platformGuidance: { bluesky: "short" } }),
      baseVersion: 1,
    });
    expect((await voice.getVersion(env.scope, profileId, 2)).content.platformGuidance).toEqual({});

    // A version written before the upgrade still carries its guidance, untouched.
    await env.scope.transaction(async (tx) => {
      await tx.voiceVersions.insert({
        profileId,
        version: 3,
        content: { v: 1, voiceAndTone: "Warm", audience: "x", platformGuidance: { bluesky: "old" } },
        authorUserId: tx.membership.userId,
      });
      await tx.voiceProfiles.setCurrentVersion(profileId, 3);
    });
    const same = await voice.saveVoiceProfile(env.scope, profileId, { name: "Legacy", content: content({ audience: "x" }), baseVersion: 3 });
    expect(same.version).toBe(3);
    expect((await voice.listVersions(env.scope, profileId)).length).toBe(3);
    expect((await voice.getVersion(env.scope, profileId, 3)).content.platformGuidance).toEqual({ bluesky: "old" });
  });

  it("a rename alone creates a new version", async () => {
    const env = await postsEnv();
    const { profileId } = await make(env.scope);
    const res = await voice.saveVoiceProfile(env.scope, profileId, { name: "Renamed", content: content(), baseVersion: 1 });
    expect(res.version).toBe(2);
    expect((await voice.getVoiceProfile(env.scope, profileId)).profile.name).toBe("Renamed");
  });

  it("manages default, archive and restore", async () => {
    const env = await postsEnv();
    const a = await make(env.scope, "Alpha");
    const b = await make(env.scope, "Beta");
    await expect(voice.archiveVoiceProfile(env.scope, a.profileId)).rejects.toThrow("Make another profile the default first");
    await voice.archiveVoiceProfile(env.scope, b.profileId);
    await expect(voice.setDefaultVoiceProfile(env.scope, b.profileId)).rejects.toBeInstanceOf(ConflictError);
    expect((await voice.listVoiceProfiles(env.scope)).map((p) => p.name)).toEqual(["Alpha"]);
    expect((await voice.listVoiceProfiles(env.scope, { includeArchived: true })).map((p) => p.name)).toEqual(["Alpha", "Beta"]);
    expect((await voice.getVersion(env.scope, b.profileId, 1)).version).toBe(1);

    await make(env.scope, "beta");
    await expect(voice.restoreVoiceProfile(env.scope, b.profileId)).rejects.toThrow("A profile with this name already exists");
    await expect(make(env.scope, "ALPHA")).rejects.toThrow("A profile with this name already exists");

    await voice.setDefaultVoiceProfile(env.scope, (await voice.listVoiceProfiles(env.scope)).find((p) => p.name === "beta")!.id);
    await voice.archiveVoiceProfile(env.scope, a.profileId);
    expect((await voice.listVoiceProfiles(env.scope)).map((p) => p.name)).toEqual(["beta"]);
  });

  it("lets editors read but not change anything; strangers and other projects get not found", async () => {
    const env = await postsEnv();
    const { profileId } = await make(env.scope);
    const editor = await env.as(env.editor);
    expect((await voice.listVoiceProfiles(editor)).length).toBe(1);
    expect((await voice.getVoiceProfile(editor, profileId)).current.version).toBe(1);
    expect((await voice.listVersions(editor, profileId)).length).toBe(1);
    expect((await voice.getVersion(editor, profileId, 1)).version).toBe(1);
    const forbidden = [
      voice.createVoiceProfile(editor, { name: "X", content: content() }),
      voice.saveVoiceProfile(editor, profileId, { name: "Brand", content: content({ audience: "z" }), baseVersion: 1 }),
      voice.setDefaultVoiceProfile(editor, profileId),
      voice.archiveVoiceProfile(editor, profileId),
      voice.restoreVoiceProfile(editor, profileId),
    ];
    for (const p of forbidden) await expect(p).rejects.toBeInstanceOf(ForbiddenError);

    const other = await postsEnv();
    await expect(voice.getVoiceProfile(other.scope, profileId)).rejects.toBeInstanceOf(NotFoundError);
    const stranger = await createUser();
    await expect(forProject(fakeSession(stranger.id), env.project.slug)).rejects.toBeInstanceOf(NotFoundError);
    await createProject();
  });

  it("lets exactly one of two concurrent saves from the same baseVersion win", async () => {
    const env = await postsEnv();
    const { profileId } = await make(env.scope);
    const results = await Promise.allSettled([
      voice.saveVoiceProfile(env.scope, profileId, { name: "Brand", content: content({ audience: "a" }), baseVersion: 1 }),
      voice.saveVoiceProfile(env.scope, profileId, { name: "Brand", content: content({ audience: "b" }), baseVersion: 1 }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((await voice.listVersions(env.scope, profileId)).length).toBe(2);
  });
});
