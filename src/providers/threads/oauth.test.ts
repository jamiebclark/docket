import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeGraph } from "../../../tests/helpers/fake-graph";
import type { ThreadsConfig } from "./config";
import { exchangeCode, exchangeLongLived, readProfile, refreshLongLived } from "./oauth";

const cfg: ThreadsConfig = { appId: "12345", appSecret: "s3cr3t-app-secret-value", graphBase: "https://graph.threads.test" };
const fake = createFakeGraph();
const signal = () => new AbortController().signal;
const REDIRECT = "https://docket.local:3000/connect/callback";

beforeEach(() => {
  fake.reset();
  fake.install();
});
afterEach(() => fake.uninstall());

describe("exchangeCode", () => {
  it("POSTs a form to the unversioned token path on the configured host", async () => {
    fake.on("POST", "/oauth/access_token", { kind: "ok", body: { access_token: "short", permissions: "threads_basic,threads_content_publish" } });
    const r = await exchangeCode(cfg, { code: "CODE1234", redirectUri: REDIRECT, signal: signal() });
    expect(r).toEqual({ ok: true, token: "short", granted: ["threads_basic", "threads_content_publish"] });
    const req = fake.requests[0]!;
    expect(req.host).toBe("graph.threads.test");
    expect(req.params).toMatchObject({
      client_id: "12345",
      client_secret: cfg.appSecret,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT,
      code: "CODE1234",
    });
  });
  it("reports no granted list when the reply has none", async () => {
    fake.on("POST", "/oauth/access_token", { kind: "ok", body: { access_token: "short" } });
    expect(await exchangeCode(cfg, { code: "CODE1234", redirectUri: REDIRECT, signal: signal() })).toMatchObject({ granted: null });
  });
  it("fails on an empty or missing token", async () => {
    fake.on("POST", "/oauth/access_token", { kind: "ok", body: { access_token: "" } });
    expect(await exchangeCode(cfg, { code: "CODE1234", redirectUri: REDIRECT, signal: signal() })).toMatchObject({ ok: false, transient: false });
  });
  it("scrubs the secret and code from a platform message", async () => {
    fake.on("POST", "/oauth/access_token", {
      kind: "graph_error",
      code: 100,
      message: `Bad code CODE1234 with ${cfg.appSecret} client_secret=${cfg.appSecret}`,
    });
    const r = await exchangeCode(cfg, { code: "CODE1234", redirectUri: REDIRECT, signal: signal() });
    expect(r).toMatchObject({ ok: false, transient: false });
    const text = JSON.stringify(r);
    expect(text).not.toContain(cfg.appSecret);
    expect(text).not.toContain("CODE1234");
  });
});

describe("exchangeLongLived", () => {
  it("GETs th_exchange_token with the secret and reads expires_in", async () => {
    fake.on("GET", "/access_token", { kind: "ok", body: { access_token: "long", expires_in: 5184000 } });
    expect(await exchangeLongLived(cfg, { token: "short", signal: signal() })).toEqual({
      ok: true,
      token: "long",
      expiresInSeconds: 5184000,
    });
    expect(fake.requests[0]).toMatchObject({ method: "GET", params: { grant_type: "th_exchange_token", client_secret: cfg.appSecret } });
    expect(fake.requests[0]?.hadToken).toBe(true);
  });
  it.each([undefined, 0, -5, 1.5, "100"])("defaults expires_in %s to 60 days", async (exp) => {
    fake.on("GET", "/access_token", { kind: "ok", body: { access_token: "long", expires_in: exp } });
    expect(await exchangeLongLived(cfg, { token: "short", signal: signal() })).toMatchObject({ expiresInSeconds: 5_184_000 });
  });
  it("treats an unreadable body as transient", async () => {
    fake.on("GET", "/access_token", { kind: "unparseable" });
    expect(await exchangeLongLived(cfg, { token: "short", signal: signal() })).toMatchObject({ ok: false, transient: true });
  });
});

describe("refreshLongLived", () => {
  it("GETs th_refresh_token without the app secret", async () => {
    fake.on("GET", "/refresh_access_token", { kind: "ok", body: { access_token: "renewed", expires_in: 100 } });
    expect(await refreshLongLived(cfg, { token: "old", signal: signal() })).toEqual({ ok: true, token: "renewed", expiresInSeconds: 100 });
    expect(fake.requests[0]?.params).toEqual({ grant_type: "th_refresh_token", access_token: "[redacted]" });
  });
});

describe("readProfile", () => {
  it("reads id and username from the versioned me path", async () => {
    fake.on("GET", "/v1.0/me", { kind: "ok", body: { id: "9001", username: "docket" } });
    expect(await readProfile(cfg, { token: "t", signal: signal() })).toEqual({ ok: true, id: "9001", username: "docket" });
    expect(fake.requests[0]?.params.fields).toBe("id,username");
  });
  it("allows a missing username but not a missing or malformed id", async () => {
    fake.on("GET", "/v1.0/me", [{ kind: "ok", body: { id: "9001" } }, { kind: "ok", body: { id: "abc" } }, { kind: "ok", body: {} }]);
    expect(await readProfile(cfg, { token: "t", signal: signal() })).toEqual({ ok: true, id: "9001", username: null });
    expect(await readProfile(cfg, { token: "t", signal: signal() })).toMatchObject({ ok: false });
    expect(await readProfile(cfg, { token: "t", signal: signal() })).toMatchObject({ ok: false });
  });
});

describe("failure mapping", () => {
  const cases: Array<[string, Parameters<typeof fake.on>[2], boolean]> = [
    ["network", { kind: "pre_send_failure" }, true],
    ["5xx", { kind: "http", status: 503 }, true],
    ["429", { kind: "http", status: 429 }, true],
    ["4xx", { kind: "http", status: 403 }, false],
    ["graph 190", { kind: "graph_error", code: 190, message: "bad token" }, false],
    ["graph 4", { kind: "graph_error", code: 4, message: "slow down" }, true],
    ["graph 5xx", { kind: "graph_error", code: 100, status: 500 }, true],
  ];
  it.each(cases)("%s", async (_name, reply, transient) => {
    fake.on("GET", "/v1.0/me", reply);
    expect(await readProfile(cfg, { token: "TOKENVALUE", signal: signal() })).toMatchObject({ ok: false, transient });
  });
  it("never puts the token in a reason", async () => {
    fake.on("GET", "/v1.0/me", { kind: "graph_error", code: 190, message: "Invalid TOKENVALUE access_token=TOKENVALUE" });
    expect(JSON.stringify(await readProfile(cfg, { token: "TOKENVALUE", signal: signal() }))).not.toContain("TOKENVALUE");
  });
  it("honours the abort signal", async () => {
    fake.on("GET", "/v1.0/me", { kind: "hang" });
    const c = new AbortController();
    const p = readProfile(cfg, { token: "t", signal: c.signal });
    c.abort();
    expect(await p).toMatchObject({ ok: false, transient: true });
  });
});
