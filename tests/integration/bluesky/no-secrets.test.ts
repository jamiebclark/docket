import { and, eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectCredentialsForm } from "../../../src/app/p/[projectSlug]/accounts/ConnectCredentialsForm";
import { publishAttempts } from "../../../src/server/db/schema/attempts";
import { socialAccounts } from "../../../src/server/db/schema/accounts";
import { postTargets } from "../../../src/server/db/schema/posts";
import { runTick } from "../../../src/server/scheduler";
import * as accounts from "../../../src/server/services/accounts";
import { closeDb, testDb } from "../../helpers/db";
import { createFakePds, mintJwt, type FakePds } from "../../helpers/fake-pds";
import { postsEnv } from "../../helpers/posts-env";
import { createDueTarget, parkAllDueTargets } from "../../helpers/scheduling";

const CREATE_SESSION = "/xrpc/com.atproto.server.createSession";
const REFRESH_SESSION = "/xrpc/com.atproto.server.refreshSession";
const CREATE_RECORD = "/xrpc/com.atproto.repo.createRecord";
const DID = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
const CID = "bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5uxgf5kpqcsgzmq2vz2m";
const URI = `at://${DID}/app.bsky.feed.post/3kabcdefghijk`;
const APP_PASSWORD = "abcd-efgh-ijkl-mnop";
const FIRST_ACCESS = mintJwt(new Date(Date.now() + 60_000));
const FIRST_REFRESH = mintJwt(new Date(Date.now() + 60 * 86_400_000));
const NEW_ACCESS = mintJwt(new Date(Date.now() + 7_200_000));
const NEW_REFRESH = mintJwt(new Date(Date.now() + 61 * 86_400_000));
const SECRETS = [APP_PASSWORD, FIRST_ACCESS, FIRST_REFRESH, NEW_ACCESS, NEW_REFRESH];

let pds: FakePds;
let logs: string[];
beforeEach(async () => {
  await parkAllDueTargets();
  pds = createFakePds();
  vi.stubGlobal("fetch", pds.fetch);
  logs = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")));
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(closeDb);

function expectNoSecrets(label: string, text: string) {
  for (const s of SECRETS) expect(text.includes(s), `${label} leaks a secret`).toBe(false);
}

describe("Bluesky no-secrets rule (FR-026, SC-007)", () => {
  it("never exposes the app password or session tokens across connect, refresh and every advance path", async () => {
    const env = await postsEnv();
    pds.route("POST", CREATE_SESSION, { json: { accessJwt: FIRST_ACCESS, refreshJwt: FIRST_REFRESH, did: DID, handle: "me.bsky.social" } });
    pds.route("POST", REFRESH_SESSION, { json: { accessJwt: NEW_ACCESS, refreshJwt: NEW_REFRESH, did: DID, handle: "me.bsky.social" } });
    const out = await accounts.connectWithCredentials(env.scope, {
      providerKey: "bluesky",
      fields: { handle: "me.bsky.social", appPassword: APP_PASSWORD, pdsUrl: "" },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const actionResults: unknown[] = [out];

    // A wrong password goes through the same action result path.
    const bad = createFakePds();
    bad.route("POST", CREATE_SESSION, { status: 401, json: { error: "AuthenticationRequired", message: `Invalid ${APP_PASSWORD}` } });
    vi.stubGlobal("fetch", bad.fetch);
    actionResults.push(
      await accounts.connectWithCredentials(env.scope, { providerKey: "bluesky", fields: { handle: "me.bsky.social", appPassword: APP_PASSWORD, pdsUrl: "" } }),
    );
    vi.stubGlobal("fetch", pds.fetch);

    // Outcomes: proactive refresh + success, then a rejected create, an unparseable 2xx, a reset and a hang-free 5xx.
    const scripts: Array<Parameters<FakePds["route"]>[2]> = [
      { json: { uri: URI, cid: CID } },
      { status: 400, json: { error: "InvalidRequest", message: `bad ${NEW_ACCESS}` } },
      { text: "<html>not json</html>" },
      { mode: "reset-mid-body", partial: '{"uri":' },
      { status: 502, text: "bad gateway" },
    ];
    for (const script of scripts) {
      pds.route("POST", CREATE_RECORD, script);
      const { target } = await createDueTarget(env.project.id, out.account.id, { baseText: "hello" });
      await runTick({ config: {} });
      await testDb().update(postTargets).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(and(eq(postTargets.projectId, env.project.id), eq(postTargets.id, target.id)));
      await runTick({ config: {} });
    }

    const attempts = await testDb().select().from(publishAttempts).where(eq(publishAttempts.projectId, env.project.id));
    const targets = await testDb().select().from(postTargets).where(eq(postTargets.projectId, env.project.id));
    const acct = await testDb().select().from(socialAccounts).where(eq(socialAccounts.projectId, env.project.id));
    const accountNoCreds = acct.map((row) => ({ ...row, credentialsEncrypted: undefined }));
    expectNoSecrets("publish_attempts", JSON.stringify(attempts));
    expectNoSecrets("post_targets", JSON.stringify(targets));
    expectNoSecrets("social_accounts", JSON.stringify(accountNoCreds));
    expectNoSecrets("console", logs.join("\n"));
    expectNoSecrets("action results", JSON.stringify(actionResults));

    const bluesky = (await accounts.listConnectableProviders(env.scope)).find((p) => p.key === "bluesky")!;
    if (bluesky.connect.strategy === "oauth") throw new Error("expected declared fields");
    const html = renderToStaticMarkup(
      createElement(ConnectCredentialsForm, { slug: env.project.slug, providerKey: "bluesky", providerName: "Bluesky", fields: [...bluesky.connect.fields], submitLabel: "Connect" }),
    );
    expectNoSecrets("rendered HTML", html + JSON.stringify(await accounts.listConnectableProviders(env.scope)));
  });
});
