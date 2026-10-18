import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { threadsConnectGroup } from "./connect-group";

const ORIGINAL = { id: process.env.THREADS_APP_ID, secret: process.env.THREADS_APP_SECRET };

beforeEach(() => {
  process.env.THREADS_APP_ID = "12345";
  process.env.THREADS_APP_SECRET = "s3cr3t-app-secret-value";
});
afterEach(() => {
  if (ORIGINAL.id === undefined) delete process.env.THREADS_APP_ID;
  else process.env.THREADS_APP_ID = ORIGINAL.id;
  if (ORIGINAL.secret === undefined) delete process.env.THREADS_APP_SECRET;
  else process.env.THREADS_APP_SECRET = ORIGINAL.secret;
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
