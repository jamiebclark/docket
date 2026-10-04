import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const session = vi.hoisted(() => ({ current: null as { user: { id: string } } | null }));
vi.mock("@/server/auth/session", () => ({ getSession: async () => session.current }));

import { POST as composeCheck } from "../../../src/app/p/[projectSlug]/compose/check/route";
import { POST as apiPost } from "../../../src/app/api/v1/[[...path]]/route";
import { defineOperation, OPERATIONS } from "../../../src/server/api/operations";
import { createKey } from "../../helpers/api";
import { fakeSession } from "../../helpers/auth";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

const echo = defineOperation({
  id: "bodyLimitEcho",
  method: "POST",
  path: "/test/body-limit",
  permission: "read",
  tag: "Test",
  summary: "Echo",
  responses: { 200: { description: "ok" } },
  idempotent: false,
  body: { kind: "json", schema: z.object({ n: z.number() }) },
  async run() {
    return { status: 200, body: { ok: true } };
  },
});
beforeAll(() => {
  (OPERATIONS as unknown as unknown[]).push(echo);
});
beforeEach(() => {
  session.current = null;
});
afterAll(async () => {
  (OPERATIONS as unknown as unknown[]).splice((OPERATIONS as unknown as unknown[]).indexOf(echo), 1);
  await closeDb();
});

const CHUNK = 64 * 1024;

/** A body with no declared length that never ends; `pulls` counts how much of it was requested. */
function endless() {
  const state = { pulls: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls++;
      controller.enqueue(new Uint8Array(CHUNK).fill(32));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

const streamed = (url: string, stream: ReadableStream<Uint8Array>, headers: Record<string, string>) =>
  new Request(url, { method: "POST", headers, body: stream, duplex: "half" } as RequestInit);

describe("compose/check body bound", () => {
  it("answers 413 as soon as an unbounded body crosses 256 KB, without reading the rest", async () => {
    const env = await postsEnv();
    session.current = fakeSession(env.owner.id);
    const { stream, state } = endless();
    const res = await composeCheck(streamed("http://localhost/check", stream, { "content-type": "application/json" }), {
      params: Promise.resolve({ projectSlug: env.project.slug }),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ ok: false, error: "validation", message: "The request is too large." });
    expect(state.cancelled).toBe(true);
    expect(state.pulls * CHUNK).toBeLessThanOrEqual(256 * 1024 + 4 * CHUNK);
  });
});

describe("API body bound", () => {
  it("answers 413 payload_too_large for an unbounded body, having pulled about 8 MB", async () => {
    const env = await postsEnv();
    const key = await createKey(env.scope, ["read"]);
    const { stream, state } = endless();
    const res = await apiPost(
      streamed("http://localhost/api/v1/test/body-limit", stream, { "content-type": "application/json", authorization: `Bearer ${key.secret}` }),
      { params: Promise.resolve({ path: ["test", "body-limit"] }) },
    );
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("payload_too_large");
    expect(state.cancelled).toBe(true);
    expect(state.pulls * CHUNK).toBeLessThanOrEqual(8 * 1024 * 1024 + 4 * CHUNK);
  });
});
