import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePds, mintJwt, type FakePds } from "../../../tests/helpers/fake-pds";
import type { PublishContext, StepResult } from "../types";
import { advance } from "./publish";

const CREATE = "/xrpc/com.atproto.repo.createRecord";
const RESOLVE = "/xrpc/com.atproto.identity.resolveHandle";
const DID = "did:plc:alice";
const ACCESS = mintJwt(new Date("2026-01-01T01:00:00Z"));
const REFRESH = mintJwt(new Date("2026-03-01T00:00:00Z"));
const now = new Date("2026-01-01T00:00:00Z");
const CID = "bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5uxgf5kpqcsgzmq2vz2m";
const DID_A = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";

function ctx(over: Partial<Omit<PublishContext, "step">> & { text?: string; step?: string; mayPublish?: boolean } = {}): PublishContext {
  const { text, step, mayPublish, ...rest } = over;
  return {
    target: { id: "t1", scheduledAt: now, attempt: 1 },
    account: {
      id: "a1",
      externalId: DID,
      displayName: "alice.bsky.social",
      settings: { pdsUrl: "https://pds.test" },
      credentials: { accessJwt: ACCESS, refreshJwt: REFRESH, did: DID, handle: "alice.bsky.social" },
    },
    content: { text: text ?? "hello world", media: [] },
    postType: "text",
    step: { name: step ?? "create_post", mayPublish: mayPublish ?? true },
    state: null,
    now,
    signal: new AbortController().signal,
    ...rest,
  } as PublishContext;
}

const noSecrets = (result: StepResult) => {
  const json = JSON.stringify(result);
  for (const secret of [ACCESS, REFRESH]) expect(json).not.toContain(secret);
};

