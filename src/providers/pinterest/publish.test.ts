import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MediaItem, PublishContext } from "../types";
import { advancePinterest, pinUrl } from "./publish";
import { createFakePinterest, pinReply } from "../../../tests/helpers/fake-pinterest";

const PINS = "/v5/pins";
const now = new Date("2026-01-01T12:00:00.000Z");
const ACCESS = "PIN-ACCESS-0123456789";
const REFRESH = "PIN-REFRESH-0123456789";
const credentials = {
  v: 1,
  accessToken: ACCESS,
  refreshToken: REFRESH,
  accessExpiresAt: now.getTime() + 30 * 86_400_000,
  refreshIssuedAt: now.getTime(),
  refreshExpiresAt: now.getTime() + 60 * 86_400_000,
  refreshExpiryEstimated: false,
};
const values = { v: 1, boardId: "board-1", boardName: "Recipes", title: "", link: "" };
const image = (over: Partial<MediaItem> = {}): MediaItem => ({
  url: "https://media.test/pin.jpg",
  mimeType: "image/jpeg",
  width: 400,
  height: 600,
  bytes: 1234,
  altText: "",
  ...over,
});

function ctx(over: Partial<PublishContext> = {}): PublishContext {
  return {
    target: { id: "t1", scheduledAt: now, attempt: 1 },
    account: { id: "a1", externalId: "pinterest-1", displayName: "Ada", settings: {}, credentials },
    content: { text: "a lovely pin", media: [image()], posting: { values, details: null } },
    postType: "image",
    step: { name: "create_pin", mayPublish: true },
    state: null,
    now,
    signal: new AbortController().signal,
    ...over,
  };
}

let fake: ReturnType<typeof createFakePinterest>;
beforeEach(() => {
  fake = createFakePinterest().install();
  fake.secrets(ACCESS, REFRESH);
});
afterEach(() => fake.uninstall());

describe("advancePinterest guards", () => {
  it("fails without calling the network when credentials are unreadable", async () => {
    const r = await advancePinterest(ctx({ account: { id: "a1", externalId: "x", displayName: "Ada", settings: {}, credentials: null } }));
    expect(r).toMatchObject({ kind: "fatal_error", credentialsInvalid: true });
    expect(fake.callsTo("POST", PINS)).toHaveLength(0);
  });

  it("fails when posting values are unparseable", async () => {
    const r = await advancePinterest(ctx({ content: { text: "x", media: [image()], posting: { values: null, details: null } } }));
    expect(r).toMatchObject({ kind: "fatal_error" });
    expect(fake.callsTo("POST", PINS)).toHaveLength(0);
  });

  it("fails when boardId is null", async () => {
    const r = await advancePinterest(ctx({ content: { text: "x", media: [image()], posting: { values: { ...values, boardId: null }, details: null } } }));
    expect(r).toMatchObject({ kind: "fatal_error" });
    expect(fake.callsTo("POST", PINS)).toHaveLength(0);
  });

  it("fails when there is no image", async () => {
    const r = await advancePinterest(ctx({ content: { text: "x", media: [], posting: { values, details: null } } }));
    expect(r).toMatchObject({ kind: "fatal_error", error: "A Pinterest pin needs exactly one image." });
    expect(fake.callsTo("POST", PINS)).toHaveLength(0);
  });

  it("fails when there is more than one image", async () => {
    const r = await advancePinterest(ctx({ content: { text: "x", media: [image(), image()], posting: { values, details: null } } }));
    expect(r).toMatchObject({ kind: "fatal_error", error: "A Pinterest pin needs exactly one image." });
    expect(fake.callsTo("POST", PINS)).toHaveLength(0);
  });

  it("fails when the one item is a video", async () => {
    const r = await advancePinterest(ctx({ content: { text: "x", media: [image({ kind: "video" })], posting: { values, details: null } } }));
    expect(r).toMatchObject({ kind: "fatal_error", error: "A Pinterest pin needs exactly one image." });
    expect(fake.callsTo("POST", PINS)).toHaveLength(0);
  });

  it("every guard failure is a plain failure, never ambiguous", async () => {
    const results = await Promise.all([
      advancePinterest(ctx({ account: { id: "a1", externalId: "x", displayName: "Ada", settings: {}, credentials: null } })),
      advancePinterest(ctx({ content: { text: "x", media: [image()], posting: { values: null, details: null } } })),
      advancePinterest(ctx({ content: { text: "x", media: [], posting: { values, details: null } } })),
    ]);
    for (const r of results) expect(r.kind).toBe("fatal_error");
  });
});

