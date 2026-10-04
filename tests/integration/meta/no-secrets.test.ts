import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import * as connect from "../../../src/server/services/connect";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb, testDb } from "../../helpers/db";
import { facebookSetup, PAGE_ID, PAGE_TOKEN } from "../../helpers/facebook-publish";
import { createFakeGraph } from "../../helpers/fake-graph";
import { sessionFor } from "../../helpers/connect-group";
import { postsEnv } from "../../helpers/posts-env";
import { parkAllDueTargets } from "../../helpers/scheduling";
import { createMemoryStorage } from "../../helpers/storage";
import { clearRecordedQueries } from "../../setup/scope-recorder";

// SC-007 / FR-034: no credential-shaped value outside credentials_encrypted / candidates_encrypted.
const APP_SECRET = "appsecret-fake-0000aaaa";
const CODE = "code-fake-1111bbbb";
const SHORT = "EAAG-fake-user-short-2222cccc";
const LONG = "EAAG-fake-user-long-3333dddd";
const PAGE = "EAAG-fake-page-4444eeee";
const PASTED = "EAAG-fake-pasted-5555ffff";
const SECRETS = [APP_SECRET, CODE, SHORT, LONG, PAGE, PASTED, PAGE_TOKEN];

const fake = createFakeGraph();
const storage = createMemoryStorage();

beforeEach(async () => {
  await parkAllDueTargets();
  vi.stubEnv("META_APP_ID", "12345");
  vi.stubEnv("META_APP_SECRET", APP_SECRET);
  vi.stubEnv("META_GRAPH_VERSION", "v26.0");
  fake.reset();
  fake.install();
  setStorageForTests(storage);
});
afterEach(() => {
  clearRecordedQueries(); // the column scan is deliberately unscoped
  fake.uninstall();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});

/** Every text column of every table except the two ciphertext columns. */
async function plaintextColumnsContaining(needle: string): Promise<string[]> {
  const rowsOf = (res: unknown) => (res as { rows: Record<string, string>[] }).rows;
  const cols = rowsOf(await testDb().execute(sql`
    select table_name, column_name from information_schema.columns
    where table_schema = 'public' and data_type in ('text', 'character varying', 'jsonb', 'json')
      and column_name not in ('credentials_encrypted', 'candidates_encrypted')`));
  const hits: string[] = [];
  for (const c of cols) {
    const q = sql.raw(`select 1 from "${c.table_name}" where "${c.column_name}"::text like '%${needle}%' limit 1`);
    if (rowsOf(await testDb().execute(q)).length > 0) hits.push(`${c.table_name}.${c.column_name}`);
  }
  return hits;
}

function captureConsole(): () => string {
  const lines: string[] = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a, Object.getOwnPropertyNames(Object(a))))).join(" "));
    });
  }
  return () => lines.join("\n");
}

describe("Meta credentials never leak", () => {
  it("keeps every secret out of results, chooser data, console and plaintext columns across connect, paste and publish", async () => {
    const output = captureConsole();
    const seen: string[] = [];
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    const pages = {
      kind: "ok" as const,
      body: { data: [{ id: "100", name: "Acme", access_token: PAGE, instagram_business_account: { id: "1784" } }] },
    };

    // OAuth: start -> callback -> chooser -> choose.
    fake.on("GET", "/v26.0/oauth/access_token", [
      { kind: "ok", body: { access_token: SHORT } },
      { kind: "ok", body: { access_token: LONG } },
    ]);
    fake.on("GET", "/v26.0/me/accounts", pages);
    const started = await connect.startOAuthConnect(env.scope, { groupKey: "meta" }, session);
    seen.push(JSON.stringify(started));
    const state = new URL(started.url).searchParams.get("state")!;
    const cb = await connect.handleOAuthCallback(new URLSearchParams({ state, code: CODE }), {
      userId: env.owner.id,
      sessionId: session.sessionId,
    });
    seen.push(JSON.stringify(cb));
    if (cb.kind !== "chooser") throw new Error(`expected chooser, got ${cb.kind}`);
    seen.push(JSON.stringify(await connect.getConnectChoice(env.scope, cb.attemptId, session)));
    seen.push(
      JSON.stringify(
        await connect.chooseConnectCandidates(env.scope, { attemptId: cb.attemptId, selected: ["facebook:100"] }, session),
      ),
    );

    // Paste: the pasted token only reaches the exchange.
    fake.on("GET", "/v26.0/oauth/access_token", { kind: "ok", body: { access_token: LONG } });
    fake.on("GET", "/v26.0/me/accounts", pages);
    const pasted = await connect.pasteConnectToken(env.scope, { groupKey: "meta", token: PASTED }, session);
    seen.push(JSON.stringify(pasted));
    if (pasted.ok) seen.push(JSON.stringify(await connect.getConnectChoice(env.scope, pasted.attemptId, session)));

    // Publish: success, then a Graph error, through the real scheduler.
    fake.on("POST", `/v26.0/${PAGE_ID}/feed`, { kind: "ok", body: { id: `${PAGE_ID}_1` } });
    const ok = await facebookSetup(storage, "hello", 0);
    await ok.tick();
    seen.push(JSON.stringify(await ok.row()));
    fake.on("POST", `/v26.0/${PAGE_ID}/feed`, { kind: "graph_error", code: 190, message: "Invalid OAuth access token", status: 401 });
    const bad = await facebookSetup(storage, "again", 0);
    await bad.tick();
    seen.push(JSON.stringify(await bad.row()));

    const blob = `${seen.join("\n")}\n${output()}`;
    for (const secret of SECRETS) {
      expect(blob, `leaked ${secret}`).not.toContain(secret);
      expect(await plaintextColumnsContaining(secret), `column holds ${secret}`).toEqual([]);
    }
    for (const r of fake.requests.filter((x) => x.method === "POST")) expect(r.path).not.toContain("EAA");
  });
});
