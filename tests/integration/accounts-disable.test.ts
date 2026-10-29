import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { runCrossProject } from "../../src/server/db/cross-project";
import { membershipAuditLog, socialAccounts } from "../../src/server/db/schema";
import { ForbiddenError, NotFoundError } from "../../src/server/dal/errors";
import { forSchedulerProject } from "../../src/server/dal/scheduler";
import * as accounts from "../../src/server/services/accounts";
import * as posts from "../../src/server/services/posts";
import { runTick } from "../../src/server/scheduler";
import { closeDb, testDb } from "../helpers/db";
import { createDueTarget, parkAllDueTargets } from "../helpers/scheduling";
import { postsEnv } from "../helpers/posts-env";
import { tickConfig } from "../helpers/tick";

beforeEach(parkAllDueTargets);
afterAll(closeDb);

type Env = Awaited<ReturnType<typeof postsEnv>>;

const auditActions = (projectId: string) =>
  runCrossProject("test", async () =>
    (await testDb().select().from(membershipAuditLog).where(eq(membershipAuditLog.projectId, projectId)))
      .filter((r) => r.action === "account_disable" || r.action === "account_enable")
      .map((r) => r.action),
  );

const stored = (projectId: string, id: string) =>
  runCrossProject("test", async () => {
    const [row] = await testDb()
      .select()
      .from(socialAccounts)
      .where(and(eq(socialAccounts.projectId, projectId), eq(socialAccounts.id, id)));
    return row!;
  });

const view = async (env: Env, id: string) => (await accounts.listAccounts(env.scope)).find((a) => a.id === id)!;

const breakCredentials = (projectId: string, id: string) =>
  forSchedulerProject(projectId).accounts.markCredentialsInvalid(id, {
    expectedCiphertext: null,
    reason: "Token rejected.",
  });

describe("disabling an account", () => {
  it("reports disabled, leaves the stored status alone, and audits once", async () => {
    const env = await postsEnv();
    const a = await env.account();
    expect((await view(env, a.id)).status).toBe("active");

    const out = await accounts.setAccountDisabled(env.scope, a.id, true);
    expect(out.changed).toBe(true);
    expect(out.account.status).toBe("disabled");
    expect(out.account.disabledAt).toBeInstanceOf(Date);

    // Only `disabled_at` moved: the enum still says what it believes about the credentials, and the
    // account is not removed, so nothing cleared its tokens.
    const row = await stored(env.project.id, a.id);
    expect(row.status).toBe("active");
    expect(row.disabledAt).toBeInstanceOf(Date);
    expect(row.removedAt).toBeNull();

    expect((await view(env, a.id)).status).toBe("disabled");
    expect(await auditActions(env.project.id)).toEqual(["account_disable"]);
  });

  it("is idempotent: a second disable changes nothing and audits nothing", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const first = await accounts.setAccountDisabled(env.scope, a.id, true);
    const second = await accounts.setAccountDisabled(env.scope, a.id, true);
    expect(second.changed).toBe(false);
    expect(second.account.disabledAt).toEqual(first.account.disabledAt);
    expect(await auditActions(env.project.id)).toEqual(["account_disable"]);
  });

  it("enables again, audits the other way, and clears disabledAt", async () => {
    const env = await postsEnv();
    const a = await env.account();
    await accounts.setAccountDisabled(env.scope, a.id, true);
    const out = await accounts.setAccountDisabled(env.scope, a.id, false);
    expect(out.changed).toBe(true);
    expect(out.account.status).toBe("active");
    expect(out.account.disabledAt).toBeNull();
    expect(await auditActions(env.project.id)).toEqual(["account_disable", "account_enable"]);
  });

  it("hands back needs_reauth on enable rather than claiming the account reconnected itself", async () => {
    const env = await postsEnv();
    const a = await env.account();
    await breakCredentials(env.project.id, a.id);
    expect((await view(env, a.id)).status).toBe("needs_reauth");

    await accounts.setAccountDisabled(env.scope, a.id, true);
    const off = await view(env, a.id);
    expect(off.status).toBe("disabled");
    // Still visible underneath, which is what the accounts page offers the reconnect from.
    expect(off.authStatus).toBe("needs_reauth");
    expect(off.lastError).toBe("Token rejected.");

    await accounts.setAccountDisabled(env.scope, a.id, false);
    const back = await view(env, a.id);
    expect(back.status).toBe("needs_reauth");
    expect(back.lastError).toBe("Token rejected.");
  });

  it("stops a broken disabled account from asking to be reconnected", async () => {
    const env = await postsEnv();
    const a = await env.account();
    await breakCredentials(env.project.id, a.id);
    expect(await accounts.listAccountsNeedingReauth(env.scope)).toHaveLength(1);
    await accounts.setAccountDisabled(env.scope, a.id, true);
    expect(await accounts.listAccountsNeedingReauth(env.scope)).toEqual([]);
  });

  it("counts the scheduled posts a disable would hold", async () => {
    const env = await postsEnv();
    const a = await env.account();
    expect(await accounts.accountDisableImpact(env.scope, a.id)).toEqual({ queuedPosts: 0 });
    await createDueTarget(env.project.id, a.id);
    expect(await accounts.accountDisableImpact(env.scope, a.id)).toEqual({ queuedPosts: 1 });
  });

  it("refuses a member who cannot manage accounts, an unknown account and a removed one", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const editor = await env.as(env.editor);
    await expect(accounts.setAccountDisabled(editor, a.id, true)).rejects.toThrow(ForbiddenError);
    await expect(accounts.setAccountDisabled(env.scope, "00000000-0000-0000-0000-000000000000", true)).rejects.toThrow(
      NotFoundError,
    );
    await accounts.removeAccount(env.scope, a.id);
    await expect(accounts.setAccountDisabled(env.scope, a.id, true)).rejects.toThrow(NotFoundError);
  });
});

