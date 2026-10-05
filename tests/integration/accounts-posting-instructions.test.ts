import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ZodError } from "zod";
import { ForbiddenError, NotFoundError } from "../../src/server/dal/errors";
import { runCrossProject } from "../../src/server/db/cross-project";
import { membershipAuditLog } from "../../src/server/db/schema";
import * as accounts from "../../src/server/services/accounts";
import { closeDb, testDb } from "../helpers/db";
import { postsEnv } from "../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});

const ACTION = "account_posting_instructions_update";
const auditRows = (projectId: string) =>
  runCrossProject("test", async () =>
    (await testDb().select().from(membershipAuditLog).where(eq(membershipAuditLog.projectId, projectId))).filter(
      (r) => r.action === ACTION,
    ),
  );
const stored = async (env: Awaited<ReturnType<typeof postsEnv>>, id: string) =>
  (await accounts.listAccounts(env.scope)).find((a) => a.id === id)!.postingInstructions;

describe("account posting instructions", () => {
  it("lets an owner save, normalising CRLF and surrounding spaces, with one audit row", async () => {
    const env = await postsEnv();
    const a = await env.account({}, false);
    expect(a.postingInstructions).toBeNull();
    const out = await accounts.setPostingInstructions(env.scope, a.id, { instructions: "  Two hashtags.\r\nNo link.  \r\n" });
    expect(out).toEqual({ changed: true, instructions: "Two hashtags.\nNo link." });
    expect(await stored(env, a.id)).toBe("Two hashtags.\nNo link.");
    const rows = await auditRows(env.project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorUserId).toBe(env.owner.id);
    expect(rows[0]!.details).toEqual({
      accountId: a.id,
      displayName: a.displayName,
      previous: null,
      next: "Two hashtags.\nNo link.",
    });
  });

  it("lets an admin save", async () => {
    const env = await postsEnv();
    const a = await env.account({}, false);
    const admin = await env.as(env.admin);
    expect((await accounts.setPostingInstructions(admin, a.id, { instructions: "Short." })).changed).toBe(true);
    expect((await auditRows(env.project.id))[0]!.actorUserId).toBe(env.admin.id);
  });

  it("treats the same text again as no change, with no audit row", async () => {
    const env = await postsEnv();
    const a = await env.account({}, false);
    await accounts.setPostingInstructions(env.scope, a.id, { instructions: "Same" });
    const again = await accounts.setPostingInstructions(env.scope, a.id, { instructions: " Same\r\n" });
    expect(again.changed).toBe(false);
    expect(await auditRows(env.project.id)).toHaveLength(1);
  });

  it("clears to NULL and audits it; clearing nothing is a no-op", async () => {
    const env = await postsEnv();
    const a = await env.account({}, false);
    expect((await accounts.setPostingInstructions(env.scope, a.id, { instructions: "   " })).changed).toBe(false);
    await accounts.setPostingInstructions(env.scope, a.id, { instructions: "Rule" });
    const cleared = await accounts.setPostingInstructions(env.scope, a.id, { instructions: "" });
    expect(cleared).toEqual({ changed: true, instructions: null });
    expect(await stored(env, a.id)).toBeNull();
    const rows = await auditRows(env.project.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => (r.details as { next: unknown }).next)).toContain(null);
  });

  it("refuses 2,001 characters and accepts 2,000", async () => {
    const env = await postsEnv();
    const a = await env.account({}, false);
    const err = await accounts.setPostingInstructions(env.scope, a.id, { instructions: "x".repeat(2001) }).catch((e) => e);
    expect(err).toBeInstanceOf(ZodError);
    expect((err as ZodError).issues[0]!.message).toBe("Keep posting instructions to 2,000 characters or fewer");
    expect((err as ZodError).issues[0]!.path).toEqual(["instructions"]);
    expect(await stored(env, a.id)).toBeNull();
    expect((await accounts.setPostingInstructions(env.scope, a.id, { instructions: "x".repeat(2000) })).changed).toBe(true);
  });

  it("refuses an editor and changes nothing", async () => {
    const env = await postsEnv();
    const a = await env.account({}, false);
    const editor = await env.as(env.editor);
    await expect(accounts.setPostingInstructions(editor, a.id, { instructions: "Nope" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await stored(env, a.id)).toBeNull();
    expect(await auditRows(env.project.id)).toHaveLength(0);
    // Editors can still read them.
    expect((await accounts.listAccounts(editor)).find((x) => x.id === a.id)!.postingInstructions).toBeNull();
  });

  it("treats a foreign-project or malformed account id as not found, on read and write", async () => {
    const env = await postsEnv();
    const other = await postsEnv();
    const foreign = await other.account({}, false);
    await expect(accounts.setPostingInstructions(env.scope, foreign.id, { instructions: "x" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(accounts.setPostingInstructions(env.scope, "not-a-uuid", { instructions: "x" })).rejects.toBeInstanceOf(NotFoundError);
    expect((await accounts.listAccounts(env.scope)).some((x) => x.id === foreign.id)).toBe(false);
    expect(await stored(other, foreign.id)).toBeNull();
  });

  it("refuses a removed account", async () => {
    const env = await postsEnv();
    const a = await env.account({}, false);
    await accounts.removeAccount(env.scope, a.id);
    await expect(accounts.setPostingInstructions(env.scope, a.id, { instructions: "x" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("keeps the instructions when the account is reconnected", async () => {
    const env = await postsEnv();
    const a = await env.account({}, false);
    await accounts.setPostingInstructions(env.scope, a.id, { instructions: "Keep me" });
    const again = await accounts.reconnectMock(env.scope, a.id);
    expect(again.postingInstructions).toBe("Keep me");
    expect(await stored(env, a.id)).toBe("Keep me");
  });
});
