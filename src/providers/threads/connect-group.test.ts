import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeGraph } from "../../../tests/helpers/fake-graph";
import { threadsConnectGroup } from "./connect-group";

const ORIGINAL = { id: process.env.THREADS_APP_ID, secret: process.env.THREADS_APP_SECRET };
const fake = createFakeGraph();

beforeEach(() => {
  process.env.THREADS_APP_ID = "12345";
  process.env.THREADS_APP_SECRET = "s3cr3t-app-secret-value";
  fake.reset();
  fake.install();
});
afterEach(() => {
  if (ORIGINAL.id === undefined) delete process.env.THREADS_APP_ID;
  else process.env.THREADS_APP_ID = ORIGINAL.id;
  if (ORIGINAL.secret === undefined) delete process.env.THREADS_APP_SECRET;
  else process.env.THREADS_APP_SECRET = ORIGINAL.secret;
  fake.uninstall();
});

describe("threadsConnectGroup.exchangeCode", () => {
  const run = () =>
    threadsConnectGroup.exchangeCode({
      code: "CODE1234",
      redirectUri: "https://docket.local:3000/connect/callback",
      state: "st",
      now: new Date(),
      signal: new AbortController().signal,
    });
  const scriptHappyPath = (permissions: string | undefined) => {
    fake.on("POST", "/oauth/access_token", {
      kind: "ok",
      body: { access_token: "short", ...(permissions !== undefined ? { permissions } : {}) },
    });
    fake.on("GET", "/access_token", { kind: "ok", body: { access_token: "long", expires_in: 5184000 } });
    fake.on("GET", "/v1.0/me", { kind: "ok", body: { id: "17841", username: "acme" } });
  };

  it("attaches the already-parsed grantedList as grantedScopes (US2-AS2)", async () => {
    scriptHappyPath("threads_basic,threads_content_publish");
    const r = await run();
    expect(r.ok && r.candidates[0]?.grantedScopes).toEqual(["threads_basic", "threads_content_publish"]);
    expect(r.ok && r.candidates[0]?.notes).toBeUndefined();
  });

  it("leaves grantedScopes absent, not [] and not the requested list, when the reply has no permission list (US2-AS2)", async () => {
    scriptHappyPath(undefined);
    const r = await run();
    expect(r.ok && r.candidates[0]?.grantedScopes).toBeUndefined();
    expect(r.ok && r.candidates[0]?.notes).toBeUndefined();
  });

  it("keeps the missing-publish-permission note byte-identical when publish was not granted (FR-013)", async () => {
    scriptHappyPath("threads_basic");
    const r = await run();
    expect(r.ok && r.candidates[0]?.grantedScopes).toEqual(["threads_basic"]);
    expect(r.ok && r.candidates[0]?.notes).toEqual(["Publishing permission was not granted. Connect again and allow it."]);
  });
});

// FR-018, US1-AS1: with THREADS_INSIGHTS_SCOPES unset, the authorization URL is byte-identical to
// today's — compared against a literal, never a re-computation.
describe("threadsConnectGroup.authorizationUrl", () => {
  it("with THREADS_INSIGHTS_SCOPES unset, the URL is byte-identical to today's", () => {
    const url = threadsConnectGroup.authorizationUrl({ state: "st", redirectUri: "https://x.test/connect/callback" });
    expect(url).toBe(
      "https://threads.com/oauth/authorize?client_id=12345&redirect_uri=https%3A%2F%2Fx.test%2Fconnect%2Fcallback&scope=threads_basic%2Cthreads_content_publish&response_type=code&state=st",
    );
  });
});
