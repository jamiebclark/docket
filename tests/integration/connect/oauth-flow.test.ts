import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { socialAccounts } from "../../../src/server/db/schema/accounts";
import { ForbiddenError } from "../../../src/server/dal/errors";
import { decryptCredentials } from "../../../src/server/services/accounts";
import * as accounts from "../../../src/server/services/accounts";
import * as connect from "../../../src/server/services/connect";
import { closeDb, testDb } from "../../helpers/db";
import { pageCandidate, readyAttempt, registerThrowaway, sessionFor, unregisterThrowaway } from "../../helpers/connect-group";
import { postsEnv } from "../../helpers/posts-env";

beforeAll(registerThrowaway);
afterAll(async () => {
  unregisterThrowaway();
  await closeDb();
});

describe("start", () => {
  it("returns the dialog URL with a state and the fixed callback", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    const { url } = await connect.startOAuthConnect(env.scope, { groupKey: "throwaway" }, session);
    const u = new URL(url);
    expect(u.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get("redirect_uri")).toMatch(/\/connect\/callback$/);
    const groups = await connect.listConnectGroups(env.scope);
    expect(groups.find((g) => g.key === "throwaway")).toMatchObject({
      configured: true,
      providerNames: ["Throwaway Page", "Throwaway Photo"],
    });
  });

  it("refuses editors and unknown groups", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.editor.id);
    await expect(connect.startOAuthConnect(await env.as(env.editor), { groupKey: "throwaway" }, session)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(connect.startOAuthConnect(env.scope, { groupKey: "nope" }, await sessionFor(env.owner.id))).rejects.toThrow();
  });
});

describe("chooser save", () => {
  it("creates both accounts with the Page token, and not the unticked ones", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    const id = await readyAttempt(env.scope, session, [...pageCandidate("100", "Acme"), ...pageCandidate("101", "Beta")]);
    const choice = await connect.getConnectChoice(env.scope, id, session);
    expect(choice?.candidates.map((c) => c.key)).toEqual(["tw-page:100", "tw-photo:1009", "tw-page:101", "tw-photo:1019"]);
    expect(JSON.stringify(choice)).not.toContain("PAGE-TOKEN");
    const r = await connect.chooseConnectCandidates(env.scope, { attemptId: id, selected: ["tw-page:100", "tw-photo:1009"] }, session);
    expect(r.ok && r.saved.map((a) => a.providerKey).sort()).toEqual(["tw-page", "tw-photo"]);
    const rows = await testDb().select().from(socialAccounts).where(eq(socialAccounts.projectId, env.project.id));
    expect(rows.map((x) => x.externalAccountId).sort()).toEqual(["100", "1009"]);
    const page = rows.find((x) => x.externalAccountId === "100")!;
    expect(decryptCredentials(page.id, page.credentialsEncrypted)).toEqual({ pageToken: "PAGE-TOKEN-100" });
    // single use
    const again = await connect.chooseConnectCandidates(env.scope, { attemptId: id, selected: ["tw-page:100"] }, session);
    expect(again.ok).toBe(false);
    expect(await connect.getConnectChoice(env.scope, id, session)).toBeNull();
  });

  it("updates an existing account in place, reactivates it and clears the error", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    const first = await readyAttempt(env.scope, session, pageCandidate("100", "Acme", false));
    await connect.chooseConnectCandidates(env.scope, { attemptId: first, selected: ["tw-page:100"] }, session);
    const [row] = await testDb().select().from(socialAccounts).where(eq(socialAccounts.projectId, env.project.id));
    await testDb()
      .update(socialAccounts)
      .set({ status: "needs_reauth", lastError: "expired" })
      .where(and(eq(socialAccounts.projectId, env.project.id), eq(socialAccounts.id, row!.id)));
    const second = await readyAttempt(env.scope, session, pageCandidate("100", "Acme renamed", false));
    const choice = await connect.getConnectChoice(env.scope, second, session);
    expect(choice?.candidates[0]?.state).toBe("needs_reauth");
    const r = await connect.chooseConnectCandidates(env.scope, { attemptId: second, selected: ["tw-page:100"] }, session);
    expect(r.ok && r.saved[0]).toMatchObject({ id: row!.id, status: "active", lastError: null, displayName: "Acme renamed" });
    expect(await accounts.listAccounts(env.scope)).toHaveLength(1);
  });

  it("says nothing was connected when nothing is ticked", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    const id = await readyAttempt(env.scope, session, pageCandidate("100", "Acme"));
    expect(await connect.chooseConnectCandidates(env.scope, { attemptId: id, selected: [] }, session)).toEqual({
      ok: false,
      message: "Nothing was connected.",
    });
  });

  it("refuses editors, another session and another user", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    const id = await readyAttempt(env.scope, session, pageCandidate("100", "Acme"));
    await expect(
      connect.chooseConnectCandidates(await env.as(env.editor), { attemptId: id, selected: ["tw-page:100"] }, await sessionFor(env.editor.id)),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const other = await connect.chooseConnectCandidates(env.scope, { attemptId: id, selected: ["tw-page:100"] }, await sessionFor(env.owner.id));
    expect(other.ok).toBe(false);
    const asAdmin = await connect.chooseConnectCandidates(await env.as(env.admin), { attemptId: id, selected: ["tw-page:100"] }, await sessionFor(env.admin.id));
    expect(asAdmin.ok).toBe(false);
    expect(await accounts.listAccounts(env.scope)).toHaveLength(0);
  });

  it("lists needs_reauth accounts that this login did not return", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    const a = await readyAttempt(env.scope, session, pageCandidate("100", "Acme", false));
    await connect.chooseConnectCandidates(env.scope, { attemptId: a, selected: ["tw-page:100"] }, session);
    await testDb().update(socialAccounts).set({ status: "needs_reauth" }).where(eq(socialAccounts.projectId, env.project.id));
    const b = await readyAttempt(env.scope, session, pageCandidate("200", "Other", false));
    const choice = await connect.getConnectChoice(env.scope, b, session);
    expect(choice?.missing).toEqual([{ accountId: expect.any(String), displayName: "Acme", providerName: "Throwaway Page" }]);
  });
});