describe("a disabled account cannot be posted to", () => {
  it("refuses an explicit schedule, saying disabled rather than needs reconnecting", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const detail = await posts.createDraft(env.scope, { baseText: "Hello", targets: [{ accountId: a.id }] });
    await accounts.setAccountDisabled(env.scope, a.id, true);

    const results = await posts.publishNow(env.scope, detail.post.id);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: false, code: "account_unavailable" });
    const message = results[0]!.ok ? "" : results[0]!.message;
    expect(message).toContain("is disabled");
    expect(message).not.toContain("needs to be reconnected");
  });

  it("is not offered by the composer check", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const before = await posts.checkComposition(env.scope, { baseText: "Hello", targets: [{ accountId: a.id }] });
    expect(before.targets[0]).toMatchObject({ canSchedule: true });
    await accounts.setAccountDisabled(env.scope, a.id, true);
    const after = await posts.checkComposition(env.scope, { baseText: "Hello", targets: [{ accountId: a.id }] });
    expect(after.targets[0]).toMatchObject({ canSchedule: false });
  });
});

describe("scheduled posts are held, not failed", () => {
  it("leaves the target scheduled, with no attempt, then publishes it once enabled", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const { target } = await createDueTarget(env.project.id, a.id);
    await accounts.setAccountDisabled(env.scope, a.id, true);

    const first = await runTick(tickConfig({}));
    expect(first.publishing.counts).toMatchObject({ heldDisabled: 1, done: 0, failed: 0 });

    const repos = forSchedulerProject(env.project.id);
    const held = await repos.targets.get(target.id);
    expect(held).toMatchObject({ status: "scheduled", attemptCount: 0, lastError: null });
    // Pushed out, so the following ticks do not re-walk it every time.
    expect(held!.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await repos.attempts.listForTarget(target.id)).toHaveLength(0);

    const enabled = await accounts.setAccountDisabled(env.scope, a.id, false);
    expect(enabled.releasedTargets).toBe(1);
    expect((await repos.targets.get(target.id))!.nextAttemptAt!.getTime()).toBeLessThanOrEqual(Date.now());

    const second = await runTick(tickConfig({}));
    expect(second.publishing.counts).toMatchObject({ done: 1, heldDisabled: 0 });
    expect((await repos.targets.get(target.id))!.status).toBe("published");
  });

  it("leaves a target whose turn has not come round yet at its own time", async () => {
    const env = await postsEnv();
    const a = await env.account();
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const { target } = await createDueTarget(env.project.id, a.id, { dueAt: future });
    await accounts.setAccountDisabled(env.scope, a.id, true);
    const out = await accounts.setAccountDisabled(env.scope, a.id, false);
    expect(out.releasedTargets).toBe(0);
    expect((await forSchedulerProject(env.project.id).targets.get(target.id))!.nextAttemptAt).toEqual(future);
  });
});
