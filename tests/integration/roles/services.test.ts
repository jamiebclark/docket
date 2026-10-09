import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getLlmStatus, missingLlmSettings } from "../../../src/server/llm";
import { getGenerationReadiness } from "../../../src/server/services/generation/readiness";
import { listManagers } from "../../../src/server/services/members";
import * as posts from "../../../src/server/services/posts";
import * as slots from "../../../src/server/services/slots";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});

describe("role-awareness services", () => {
  it("listManagers returns owners then admins, with no emails or ids", async () => {
    const env = await postsEnv();
    const managers = await listManagers(await env.as(env.editor));
    expect(managers.map((m) => m.role)).toEqual(["owner", "admin"]);
    for (const m of managers) expect(Object.keys(m).sort()).toEqual(["name", "role"]);
    expect(JSON.stringify(managers)).not.toContain("@");
  });

  it("listSlotCounts counts a paused slot as not active", async () => {
    const env = await postsEnv();
    const withSlot = await env.account();
    const without = await env.account({}, false);
    const [slot] = await slots.listSlots(env.scope, withSlot.id);
    const byId = async () => new Map((await slots.listSlotCounts(env.scope)).map((c) => [c.accountId, c]));

    let counts = await byId();
    expect(counts.get(withSlot.id)).toMatchObject({ active: 1, paused: 0, providerAvailable: true });
    expect(counts.get(without.id)).toMatchObject({ active: 0, paused: 0 });

    await slots.setSlotPaused(env.scope, slot!.id, true);
    counts = await byId();
    expect(counts.get(withSlot.id)).toMatchObject({ active: 0, paused: 1 });
  });

  it("countPosts is 0 for an empty project and 1 after one draft", async () => {
    const env = await postsEnv();
    expect(await posts.countPosts(env.scope)).toBe(0);
    const account = await env.account();
    await posts.createDraft(env.scope, { baseText: "Hello", targets: [{ accountId: account.id }] });
    expect(await posts.countPosts(env.scope)).toBe(1);
  });

  it("getGenerationReadiness names missing settings to an owner only", async () => {
    const env = await postsEnv();
    const status = getLlmStatus();
    const owner = await getGenerationReadiness(env.scope);
    const admin = await getGenerationReadiness(await env.as(env.admin));
    const editor = await getGenerationReadiness(await env.as(env.editor));
    expect(owner).toMatchObject({ accounts: 0, voiceProfiles: 0 });
    if (status.configured) {
      expect(owner.ai).toEqual({ configured: true, missingSettings: null });
    } else {
      expect(owner.ai.missingSettings).toEqual(missingLlmSettings(status.problems));
      expect(admin.ai).toEqual({ configured: false, missingSettings: null });
      expect(editor.ai).toEqual({ configured: false, missingSettings: null });
    }
  });
});
