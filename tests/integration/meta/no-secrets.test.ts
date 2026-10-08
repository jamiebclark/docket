import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
vi.hoisted(() => {
  process.env.BETTER_AUTH_URL = "https://docket.local:3000";
});

import * as connect from "../../../src/server/services/connect";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb, testDb } from "../../helpers/db";
import { facebookSetup, PAGE_ID, PAGE_TOKEN } from "../../helpers/facebook-publish";
import { IG_ID, instagramVideoSetup } from "../../helpers/instagram-publish";
import { createFakeGraph } from "../../helpers/fake-graph";
import { sessionFor } from "../../helpers/connect-group";
import { eq } from "drizzle-orm";
import { socialAccounts } from "../../../src/server/db/schema/accounts";
import { randomUUID } from "node:crypto";
import { runTokenRefresh } from "../../../src/server/scheduler/token-refresh";
import { decryptCredentials } from "../../../src/server/services/accounts";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { atTime } from "../../helpers/clock";
import { scriptThreads, threadsSetup, THREADS_TOKEN } from "../../helpers/threads-publish";
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

// 019: a video container `ERROR` whose status detail echoes the page token.
describe("Instagram video errors never leak the token", () => {
  it("keeps the token out of lastError, the attempts, every column and the logs", async () => {
    const output = captureConsole();
    fake.on("POST", `/v26.0/${IG_ID}/media`, { kind: "ok", body: { id: "r1" } });
    fake.on("GET", "/v26.0/r1", { kind: "ok", body: { status_code: "ERROR", status: `Error: bad codec, token ${PAGE_TOKEN}` } });
    const s = await instagramVideoSetup(storage, "video", ["video"], { postType: "video" });
    const base = Date.now() + 60_000;
    const tickAt = (seconds: number) => atTime(new Date(base + seconds * 1000), () => s.tick());
    await tickAt(0);
    await tickAt(61);
    const row = await s.row();
    expect(row.status).toBe("failed");
    expect(row.lastError).toContain("Instagram could not process the video");
    const blob = `${JSON.stringify(row)}\n${JSON.stringify(await forSchedulerProject(s.projectId).targets.get(s.targetId))}\n${output()}`;
    expect(blob).not.toContain(PAGE_TOKEN);
    expect(await plaintextColumnsContaining(PAGE_TOKEN)).toEqual([]);
  });
});

// FR-033 / SC-008: the same guarantee for Threads, across connect, paste, renewal and every advance path.
const T_SECRET = "threads-secret-fake-6666aaaa";
const T_CODE = "tcode-fake-7777bbbb";
const T_SHORT = "THQW-fake-short-8888cccc";
const T_LONG = "THQW-fake-long-9999dddd";
const T_PASTED = "THQW-fake-pasted-1010eeee";
const T_RENEWED = "THQW-fake-renewed-2020ffff";
const T_ALL = [T_SECRET, T_CODE, T_SHORT, T_LONG, T_PASTED, T_RENEWED, THREADS_TOKEN];
const REFRESH_CONFIG = {
  timeBudgetMs: 30_000, maxItems: 10, leaseMs: 60_000, providerTimeoutMs: 5_000, maxAttempts: 5,
  backoffBaseMs: 1_000, backoffMaxMs: 60_000, maxPublishDurationMs: 3_600_000, refreshWindowMs: 72 * 3_600_000,
  refreshMaxAccounts: 1000, batchSize: 4,
};
const DAY = 86_400_000;

