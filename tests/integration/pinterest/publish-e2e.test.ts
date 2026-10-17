import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb } from "../../helpers/db";
import { createFakePinterest, pinReply } from "../../helpers/fake-pinterest";
import { PIN_ACCESS, PIN_REFRESH, pinterestPublishSetup } from "../../helpers/pinterest-publish";
import { createMemoryStorage, type MemoryStorage } from "../../helpers/storage";

const PINS = "/v5/pins";
let fake: ReturnType<typeof createFakePinterest>;
let storage: MemoryStorage;

beforeEach(async () => {
  vi.stubEnv("PINTEREST_CLIENT_ID", "CLIENT-ID");
  vi.stubEnv("PINTEREST_CLIENT_SECRET", "CLIENT-SECRET-XYZ");
  fake = createFakePinterest().install();
  fake.secrets(PIN_ACCESS, PIN_REFRESH);
  storage = createMemoryStorage();
  setStorageForTests(storage);
});
afterEach(() => {
  fake.uninstall();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});

describe("Pinterest pin creation through the real scheduler", () => {
  it("sends exactly one create request with every field, and records the published pin", async () => {
    fake.on("POST", PINS, { kind: "ok", status: 201, body: pinReply({ id: "pin-123" }) });
    const s = await pinterestPublishSetup(storage, {
      text: "a lovely pin",
      values: { boardId: "board-1", boardName: "Recipes", title: "My title", link: "https://example.com/page" },
      altText: "a lovely photo",
    });
    expect(await s.tick()).toMatchObject({ claimed: 1, done: 1 });
    expect(fake.callsTo("POST", PINS)).toHaveLength(1);
    const req = fake.callsTo("POST", PINS)[0]!;
    expect(req.fields).toMatchObject({
      board_id: "board-1",
      media_source: { source_type: "image_url", url: expect.stringMatching(/^https:\/\//) },
      description: "a lovely pin",
      alt_text: "a lovely photo",
      title: "My title",
      link: "https://example.com/page",
    });
    const after = await s.row();
    expect(after.status).toBe("published");
    expect(after.externalId).toBe("pin-123");
    expect(after.externalUrl).toBe("https://www.pinterest.com/pin/pin-123/");

    expect(await s.tick()).toMatchObject({ claimed: 0 });
    expect(fake.callsTo("POST", PINS)).toHaveLength(1);
  });

  it("omits blank optional fields from the request", async () => {
    fake.on("POST", PINS, { kind: "ok", status: 201, body: pinReply({ id: "pin-456" }) });
    const s = await pinterestPublishSetup(storage, { text: "", values: { boardId: "board-1", boardName: "Recipes" } });
    expect(await s.tick()).toMatchObject({ claimed: 1, done: 1 });
    const req = fake.callsTo("POST", PINS)[0]!;
    expect(req.fields).not.toHaveProperty("description");
    expect(req.fields).not.toHaveProperty("title");
    expect(req.fields).not.toHaveProperty("link");
    expect(req.fields).not.toHaveProperty("alt_text");
    expect(req.fields).toMatchObject({ board_id: "board-1" });
  });
});
