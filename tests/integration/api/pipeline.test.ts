import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineOperation, OPERATIONS } from "../../../src/server/api/operations";
import { api, createKey } from "../../helpers/api";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

// A body-taking test operation: the real table has none until the write endpoints land, and these
// checks belong to the pipeline, not to any one endpoint.
const echo = defineOperation({
  id: "testEcho",
  method: "POST",
  path: "/test/echo",
  permission: "read",
  tag: "Test",
  summary: "Echo",
  responses: { 200: { description: "ok" } },
  idempotent: true,
  body: { kind: "json", schema: z.object({ n: z.number() }) },
  async run(_scope, { body }) {
    return { status: 200, body: { got: body } };
  },
});
beforeAll(() => {
  (OPERATIONS as unknown as unknown[]).push(echo);
});
afterAll(async () => {
  (OPERATIONS as unknown as unknown[]).splice((OPERATIONS as unknown as unknown[]).indexOf(echo), 1);
  await closeDb();
});

async function setup() {
  const env = await postsEnv();
  const key = await createKey(env.scope, ["read"]);
  return { env, key };
}

describe("authentication", () => {
  it("answers 401 with WWW-Authenticate for a missing, malformed or unknown key", async () => {
    await setup();
    const unknown = `dkt_${"A".repeat(43)}`;
    for (const key of [undefined, "dkt_short", "not-a-key", unknown]) {
      const r = await api("GET", "/accounts", { key });
      expect(r.status, String(key)).toBe(401);
      expect(r.json.error.code).toBe("invalid_api_key");
      expect(r.headers.get("www-authenticate")).toBe("Bearer");
    }
  });

  it("accepts the key as Bearer or as X-API-Key, and refuses two different values", async () => {
    const { key } = await setup();
    const bearer = await api("GET", "/accounts", { key: key.secret });
    expect(bearer.status).toBe(200);
    const header = await api("GET", "/accounts", { headers: { "x-api-key": key.secret } });
    expect(header.status).toBe(200);
    const both = await api("GET", "/accounts", { key: key.secret, headers: { "x-api-key": key.secret } });
    expect(both.status).toBe(200);
    const other = await api("GET", "/accounts", { key: key.secret, headers: { "x-api-key": `dkt_${"B".repeat(43)}` } });
    expect(other.status).toBe(401);
  });

  it("never reads the session cookie", async () => {
    await setup();
    const r = await api("GET", "/accounts", { headers: { cookie: "better-auth.session_token=abc.def" } });
    expect(r.status).toBe(401);
  });

  it("is scoped to the key's own project", async () => {
    const a = await setup();
    const b = await setup();
    await a.env.account({}, false);
    const mine = await api("GET", "/accounts", { key: a.key.secret });
    const theirs = await api("GET", "/accounts", { key: b.key.secret });
    expect(mine.json.data).toHaveLength(1);
    expect(theirs.json.data).toHaveLength(0);
  });
});

describe("routing", () => {
  it("answers an unknown path with 404, in the error shape", async () => {
    const { key } = await setup();
    const r = await api("GET", "/nope", { key: key.secret });
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe("not_found");
    expect(r.json.error.requestId).toBe(r.headers.get("x-request-id"));
  });

  it("answers a known path with another method with 405 and Allow", async () => {
    const { key } = await setup();
    const r = await api("POST", "/accounts", { key: key.secret, body: {} });
    expect(r.status).toBe(405);
    expect(r.json.error.code).toBe("method_not_allowed");
    expect(r.headers.get("allow")).toContain("GET");
  });

  it("answers OPTIONS with 204 and Allow, and HEAD without a body", async () => {
    const { key } = await setup();
    const o = await api("OPTIONS", "/accounts");
    expect(o.status).toBe(204);
    expect(o.headers.get("allow")).toContain("GET");
    const h = await api("HEAD", "/accounts", { key: key.secret });
    expect(h.status).toBe(200);
    expect(h.text).toBe("");
  });
});

describe("headers", () => {
  it("sets a fresh X-Request-Id and no-store on every response", async () => {
    const { key } = await setup();
    const responses = [
      await api("GET", "/accounts", { key: key.secret }),
      await api("GET", "/accounts"),
      await api("GET", "/nope"),
      await api("DELETE", "/accounts"),
    ];
    const ids = responses.map((r) => r.headers.get("x-request-id"));
    for (const r of responses) {
      expect(r.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect(new Set(ids).size).toBe(ids.length);
    const trusted = await api("GET", "/accounts", { key: key.secret, headers: { "x-request-id": "client-chosen" } });
    expect(trusted.headers.get("x-request-id")).not.toBe("client-chosen");
  });
});

describe("request bodies", () => {
  it("refuses a wrong content type with 415 and bad JSON with invalid_json", async () => {
    const { key } = await setup();
    const text = await api("POST", "/test/echo", { key: key.secret, body: '{"n":1}', headers: { "content-type": "text/plain" } });
    expect(text.status).toBe(415);
    expect(text.json.error.code).toBe("unsupported_media_type");
    const bad = await api("POST", "/test/echo", { key: key.secret, body: "{nope", headers: { "content-type": "application/json" } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("invalid_json");
    const ok = await api("POST", "/test/echo", { key: key.secret, body: { n: 2 } });
    expect(ok.json).toEqual({ got: { n: 2 } });
  });

  it("answers a schema failure with validation_failed and a path", async () => {
    const { key } = await setup();
    const r = await api("POST", "/test/echo", { key: key.secret, body: { n: "x" } });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("validation_failed");
    expect(r.json.error.details[0].path).toBe("n");
  });

  it("refuses a body over 8 MB with 413", async () => {
    const { key } = await setup();
    const big = JSON.stringify({ n: 1, pad: "x".repeat(8 * 1024 * 1024 + 10) });
    const r = await api("POST", "/test/echo", { key: key.secret, body: big, headers: { "content-type": "application/json" } });
    expect(r.status).toBe(413);
    expect(r.json.error.code).toBe("payload_too_large");
  });

  it("refuses a malformed Idempotency-Key", async () => {
    const { key } = await setup();
    const r = await api("POST", "/test/echo", { key: key.secret, body: { n: 1 }, idem: "has space" });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("invalid_idempotency_key");
  });

  it("treats a malformed id the same as an unknown one", async () => {
    const { key } = await setup();
    const r = await api("GET", "/posts/not-a-uuid", { key: key.secret });
    expect(r.status).toBe(404);
  });
});