let pds: FakePds;
beforeEach(() => {
  pds = createFakePds();
  vi.stubGlobal("fetch", pds.fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("create_post", () => {
  it("publishes text and records the at:// id and bsky.app URL", async () => {
    pds.route("POST", CREATE, { json: { uri: `at://${DID}/app.bsky.feed.post/3kabc`, cid: CID } });
    const result = await advance(ctx());
    expect(result).toMatchObject({
      kind: "done",
      externalId: `at://${DID}/app.bsky.feed.post/3kabc`,
      url: "https://bsky.app/profile/alice.bsky.social/post/3kabc",
    });
    noSecrets(result);
    expect(JSON.stringify(result)).not.toContain("pds.test");
  });

  it("sends the record with createdAt = ctx.now, no embed, no facets and the signal", async () => {
    pds.route("POST", CREATE, { json: { uri: `at://${DID}/app.bsky.feed.post/3k`, cid: CID } });
    await advance(ctx());
    const req = pds.callsTo("POST", CREATE)[0]!;
    expect(req.headers.authorization).toBe(`Bearer ${ACCESS}`);
    expect(req.body).toEqual({
      repo: DID,
      collection: "app.bsky.feed.post",
      record: { $type: "app.bsky.feed.post", text: "hello world", createdAt: "2026-01-01T00:00:00.000Z" },
    });
  });

  it("embeds uploaded images with alt '' by default and aspectRatio only when known", async () => {
    pds.route("POST", CREATE, { json: { uri: `at://${DID}/app.bsky.feed.post/3k`, cid: CID } });
    const blob = (n: number) => ({ $type: "blob" as const, ref: { $link: `cid${n}` }, mimeType: "image/jpeg", size: 5 });
    const media = [
      { url: "u", mimeType: "image/jpeg", width: 10, height: 20, bytes: 5, altText: "a cat" },
      { url: "u", mimeType: "image/jpeg", width: null, height: null, bytes: 5, altText: "" },
    ];
    await advance(ctx({ content: { text: "pics", media }, state: { v: 1, blobs: [blob(1), blob(2)] } }));
    const record = (pds.requests[0]!.body as { record: { embed: { images: unknown[] } } }).record;
    expect(record.embed.images).toEqual([
      { image: blob(1), alt: "a cat", aspectRatio: { width: 10, height: 20 } },
      { image: blob(2), alt: "" },
    ]);
  });

  it.each([
    ["a foreign host", `at://did:plc:other/app.bsky.feed.post/3k`],
    ["a foreign collection", `at://${DID}/app.bsky.feed.like/3k`],
    ["no rkey", `at://${DID}/app.bsky.feed.post`],
    ["junk", "not a uri"],
  ])("is ambiguous when the URI has %s", async (_n, uri) => {
    pds.route("POST", CREATE, { json: { uri, cid: CID } });
    const result = await advance(ctx());
    expect(result.kind).toBe("ambiguous");
    noSecrets(result);
  });

  it("maps failures conservatively", async () => {
    const cases: [Parameters<FakePds["route"]>[2], string][] = [
      [{ status: 500, json: { error: "InternalServerError" } }, "ambiguous"],
      [{ mode: "reset-mid-body" }, "ambiguous"],
      [{ mode: "pre-send-failure" }, "retryable_error"],
      [{ status: 429, headers: { "retry-after": "30" }, json: { error: "RateLimitExceeded" } }, "retryable_error"],
      [{ status: 401, json: { error: "AuthenticationRequired" } }, "retryable_error"],
      [{ status: 400, json: { error: "InvalidRecord", message: "bad" } }, "fatal_error"],
    ];
    for (const [script, kind] of cases) {
      pds.reset();
      pds.route("POST", CREATE, script);
      const result = await advance(ctx());
      expect(result.kind).toBe(kind);
      noSecrets(result);
    }
  });

  it("flags a rejected session for refresh", async () => {
    pds.route("POST", CREATE, { status: 400, json: { error: "ExpiredToken", message: "x" } });
    expect(await advance(ctx())).toMatchObject({ kind: "retryable_error", credentialsExpired: true });
  });

  it("is ambiguous on abort", async () => {
    pds.route("POST", CREATE, { mode: "hang" });
    const ac = new AbortController();
    const pending = advance(ctx({ signal: ac.signal }));
    await vi.waitFor(() => expect(pds.requests).toHaveLength(1));
    ac.abort(new Error("timeout"));
    expect((await pending).kind).toBe("ambiguous");
  });
});

describe("resolve_mentions", () => {
  const mentionCtx = (text = "hi @a.bsky.social and @b.bsky.social") => ctx({ text, content: { text, media: [] }, step: "resolve_mentions", mayPublish: false });

  it("records DIDs, null for unresolved, sends no authorization", async () => {
    pds.route("GET", RESOLVE, (req) =>
      req.url.includes("handle=a.bsky.social") ? { json: { did: DID_A } } : { status: 400, json: { error: "InvalidRequest", message: "Unable to resolve handle" } },
    );
    const result = await advance(mentionCtx());
    expect(result).toMatchObject({
      kind: "continue",
      state: { v: 1, blobs: [], mentions: { "a.bsky.social": DID_A, "b.bsky.social": null } },
      summary: { request: { step: "resolve_mentions", mentionsResolved: 1, mentionsUnresolved: 1 } },
    });
    expect(pds.requests.every((r) => r.headers.authorization === undefined)).toBe(true);
    noSecrets(result);
  });

  it("a transient failure retries and is never ambiguous", async () => {
    for (const script of [{ status: 503, json: { error: "Unavailable" } }, { status: 429, json: {} }, { mode: "reset-mid-body" as const }, { mode: "pre-send-failure" as const }]) {
      pds.reset();
      pds.route("GET", RESOLVE, script);
      expect((await advance(mentionCtx())).kind).toBe("retryable_error");
    }
  });
});

describe("guards", () => {
  it("retries when the step no longer matches the content", async () => {
    const result = await advance(ctx({ text: "hi @a.bsky.social", content: { text: "hi @a.bsky.social", media: [] } }));
    expect(result).toEqual({ kind: "retryable_error", error: "The post changed while publishing; will retry." });
    expect(pds.requests).toHaveLength(0);
  });

  it("is fatal on unreadable state or credentials", async () => {
    expect(await advance(ctx({ state: { v: 9 } }))).toMatchObject({ kind: "fatal_error", error: expect.stringContaining("unreadable") });
    const bad = ctx();
    bad.account.credentials = { nope: true };
    expect(await advance(bad)).toMatchObject({ kind: "fatal_error", error: expect.stringContaining("credentials are unreadable") });
    expect(pds.requests).toHaveLength(0);
  });
});
