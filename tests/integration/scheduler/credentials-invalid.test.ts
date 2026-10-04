import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { PublishContext, SocialProvider, StepResult } from "../../../src/providers/types";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { runTick } from "../../../src/server/scheduler";
import { encryptCredentials } from "../../../src/server/services/accounts";
import { closeDb } from "../../helpers/db";
import { createProject } from "../../helpers/factories";
import { blueskyLikeProvider, registerTestProvider } from "../../helpers/provider-fixtures";
import { createDueTarget, createMockAccount, parkAllDueTargets } from "../../helpers/scheduling";

// A throwaway provider: tests replace `script.advance`. No Meta code.
const script = {
  advance: async (_ctx: PublishContext): Promise<StepResult> => ({ kind: "done", externalId: "x" }),
};
let advanceCalls = 0;

registerTestProvider({
  ...blueskyLikeProvider,
  key: "scripted-invalid",
  displayName: "Scripted invalid",
  advance: async (ctx: PublishContext) => {
    advanceCalls++;
    return script.advance(ctx);
  },
} as SocialProvider);

const defaults = { ...script };
beforeEach(async () => {
  await parkAllDueTargets();
  Object.assign(script, defaults);
  advanceCalls = 0;
});
afterAll(closeDb);

async function setup() {
  const project = await createProject();
  const repos = forSchedulerProject(project.id);
  const account = await createMockAccount(project.id, {}, { providerKey: "scripted-invalid", displayName: "Docket Page" });
  await repos.accounts.setCredentials(account.id, encryptCredentials(account.id, { pageToken: "old-token" }), null);
  const { target } = await createDueTarget(project.id, account.id);
  return { project, repos, account, target };
}

describe("fatal_error with credentialsInvalid (G7)", () => {
  it("flags the account needs_reauth, fails the target with the reconnect message, and never retries", async () => {
    const { repos, account, target } = await setup();
    script.advance = async () => ({ kind: "fatal_error", error: "Session has expired (code 190)", credentialsInvalid: true });
    const tick = await runTick({ config: {} });
    expect(tick.publishing.counts).toMatchObject({ failed: 1, retried: 0, ambiguous: 0 });
    expect(advanceCalls).toBe(1);
    const row = await repos.targets.get(target.id);
    expect(row).toMatchObject({ status: "failed", nextAttemptAt: null });
    expect(row?.lastError).toBe("Reconnect Docket Page to publish: Session has expired (code 190)");
    expect(await repos.accounts.get(account.id)).toMatchObject({
      status: "needs_reauth",
      lastError: "Session has expired (code 190)",
    });
    expect((await repos.attempts.listForTarget(target.id)).map((a) => a.outcome)).toEqual(["fatal_error"]);
    expect(await repos.accounts.listNeedingReauth()).toEqual([
      expect.objectContaining({ id: account.id, providerKey: "scripted-invalid" }),
    ]);
  });

  it("does not claim another due target of the account afterwards", async () => {
    const { project, repos, account } = await setup();
    script.advance = async () => ({ kind: "fatal_error", error: "dead", credentialsInvalid: true });
    await runTick({ config: {} });
    const { target: second } = await createDueTarget(project.id, account.id);
    const tick = await runTick({ config: {} });
    expect(tick.publishing.counts).toMatchObject({ failed: 1 });
    expect(advanceCalls).toBe(1);
    expect(await repos.targets.get(second.id)).toMatchObject({ status: "failed" });
    expect((await repos.attempts.listForTarget(second.id)).map((a) => a.outcome)).toContain("account_unavailable");
  });

  it("does not overwrite a reconnect committed while the step ran", async () => {
    const { repos, account, target } = await setup();
    script.advance = async () => {
      await repos.accounts.setCredentials(account.id, encryptCredentials(account.id, { pageToken: "reconnected" }), null);
      return { kind: "fatal_error", error: "old token rejected", credentialsInvalid: true };
    };
    await runTick({ config: {} });
    expect(await repos.accounts.get(account.id)).toMatchObject({ status: "active", lastError: null });
    expect(await repos.targets.get(target.id)).toMatchObject({ status: "failed" });
  });

  it("is failed, not ambiguous, for a step that may publish", async () => {
    const { repos, target } = await setup();
    script.advance = async (ctx) => {
      expect(ctx.step.mayPublish).toBe(true);
      return { kind: "fatal_error", error: "dead", credentialsInvalid: true };
    };
    const tick = await runTick({ config: {} });
    expect(tick.publishing.counts).toMatchObject({ failed: 1, ambiguous: 0 });
    expect(await repos.targets.get(target.id)).toMatchObject({ status: "failed" });
  });

  it("leaves the account active for a fatal_error without the flag", async () => {
    const { repos, account, target } = await setup();
    script.advance = async () => ({ kind: "fatal_error", error: "bad request" });
    await runTick({ config: {} });
    expect(await repos.accounts.get(account.id)).toMatchObject({ status: "active", lastError: null });
    expect(await repos.targets.get(target.id)).toMatchObject({ status: "failed", lastError: "bad request" });
  });
});
