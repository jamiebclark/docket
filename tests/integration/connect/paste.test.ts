import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { ForbiddenError } from "../../../src/server/dal/errors";
import * as connect from "../../../src/server/services/connect";
import type { CandidatesResult } from "../../../src/providers/types";
import { clearRecordedQueries } from "../../setup/scope-recorder";
import { closeDb, testDb } from "../../helpers/db";
import { pageCandidate, registerThrowaway, sessionFor, throwawayGroup, unregisterThrowaway } from "../../helpers/connect-group";
import { postsEnv } from "../../helpers/posts-env";

const PASTED = "EAAB-PASTED-USER-TOKEN";
const LONG_LIVED = "LONG-LIVED-USER-TOKEN";
const NO_PAGES = "No Pages were found. The token needs pages_show_list and pages_manage_posts.";
const seen: string[] = [];
let outcome: (token: string) => CandidatesResult;

beforeAll(() => {
  registerThrowaway();
  throwawayGroup.pasteToken = {
    field: { name: "userToken", label: "User access token", secret: true },
    help: "Paste a token.",
    async exchange({ token }) {
      seen.push(token);
      return outcome(token);
    },
  };
});
afterAll(async () => {
  delete throwawayGroup.pasteToken;
  unregisterThrowaway();
  await closeDb();
});

/** Every text column of every table, to prove a secret is stored nowhere. */
async function dbContains(needle: string): Promise<boolean> {
  const rowsOf = (res: unknown) => (res as { rows: Record<string, string>[] }).rows;
  const rows = rowsOf(await testDb().execute(sql`
    select table_name, column_name from information_schema.columns
    where table_schema = 'public' and data_type in ('text', 'character varying', 'jsonb', 'json')`));
  for (const r of rows) {
    const q = sql.raw(`select 1 from "${r.table_name}" where "${r.column_name}"::text like '%${needle}%' limit 1`);
    if (rowsOf(await testDb().execute(q)).length > 0) return true;
  }
  return false;
}

async function attemptCount(): Promise<number> {
  const res = await testDb().execute(sql`select count(*)::int as n from connect_attempts`);
  return Number((res as unknown as { rows: { n: number }[] }).rows[0]!.n);
}

describe("paste a token", () => {
  it("lands in the chooser, and the token is stored and returned nowhere", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    outcome = () => ({ ok: true, candidates: pageCandidate("200", "Acme", false) });
    const r = await connect.pasteConnectToken(env.scope, { groupKey: "throwaway", token: PASTED }, session);
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain(PASTED);
    expect(seen).toContain(PASTED);
    const choice = await connect.getConnectChoice(env.scope, (r as { attemptId: string }).attemptId, session);
    expect(choice?.candidates.map((c) => c.key)).toEqual(["tw-page:200"]);
    expect(JSON.stringify(choice)).not.toContain(PASTED);
    // Deliberately unscoped: the secret must be absent from every table, not just this project's.
    const leaked = (await dbContains(PASTED)) || (await dbContains(LONG_LIVED));
    clearRecordedQueries();
    expect(leaked).toBe(false);
  });

  it("explains an unexchangeable token and changes nothing", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    outcome = () => ({ ok: false, message: "That token is expired or invalid. Generate a new one." });
    const before = await attemptCount();
    clearRecordedQueries();
    const r = await connect.pasteConnectToken(env.scope, { groupKey: "throwaway", token: "bad" }, session);
    expect(r).toEqual({ ok: false, message: "That token is expired or invalid. Generate a new one." });
    const after = await attemptCount();
    clearRecordedQueries();
    expect(after).toBe(before);
  });

  it("lists the needed permissions when no Pages are found", async () => {
    const env = await postsEnv();
    outcome = () => ({ ok: false, message: NO_PAGES });
    const r = await connect.pasteConnectToken(env.scope, { groupKey: "throwaway", token: "t" }, await sessionFor(env.owner.id));
    expect(!r.ok && r.message).toContain("pages_show_list");
  });

  it("refuses editors server-side and lists no paste form for them", async () => {
    const env = await postsEnv();
    outcome = () => ({ ok: true, candidates: pageCandidate("201", "X", false) });
    const editor = await env.as(env.editor);
    await expect(
      connect.pasteConnectToken(editor, { groupKey: "throwaway", token: PASTED }, await sessionFor(env.editor.id)),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const groups = await connect.listConnectGroups(editor);
    expect(groups.find((g) => g.key === "throwaway")?.paste).toMatchObject({ label: "User access token" });
  });
});