describe("Threads credentials never leak", () => {
  it("keeps every secret out of results, console and plaintext columns, and keeps credential timestamps numeric", async () => {
    vi.stubEnv("THREADS_APP_ID", "424242");
    vi.stubEnv("THREADS_APP_SECRET", T_SECRET);
    vi.stubEnv("THREADS_GRAPH_BASE", "https://graph.threads.test");
    vi.stubEnv("BETTER_AUTH_URL", "https://docket.local:3000");
    const output = captureConsole();
    const seen: string[] = [];
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    const me = { kind: "ok" as const, body: { id: "9001", username: "docket" } };

    // OAuth: start -> callback -> chooser -> choose.
    fake.on("POST", "/oauth/access_token", { kind: "ok", body: { access_token: T_SHORT } });
    fake.on("GET", "/access_token", { kind: "ok", body: { access_token: T_LONG, expires_in: 5_184_000 } });
    fake.on("GET", "/v1.0/me", me);
    const started = await connect.startOAuthConnect(env.scope, { groupKey: "threads" }, session);
    seen.push(JSON.stringify(started));
    const state = new URL(started.url).searchParams.get("state")!;
    const cb = await connect.handleOAuthCallback(new URLSearchParams({ state, code: T_CODE }), {
      userId: env.owner.id,
      sessionId: session.sessionId,
    });
    seen.push(JSON.stringify(cb));
    if (cb.kind !== "chooser") throw new Error(`expected chooser, got ${cb.kind}`);
    seen.push(JSON.stringify(await connect.getConnectChoice(env.scope, cb.attemptId, session)));
    seen.push(JSON.stringify(await connect.chooseConnectCandidates(env.scope, { attemptId: cb.attemptId, selected: ["threads:9001"] }, session)));

    // Paste: exchange refused and renew refused (error text echoes the token), then an accepted paste.
    const echo = { kind: "graph_error" as const, code: 190, message: `Invalid OAuth access token ${T_PASTED}`, status: 400 };
    fake.on("GET", "/access_token", echo);
    fake.on("GET", "/refresh_access_token", echo);
    seen.push(JSON.stringify(await connect.pasteConnectToken(env.scope, { groupKey: "threads", token: T_PASTED }, session)));
    fake.on("GET", "/access_token", { kind: "ok", body: { access_token: T_LONG, expires_in: 5_184_000 } });
    fake.on("GET", "/v1.0/me", me);
    const pasted = await connect.pasteConnectToken(env.scope, { groupKey: "threads", token: T_PASTED }, session);
    seen.push(JSON.stringify(pasted));
    if (pasted.ok) seen.push(JSON.stringify(await connect.getConnectChoice(env.scope, pasted.attemptId, session)));

    // Renewal: success, then a refusal that echoes the old token.
    const now = new Date();
    const aged = await threadsSetup(storage, { issuedAt: new Date(now.getTime() - 50 * DAY), expiresAt: new Date(now.getTime() + 2 * DAY) });
    fake.on("GET", "/refresh_access_token", { kind: "ok", body: { access_token: T_RENEWED, expires_in: 5_184_000 } });
    const renewed = await atTime(now, () => runTokenRefresh({ config: REFRESH_CONFIG, tickId: randomUUID(), startedAt: now }));
    seen.push(JSON.stringify(renewed));
    const [acct] = await testDb().select().from(socialAccounts).where(eq(socialAccounts.id, aged.accountId));
    const creds = decryptCredentials(acct!.id, acct!.credentialsEncrypted) as Record<string, unknown>;
    expect(creds.accessToken).toBe(T_RENEWED);
    for (const k of ["issuedAt", "expiresAt"]) expect(typeof creds[k], `${k} stays a number`).toBe("number");
    const old = await threadsSetup(storage, { issuedAt: new Date(now.getTime() - 50 * DAY), expiresAt: new Date(now.getTime() + 2 * DAY) });
    fake.on("GET", "/refresh_access_token", { kind: "graph_error", code: 190, message: `Invalid OAuth access token ${THREADS_TOKEN}`, status: 400 });
    seen.push(JSON.stringify(await atTime(now, () => runTokenRefresh({ config: REFRESH_CONFIG, tickId: randomUUID(), startedAt: now }))));
    seen.push(JSON.stringify((await testDb().select().from(socialAccounts).where(eq(socialAccounts.id, old.accountId)))[0]));

    // Advance paths: success, a Graph error that echoes the token, and an ambiguous publish.
    const advance = async (setupScript: () => void, label: string) => {
      fake.reset();
      setupScript();
      const s = await threadsSetup(storage, { text: label });
      for (let i = 0; i < 6; i++) await s.tick(await s.afterNext(1_000));
      seen.push(JSON.stringify(await s.row()));
      seen.push(JSON.stringify(await forSchedulerProject(s.projectId).targets.get(s.targetId)));
    };
    await advance(() => scriptThreads(fake).create(["1001"]).status("1001", ["FINISHED"]).quota(3).publish("th_1"), "ok");
    await advance(
      () => fake.on("POST", "/v1.0/17841400000000001/threads", { kind: "graph_error", code: 190, message: `Invalid token ${THREADS_TOKEN}`, status: 401 }),
      "bad",
    );
    await advance(
      () => scriptThreads(fake).create(["1002"]).status("1002", ["FINISHED"]).quota(3).publish({ kind: "reset_mid_body" }),
      "ambiguous",
    );

    const blob = `${seen.join("\n")}\n${output()}`;
    for (const secret of T_ALL) {
      expect(blob, `leaked ${secret}`).not.toContain(secret);
      expect(await plaintextColumnsContaining(secret), `column holds ${secret}`).toEqual([]);
    }
    for (const r of fake.requests.filter((x) => x.method === "POST")) expect(r.path).not.toContain("THQW");
  });
});
