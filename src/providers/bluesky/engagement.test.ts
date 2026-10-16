import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePds, mintJwt, type FakePds } from "../../../tests/helpers/fake-pds";
import type { EngagementReadContext, EngagementSendContext } from "../types";
import { blueskyEngagement } from "./engagement";
import type { BlueskySettings } from "./settings";

const LIST = "/xrpc/app.bsky.notification.listNotifications";
const CREATE = "/xrpc/com.atproto.repo.createRecord";
const DID = "did:plc:brand";
const ACCESS = mintJwt(new Date("2026-01-01T01:00:00Z"));
const now = new Date("2026-01-01T00:00:00Z");
const CID1 = "bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5uxgf5kpqcsgzmq2vz2m";
const CID2 = "bafyreid27zk7lbis4zw5fz4podbvbs4fc5ivwbvzrjlb3fgnhxeh4r3dc4";

function readCtx(over: Partial<EngagementReadContext<BlueskySettings>> = {}): EngagementReadContext<BlueskySettings> {
  return {
    account: { id: "a1", externalId: DID, displayName: "brand.bsky.social", settings: { pdsUrl: "https://pds.test" }, credentials: { accessJwt: ACCESS, refreshJwt: "r", did: DID, handle: "brand.bsky.social" } },
    cursor: null,
    providerState: {},
    direction: "newest",
    limit: 50,
    now,
    signal: new AbortController().signal,
    ...over,
  };
}

function sendCtx(over: Partial<EngagementSendContext<BlueskySettings>> = {}): EngagementSendContext<BlueskySettings> {
  return {
    account: { id: "a1", externalId: DID, settings: { pdsUrl: "https://pds.test" }, credentials: { accessJwt: ACCESS, refreshJwt: "r", did: DID, handle: "brand.bsky.social" } },
    item: { kind: "reply", externalId: "at://did:plc:ada/app.bsky.feed.post/3k1", parentExternalId: null, data: { cid: "cid-1" } },
    text: "Thanks!",
    now,
    signal: new AbortController().signal,
    ...over,
  };
}

let pds: FakePds;
beforeEach(() => {
  pds = createFakePds();
  vi.stubGlobal("fetch", pds.fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("bluesky engagement.read()", () => {
  it("maps a page of notifications and never calls updateSeen", async () => {
    pds.route("GET", LIST, {
      json: {
        cursor: "next-cursor",
        notifications: [
          { uri: "at://did:plc:brand/app.bsky.feed.post/3kx1", cid: CID1, reason: "reply", author: { did: "did:plc:ada", handle: "ada.bsky.social" }, record: { text: "hi", createdAt: "2026-01-01T00:00:00.000Z" }, indexedAt: "2026-01-01T00:00:01.000Z", isRead: false },
          { uri: "at://did:plc:brand/app.bsky.feed.post/3kx2", cid: CID2, reason: "mention", author: { did: "did:plc:bea", handle: "bea.bsky.social" }, record: { text: "@brand hi", createdAt: "2026-01-01T00:00:02.000Z" }, indexedAt: "2026-01-01T00:00:02.000Z", isRead: false },
        ],
      },
    });
    const result = await blueskyEngagement.read(readCtx());
    expect(result.kind).toBe("page");
    if (result.kind !== "page") throw new Error("unreachable");
    expect(result.items).toHaveLength(2);
    expect(result.items[0]!.externalId).toBe("at://did:plc:brand/app.bsky.feed.post/3kx1");
    expect(result.cursor).toBe("next-cursor");
    expect(result.exhausted).toBe(false);
    expect(pds.callsTo("POST", "/xrpc/app.bsky.notification.updateSeen")).toHaveLength(0);
  });

  it("ok: exhausted when the platform returns no cursor", async () => {
    pds.route("GET", LIST, { json: { notifications: [] } });
    const result = await blueskyEngagement.read(readCtx());
    expect(result).toMatchObject({ kind: "page", items: [], cursor: null, exhausted: true });
  });

  it("retryable: a 5xx is retryable_error", async () => {
    pds.route("GET", LIST, { status: 500, json: { error: "InternalServerError" } });
    const result = await blueskyEngagement.read(readCtx());
    expect(result.kind).toBe("retryable_error");
  });

  it("rate_limited: a 429 carries retryAt", async () => {
    pds.route("GET", LIST, { status: 429, headers: { "retry-after": "30" }, json: { error: "RateLimitExceeded" } });
    const result = await blueskyEngagement.read(readCtx());
    expect(result.kind).toBe("rate_limited");
    if (result.kind !== "rate_limited") throw new Error("unreachable");
    expect(result.retryAt).toBeInstanceOf(Date);
  });

  it("credentials_invalid: a 401 is credentials_invalid", async () => {
    pds.route("GET", LIST, { status: 401, json: { error: "ExpiredToken" } });
    const result = await blueskyEngagement.read(readCtx());
    expect(result.kind).toBe("credentials_invalid");
  });

  it("fatal: unreadable stored credentials never call the platform", async () => {
    const result = await blueskyEngagement.read(readCtx({ account: { id: "a1", externalId: DID, displayName: "brand", settings: { pdsUrl: "https://pds.test" }, credentials: {} } }));
    expect(result.kind).toBe("credentials_invalid");
    expect(pds.callsTo("GET", LIST)).toHaveLength(0);
  });

  it("cursor_lost: an invalid-cursor refusal restarts from the newest page", async () => {
    pds.route("GET", LIST, { status: 400, json: { error: "InvalidRequest" } });
    const result = await blueskyEngagement.read(readCtx({ cursor: "stale" }));
    expect(result.kind).toBe("cursor_lost");
  });
});

describe("bluesky engagement.send()", () => {
  it("creates a reply with reply.root/parent and returns sent", async () => {
    pds.route("POST", CREATE, { json: { uri: `at://${DID}/app.bsky.feed.post/3kreply`, cid: CID1 } });
    const result = await blueskyEngagement.send(sendCtx());
    expect(result).toMatchObject({ kind: "sent", url: `https://bsky.app/profile/brand.bsky.social/post/3kreply` });
    const req = pds.callsTo("POST", CREATE)[0]!;
    expect(req.body).toMatchObject({
      record: { reply: { root: { uri: "at://did:plc:ada/app.bsky.feed.post/3k1", cid: "cid-1" }, parent: { uri: "at://did:plc:ada/app.bsky.feed.post/3k1", cid: "cid-1" } } },
    });
  });

  it("ambiguous: a 2xx answer with no usable uri", async () => {
    pds.route("POST", CREATE, { json: { uri: "not-a-uri", cid: CID1 } });
    const result = await blueskyEngagement.send(sendCtx());
    expect(result.kind).toBe("ambiguous");
  });

  it("fatal_error: a 400 refusal", async () => {
    pds.route("POST", CREATE, { status: 400, json: { error: "InvalidRequest" } });
    const result = await blueskyEngagement.send(sendCtx());
    expect(result.kind).toBe("fatal_error");
  });

  it("duplicate send paths are not exercised by this provider yet; a timeout is ambiguous", async () => {
    pds.route("POST", CREATE, { mode: "hang" });
    const controller = new AbortController();
    const resultPromise = blueskyEngagement.send(sendCtx({ signal: controller.signal }));
    controller.abort();
    const result = await resultPromise;
    expect(result.kind).toBe("ambiguous");
  });
});
