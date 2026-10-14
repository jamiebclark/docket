import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPERATIONS, type AnyApiOperation } from "../../../src/server/api/operations";
import { PUBLISHED_TOOL_NAMES } from "../../../src/server/mcp/naming";
import { setStorageForTests } from "../../../src/server/storage";
import { createKey, world } from "../../helpers/api";
import { closeDb } from "../../helpers/db";
import { mcpCall } from "../../helpers/mcp-bridge";
import { mcpToolsCall, mcpToolsList } from "../../helpers/mcp";
import { createMemoryStorage } from "../../helpers/storage";
import { createDraftPost } from "../../helpers/scheduling";

function opFor(id: string): AnyApiOperation {
  return OPERATIONS.find((o) => o.id === id)!;
}

let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => {
  setStorageForTests(createMemoryStorage());
  w = await world();
});
afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});

describe("a real tools/list through the MCP route (spec User Story 1 acceptance 1)", () => {
  it("returns exactly the 19 published tools, each described with the project's name", async () => {
    const { status, result } = await mcpToolsList(w.a.keys.all.secret);
    expect(status).toBe(200);
    const names = result!.tools.map((t) => t.name).sort();
    expect(names).toEqual([...PUBLISHED_TOOL_NAMES].sort());
    for (const tool of result!.tools) {
      expect(tool.description, tool.name).toContain(w.a.project.name);
    }
  });

  it("answers a JSON-RPC protocol error, not a tool result, for a missing key", async () => {
    const { status, result, error } = await mcpToolsList(undefined);
    expect(result).toBeUndefined();
    expect(error).toBeDefined();
    expect(status).toBe(200);
  });
});

describe("a real tools/call through the MCP route, round-tripping the bridge (spec User Story 1 acceptance 2)", () => {
  it("matches the bridge-level result for a read tool", async () => {
    const op = opFor("listAccounts");
    const key = w.a.keys.all.secret;
    const bridged = await mcpCall(op, w.a, key);
    const protocol = await mcpToolsCall("docket_list_accounts", {}, key);
    expect(protocol.status).toBe(bridged.status);
    expect(protocol.body).toEqual(bridged.body);
    expect(protocol.isError).toBe(bridged.isError);
  });

  it("matches the bridge-level result for a write-with-confirm tool", async () => {
    const op = opFor("queuePost");
    const key = w.a.keys.all.secret;
    const { post: bridgePost } = await createDraftPost(w.a.project.id, { accountIds: [w.a.account.id], mediaIds: [w.a.media.id] });
    const { post: protocolPost } = await createDraftPost(w.a.project.id, { accountIds: [w.a.account.id], mediaIds: [w.a.media.id] });
    const bridged = await mcpCall(op, w.a, key, { confirm: true, overrides: { postId: bridgePost.id } });
    const protocol = await mcpToolsCall("docket_queue_post", { postId: protocolPost.id, confirm: true }, key);
    expect(protocol.status).toBe(bridged.status);
    expect(protocol.isError).toBe(bridged.isError);
    expect(Object.keys(protocol.body)).toEqual(Object.keys(bridged.body as object));
    expect(protocol.body.results[0].ok).toBe((bridged.body as { results: { ok: boolean }[] }).results[0]!.ok);
  });

  it("round-trips a setup tool the same way the bridge-level tests already proved (Phase 5)", async () => {
    const key = w.a.keys.manageSetup.secret;
    const body = {
      name: `P ${Math.random().toString(36).slice(2, 7)}`,
      slug: `p-${Math.random().toString(36).slice(2, 8)}`,
      timezone: "America/New_York",
      confirm: true,
    };
    const protocol = await mcpToolsCall("docket_create_project", body, key);
    expect(protocol.isError).toBe(false);
    expect(protocol.body.slug).toBe(body.slug);
    expect(protocol.body.timezone).toBe(body.timezone);
  });
});

describe("a real tools/call reports the pipeline's Retry-After and Idempotent-Replayed headers (F1, FR-015, FR-025, FR-028)", () => {
  it("folds the rate-limit wait into the error body, since a CallToolResult has no header channel", async () => {
    const key = (await createKey(w.a.scope, ["read"], { rateLimitPerMinute: 1 })).secret;
    await mcpToolsCall("docket_list_accounts", {}, key);
    const second = await mcpToolsCall("docket_list_accounts", {}, key);
    expect(second.isError).toBe(true);
    expect(second.body.error.code).toBe("rate_limited");
    expect(second.body.error.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("marks a replayed idempotent write as already replayed", async () => {
    const key = w.a.keys.write.secret;
    const idem = `proto-replay-${Math.random().toString(36).slice(2, 8)}`;
    const args = { text: "hi", accountIds: [w.a.account.id], idempotencyKey: idem };
    const idemFirst = await mcpToolsCall("docket_create_post", args, key);
    expect(idemFirst.isError, JSON.stringify(idemFirst.body)).toBe(false);
    const replay = await mcpToolsCall("docket_create_post", args, key);
    expect(replay.body).toMatchObject(idemFirst.body);
    expect(replay.body.alreadyReplayed).toBe(true);
  });
});