describe("advancePinterest request body", () => {
  it("sends exactly one request with every field populated", async () => {
    fake.on("POST", PINS, { kind: "ok", body: pinReply({ id: "pin-123" }) });
    const r = await advancePinterest(
      ctx({ content: { text: "a lovely pin", media: [image({ altText: "a lovely photo" })], posting: { values: { ...values, title: "My title", link: "https://example.com/page" }, details: null } } }),
    );
    expect(r).toMatchObject({ kind: "done", externalId: "pin-123", url: pinUrl("pin-123") });
    expect(fake.callsTo("POST", PINS)).toHaveLength(1);
    expect(fake.callsTo("POST", PINS)[0]!.fields).toMatchObject({
      board_id: "board-1",
      media_source: { source_type: "image_url", url: "https://media.test/pin.jpg" },
      description: "a lovely pin",
      alt_text: "a lovely photo",
      title: "My title",
      link: "https://example.com/page",
    });
  });

  it("omits blank optional fields entirely", async () => {
    fake.on("POST", PINS, { kind: "ok", body: pinReply({ id: "pin-456" }) });
    const r = await advancePinterest(ctx({ content: { text: "", media: [image()], posting: { values, details: null } } }));
    expect(r).toMatchObject({ kind: "done" });
    const fields = fake.callsTo("POST", PINS)[0]!.fields;
    expect(fields).not.toHaveProperty("description");
    expect(fields).not.toHaveProperty("alt_text");
    expect(fields).not.toHaveProperty("title");
    expect(fields).not.toHaveProperty("link");
    expect(fields).toMatchObject({ board_id: "board-1" });
  });
});

describe("advancePinterest outcome table", () => {
  it("not_sent network failure is retryable, no message leaked", async () => {
    fake.on("POST", PINS, { kind: "pre_send_failure" });
    const r = await advancePinterest(ctx());
    expect(r).toMatchObject({ kind: "retryable_error", error: "Could not reach Pinterest; nothing was sent. Will retry." });
  });

  it("a lost connection after send is ambiguous", async () => {
    fake.on("POST", PINS, { kind: "reset_mid_body" });
    const r = await advancePinterest(ctx());
    expect(r.kind).toBe("ambiguous");
  });

  it("an unparseable 2xx is ambiguous", async () => {
    fake.on("POST", PINS, { kind: "unparseable" });
    const r = await advancePinterest(ctx());
    expect(r).toMatchObject({ kind: "ambiguous", error: expect.stringContaining("without a usable pin id") });
  });

  it("a 2xx with no id is ambiguous", async () => {
    fake.on("POST", PINS, { kind: "ok", body: { no_id: true } });
    const r = await advancePinterest(ctx());
    expect(r).toMatchObject({ kind: "ambiguous", error: expect.stringContaining("without a usable pin id") });
  });

  it("401 is retryable with credentialsExpired", async () => {
    fake.on("POST", PINS, { kind: "error", status: 401, message: "Invalid token" });
    const r = await advancePinterest(ctx());
    expect(r).toMatchObject({ kind: "retryable_error", credentialsExpired: true });
  });

  it("429 with a readable reset sets notBefore", async () => {
    fake.on("POST", PINS, { kind: "error", status: 429, headers: { "x-ratelimit-reset": "30" } });
    const r = await advancePinterest(ctx());
    expect(r.kind).toBe("retryable_error");
    expect((r as { notBefore?: Date }).notBefore).toEqual(new Date(now.getTime() + 30_000));
  });

  it("429 without a readable reset leaves notBefore unset", async () => {
    fake.on("POST", PINS, { kind: "error", status: 429 });
    const r = await advancePinterest(ctx());
    expect(r.kind).toBe("retryable_error");
    expect((r as { notBefore?: Date }).notBefore).toBeUndefined();
  });

  it("400 is a fatal refusal naming Pinterest's message", async () => {
    fake.on("POST", PINS, { kind: "error", status: 400, message: "Board is closed" });
    const r = await advancePinterest(ctx());
    expect(r).toMatchObject({ kind: "fatal_error", error: "Pinterest refused the pin. (Pinterest: Board is closed)" });
  });

  it("403 is a fatal refusal", async () => {
    fake.on("POST", PINS, { kind: "error", status: 403 });
    const r = await advancePinterest(ctx());
    expect(r).toMatchObject({ kind: "fatal_error", error: expect.stringContaining("Pinterest refused permission for this pin.") });
  });

  it("404 names the stored board and is not ambiguous", async () => {
    fake.on("POST", PINS, { kind: "error", status: 404 });
    const r = await advancePinterest(ctx());
    expect(r).toMatchObject({ kind: "fatal_error", error: expect.stringContaining('"Recipes"') });
  });

  it("another 4xx is a fatal refusal naming the status", async () => {
    fake.on("POST", PINS, { kind: "error", status: 422 });
    const r = await advancePinterest(ctx());
    expect(r).toMatchObject({ kind: "fatal_error", error: expect.stringContaining("Pinterest refused the pin (HTTP 422).") });
  });

  it("5xx is ambiguous, not retryable", async () => {
    fake.on("POST", PINS, { kind: "error", status: 503 });
    const r = await advancePinterest(ctx());
    expect(r.kind).toBe("ambiguous");
  });
});
