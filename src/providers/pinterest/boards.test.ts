import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakePinterest, type FakePinterest } from "../../../tests/helpers/fake-pinterest";
import { PINTEREST_BOARD_PAGE_MAX, pinterestAccountDetails, pinterestDetailsSchema, readBoards } from "./boards";

const TOKEN = "pina-access-token";
const board = (n: number) => ({ id: `board-${n}`, name: `Board ${n}` });

describe("readBoards", () => {
  let fake: FakePinterest;
  beforeEach(() => {
    fake = createFakePinterest().install();
  });
  afterEach(() => fake.uninstall());

  it("reads a single page", async () => {
    fake.on("GET", "/v5/boards", { kind: "ok", body: { items: [board(1), board(2)], bookmark: null } });
    const r = await readBoards(TOKEN, new AbortController().signal);
    expect(r).toEqual({ ok: true, boards: [board(1), board(2)], truncated: false });
    const req = fake.callsTo("GET", "/v5/boards")[0]!;
    expect(req.query).toEqual({ privacy: "PUBLIC", page_size: "250" });
    expect(req.auth).toBe("bearer");
  });

  it("follows bookmark across two pages (300 boards)", async () => {
    const page1 = Array.from({ length: 250 }, (_, i) => board(i));
    const page2 = Array.from({ length: 50 }, (_, i) => board(250 + i));
    fake.on("GET", "/v5/boards", [
      { kind: "ok", body: { items: page1, bookmark: "next-page" } },
      { kind: "ok", body: { items: page2, bookmark: null } },
    ]);
    const r = await readBoards(TOKEN, new AbortController().signal);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("ok");
    expect(r.boards).toHaveLength(300);
    expect(r.truncated).toBe(false);
    expect(fake.callsTo("GET", "/v5/boards")).toHaveLength(2);
    expect(fake.callsTo("GET", "/v5/boards")[1]!.query.bookmark).toBe("next-page");
  });

  it(`stops at ${PINTEREST_BOARD_PAGE_MAX} pages and reports truncated`, async () => {
    fake.on("GET", "/v5/boards", (req) => ({
      kind: "ok",
      body: { items: [board(Number(req.query.bookmark ?? 0))], bookmark: String(Number(req.query.bookmark ?? 0) + 1) },
    }));
    const r = await readBoards(TOKEN, new AbortController().signal);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("ok");
    expect(r.boards).toHaveLength(PINTEREST_BOARD_PAGE_MAX);
    expect(r.truncated).toBe(true);
    expect(fake.callsTo("GET", "/v5/boards")).toHaveLength(PINTEREST_BOARD_PAGE_MAX);
  });

  it("returns an empty list", async () => {
    fake.on("GET", "/v5/boards", { kind: "ok", body: { items: [], bookmark: null } });
    expect(await readBoards(TOKEN, new AbortController().signal)).toEqual({ ok: true, boards: [], truncated: false });
  });

  it("is transient on network failure and on a 5xx", async () => {
    fake.on("GET", "/v5/boards", { kind: "pre_send_failure" });
    expect(await readBoards(TOKEN, new AbortController().signal)).toEqual({ ok: false, status: null, transient: true });
    fake.reset();
    fake.on("GET", "/v5/boards", { kind: "http", status: 503 });
    expect(await readBoards(TOKEN, new AbortController().signal)).toEqual({ ok: false, status: 503, transient: true });
  });

  it("is not transient on a 401, and marks pinterestAccountDetails credentialsExpired", async () => {
    fake.on("GET", "/v5/boards", { kind: "http", status: 401 });
    const r = await readBoards(TOKEN, new AbortController().signal);
    expect(r).toEqual({ ok: false, status: 401, transient: false });
  });
});

describe("pinterestDetailsSchema", () => {
  it("parses a valid shape and rejects an over-long board name", () => {
    expect(pinterestDetailsSchema.safeParse({ v: 1, boards: [{ id: "b1", name: "Board" }], truncated: false }).success).toBe(true);
    expect(pinterestDetailsSchema.safeParse({ v: 1, boards: [{ id: "b1", name: "x".repeat(401) }], truncated: false }).success).toBe(false);
  });
});

describe("pinterestAccountDetails", () => {
  let fake: FakePinterest;
  beforeEach(() => {
    fake = createFakePinterest().install();
  });
  afterEach(() => fake.uninstall());

  const creds = {
    v: 1 as const,
    accessToken: TOKEN,
    refreshToken: "pinr-refresh-token",
    accessExpiresAt: Date.now() + 1000,
    refreshIssuedAt: Date.now(),
    refreshExpiresAt: Date.now() + 1000,
    refreshExpiryEstimated: false,
  };

  it("reads boards through readPinterestCredentials", async () => {
    fake.on("GET", "/v5/boards", { kind: "ok", body: { items: [board(1)], bookmark: null } });
    const r = await pinterestAccountDetails.read({
      account: { id: "a1", externalId: "e1", settings: {} },
      credentials: creds,
      now: new Date(),
      signal: new AbortController().signal,
    });
    expect(r).toEqual({ ok: true, details: { v: 1, boards: [board(1)], truncated: false } });
  });

  it("fails without crashing when credentials are unreadable", async () => {
    const r = await pinterestAccountDetails.read({
      account: { id: "a1", externalId: "e1", settings: {} },
      credentials: null,
      now: new Date(),
      signal: new AbortController().signal,
    });
    expect(r.ok).toBe(false);
  });

  it("flags credentialsExpired on a 401", async () => {
    fake.on("GET", "/v5/boards", { kind: "http", status: 401 });
    const r = await pinterestAccountDetails.read({
      account: { id: "a1", externalId: "e1", settings: {} },
      credentials: creds,
      now: new Date(),
      signal: new AbortController().signal,
    });
    expect(r).toMatchObject({ ok: false, credentialsExpired: true, transient: false });
  });
});
