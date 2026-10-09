import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { deriveChecklist } from "../../../src/lib/overview/derive";
import * as accounts from "../../../src/server/services/accounts";
import { getOverview } from "../../../src/server/services/overview";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";
import { createDueTarget } from "../../helpers/scheduling";

afterAll(async () => {
  await closeDb();
});

describe("getOverview", () => {
  it("reads facts for an empty project and leaves conditional reads out", async () => {
    const env = await postsEnv();
    const facts = await getOverview(env.scope);
    expect(facts.project.slug).toBe(env.project.slug);
    expect(facts.viewer.role).toBe("owner");
    expect(facts.accounts).toEqual([]);
    expect(facts.postCounts.scheduled ?? 0).toBe(0);
    // AI and storage aren't configured in tests, so their reads are skipped (null, not 0).
    if (!facts.ai.configured) expect(facts.ai.voiceProfiles).toBeNull();
    if (!facts.storage.configured) expect(facts.storage.libraryItems).toBeNull();
    expect(deriveChecklist(facts)?.mode).toBe("full");
  });

  it("reflects an account, a slot and a scheduled post, and re-expands when the account is removed", async () => {
    const env = await postsEnv();
    const account = await env.account();
    await createDueTarget(env.project.id, account.id, { dueAt: new Date(Date.now() + 3_600_000) });

    const facts = await getOverview(env.scope);
    expect(facts.accounts).toHaveLength(1);
    expect(facts.accounts[0]?.slots.active).toBe(1);
    expect(facts.postCounts.scheduled).toBe(1);
    expect(facts.upcoming).toHaveLength(1);
    // Required steps are all done, so nothing but the owner's server-setup row can remain.
    expect(deriveChecklist(facts)?.steps ?? []).toEqual([]);

    await accounts.removeAccount(env.scope, account.id);
    const after = await getOverview(env.scope);
    expect(after.accounts).toEqual([]);
    const view = deriveChecklist(after);
    expect(view?.mode).toBe("full");
    expect(view?.steps.filter((s) => !s.optional).map((s) => s.status.kind)).toEqual(["todo", "todo", expect.anything()]);
  });

  it("serialises none of the member emails, no @-addresses and no env var names (SC-003)", async () => {
    const env = await postsEnv();
    await env.account();
    const json = JSON.stringify(await getOverview(env.scope));
    for (const member of [env.owner, env.admin, env.editor]) {
      if (member && "email" in member && typeof member.email === "string") expect(json).not.toContain(member.email);
    }
    expect(json).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(json).not.toMatch(/\b[A-Z][A-Z0-9]+_[A-Z0-9_]{2,}\b/);
  });
});
