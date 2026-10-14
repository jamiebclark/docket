import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consentFingerprint } from "../../../src/server/services/posts/consent";
import { pinterestPostingSchema } from "../../../src/providers/pinterest/posting";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb } from "../../helpers/db";
import { createFakePinterest, pinReply, tokenReply } from "../../helpers/fake-pinterest";
import { PIN_ACCESS, PIN_REFRESH, pinterestPublishSetup } from "../../helpers/pinterest-publish";
import { createDraftPost, parkAllDueTargets } from "../../helpers/scheduling";
import { createMemoryStorage, type MemoryStorage } from "../../helpers/storage";

const PINS = "/v5/pins";
const TOKEN = "/v5/oauth/token";
let fake: ReturnType<typeof createFakePinterest>;
let storage: MemoryStorage;

beforeEach(async () => {
  await parkAllDueTargets();
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

describe("Pinterest: the outcome table through the real scheduler", () => {
  it("a connection refused before send is retried, never recorded as a failure", async () => {
    fake.on("POST", PINS, { kind: "pre_send_failure" });
    const s = await pinterestPublishSetup(storage);
    expect(await s.tick()).toMatchObject({ claimed: 1, retried: 1 });
    const row = await s.row();
    expect(row.status).toBe("scheduled");
    expect(row.lastError ?? "").toContain("Could not reach Pinterest");
  });

  it("a connection lost after send is ambiguous and never retried", async () => {
    fake.on("POST", PINS, { kind: "reset_mid_body" });
    const s = await pinterestPublishSetup(storage);
    expect(await s.tick()).toMatchObject({ claimed: 1 });
    const row = await s.row();
    expect(row.status).toBe("ambiguous");
    expect(await s.tick()).toMatchObject({ claimed: 0 });
    expect(fake.callsTo("POST", PINS)).toHaveLength(1);
  });

  it("an unparseable 2xx is ambiguous and never retried", async () => {
    fake.on("POST", PINS, { kind: "unparseable" });
    const s = await pinterestPublishSetup(storage);
    await s.tick();
    const row = await s.row();
    expect(row.status).toBe("ambiguous");
    expect(row.lastError ?? "").toContain("usable pin id");
    expect(await s.tick()).toMatchObject({ claimed: 0 });
    expect(fake.callsTo("POST", PINS)).toHaveLength(1);
  });

  it("a 2xx with no id is ambiguous and never retried", async () => {
    fake.on("POST", PINS, { kind: "ok", body: { no_id: true } });
    const s = await pinterestPublishSetup(storage);
    await s.tick();
    const row = await s.row();
    expect(row.status).toBe("ambiguous");
    expect(await s.tick()).toMatchObject({ claimed: 0 });
    expect(fake.callsTo("POST", PINS)).toHaveLength(1);
  });

  it("401 drives one refresh and one retry, publishing on the next tick", async () => {
    fake.on("POST", PINS, [{ kind: "error", status: 401, message: "Invalid token" }, { kind: "ok", body: pinReply({ id: "pin-999" }) }]);
    fake.on("POST", TOKEN, { kind: "ok", body: tokenReply({ access_token: "NEW-ACCESS", refresh_token: "NEW-REFRESH" }) });
    const s = await pinterestPublishSetup(storage);
    expect(await s.tick()).toMatchObject({ claimed: 1 });
    expect((await s.row()).status).toBe("scheduled");
    expect(fake.callsTo("POST", TOKEN)).toHaveLength(1);
    expect(await s.tick(new Date(Date.now() + 10 * 60_000))).toMatchObject({ claimed: 1, done: 1 });
    expect((await s.row()).status).toBe("published");
  });

  it("429 with a readable reset defers until it elapses", async () => {
    fake.on("POST", PINS, [{ kind: "error", status: 429, headers: { "x-ratelimit-reset": "30" } }, { kind: "ok", body: pinReply({ id: "pin-888" }) }]);
    const s = await pinterestPublishSetup(storage);
    const base = Date.now();
    await s.tick(new Date(base));
    const waiting = await s.row();
    expect(waiting.status).toBe("scheduled");
    expect(waiting.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(base + 29_000);
    await s.tick(new Date(base + 61_000));
    expect((await s.row()).status).toBe("published");
  });

  it("429 without a readable reset falls back to the engine's own backoff", async () => {
    fake.on("POST", PINS, { kind: "error", status: 429 });
    const s = await pinterestPublishSetup(storage);
    const base = Date.now();
    await s.tick(new Date(base));
    const row = await s.row();
    expect(row.status).toBe("scheduled");
    expect(row.lastError ?? "").toContain("rate limit");
  });

  it("400 is a fatal refusal", async () => {
    fake.on("POST", PINS, { kind: "error", status: 400, message: "Board is closed" });
    const s = await pinterestPublishSetup(storage);
    await s.tick();
    const row = await s.row();
    expect(row.status).toBe("failed");
    expect(row.lastError ?? "").toContain("Pinterest refused the pin.");
  });

  it("403 is a fatal refusal", async () => {
    fake.on("POST", PINS, { kind: "error", status: 403 });
    const s = await pinterestPublishSetup(storage);
    await s.tick();
    expect((await s.row()).status).toBe("failed");
  });

  it("404 names the stored board, is fatal and is never retried", async () => {
    fake.on("POST", PINS, { kind: "error", status: 404 });
    const s = await pinterestPublishSetup(storage, { values: { boardName: "Recipes" } });
    await s.tick();
    const row = await s.row();
    expect(row.status).toBe("failed");
    expect(row.lastError ?? "").toContain('"Recipes"');
    expect(fake.callsTo("POST", PINS)).toHaveLength(1);
  });

  it("another 4xx is a fatal refusal naming the status", async () => {
    fake.on("POST", PINS, { kind: "error", status: 422 });
    const s = await pinterestPublishSetup(storage);
    await s.tick();
    const row = await s.row();
    expect(row.status).toBe("failed");
    expect(row.lastError ?? "").toContain("HTTP 422");
  });

  it("5xx is ambiguous, never retried automatically", async () => {
    fake.on("POST", PINS, { kind: "error", status: 503 });
    const s = await pinterestPublishSetup(storage);
    await s.tick();
    expect((await s.row()).status).toBe("ambiguous");
    expect(await s.tick()).toMatchObject({ claimed: 0 });
    expect(fake.callsTo("POST", PINS)).toHaveLength(1);
  });
});

describe("Pinterest: the publish limit", () => {
  it("defers a target over the limit instead of failing it", async () => {
    fake.on("POST", PINS, { kind: "ok", body: pinReply({ id: "pin-1" }) });
    const s = await pinterestPublishSetup(storage);
    await s.repos.accounts.setLimit(s.accountId, { count: 1, windowSeconds: 60 });

    const { targets } = await createDraftPost(s.projectId, { baseText: "second pin", accountIds: [s.accountId], mediaIds: [s.asset.id] });
    const due = new Date(Date.now() - 60_000);
    const values = pinterestPostingSchema.parse({ boardId: "board-1", boardName: "Recipes" });
    await s.repos.targets.update(targets[0]!.id, {
      status: "scheduled",
      scheduleKind: "explicit",
      scheduledAt: due,
      nextAttemptAt: due,
      postingFields: values,
      consentAt: new Date(Date.now() - 120_000),
      consentFingerprint: consentFingerprint({ text: "second pin", mediaIds: [s.asset.id], videoEdits: [], values, details: null }),
    });

    const result = await s.tick();
    expect(result).toMatchObject({ claimed: 2, done: 1, deferred: 1 });
    const second = await s.repos.targets.get(targets[0]!.id);
    expect(second!.status).toBe("scheduled");
    expect(second!.attemptCount).toBe(0);
  });
});
