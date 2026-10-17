import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { llmFailureMessage } from "../../../../src/server/llm/messages";
import { setLlmForTests } from "../../../../src/server/llm";
import { runTick } from "../../../../src/server/scheduler";
import { setStorageForTests } from "../../../../src/server/storage";
import { api, createKey } from "../../../helpers/api";
import { closeDb } from "../../../helpers/db";
import { createFakeLlm, type FakeStep } from "../../../helpers/fake-llm";
import type { LlmProvider } from "../../../../src/server/llm/types";
import { jobsEnv, modelOk, routeLlm, tickConfig } from "../../../helpers/jobs-env";

afterAll(async () => {
  setLlmForTests(null);
  setStorageForTests(undefined);
  await closeDb();
});

async function setup(route?: (user: string) => FakeStep | "throw") {
  const env = await jobsEnv();
  const fake = route ? routeLlm(route) : (createFakeLlm([]) as unknown as LlmProvider & { requests: string[] });
  setLlmForTests(fake);
  const key = (await createKey(env.scope, ["read", "manage_jobs"], { rateLimitPerMinute: 1000 })).secret;
  const createBody = (over: Record<string, unknown> = {}) => ({
    source: { kind: "api", fields: ["product", "price"], open: true },
    template: "Announce {{product}} at {{price}}.",
    accountIds: [env.account.id],
    voiceProfileId: env.profile.id,
    ...over,
  });
  const create = (over: Record<string, unknown> = {}) => api("POST", "/jobs", { key, body: createBody(over) });
  const add = (jobId: string, items: unknown[], idem?: string) =>
    api("POST", `/jobs/${jobId}/items`, { key, body: { items }, ...(idem ? { idem } : {}) });
  return { ...env, fake, key, create, add };
}

const item = (n: number, extra: Record<string, unknown> = {}) => ({ fields: { product: `Widget ${n}`, price: `$${n}` }, ...extra });

describe("open jobs over HTTP", () => {
  it("runs the whole flow: add batches, dedupe by key, close, generate a post per item", async () => {
    const e = await setup((user) => (user.includes("Widget 1") ? modelOk("One", 1) : modelOk("Other")));
    const image = await e.asset();
    const made = await e.create();
    expect(made.status).toBe(201);
    expect(made.json).toMatchObject({ open: true, status: "queued" });
    const jobId = made.json.id as string;

    const first = await e.add(jobId, [item(1, { mediaId: image.id }), item(2)], "batch-1");
    expect(first.status).toBe(201);
    expect(first.json).toMatchObject({ added: 2, itemCount: 2 });
    const replay = await e.add(jobId, [item(1, { mediaId: image.id }), item(2)], "batch-1");
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(replay.json.items).toEqual(first.json.items);
    const second = await e.add(jobId, [item(3)]);
    expect(second.json).toMatchObject({ added: 1, itemCount: 3 });

    const closed = await api("POST", `/jobs/${jobId}/close`, { key: e.key });
    expect(closed.status).toBe(200);
    expect(closed.json.open).toBe(false);
    const late = await e.add(jobId, [item(4)]);
    expect(late.status).toBe(409);
    expect(late.json.error.code).toBe("job_closed");

    // Ticks are global, so another file's tick may hold a lease on one of these items for a moment.
    for (let i = 0; i < 40; i++) {
      await runTick(tickConfig({ jobMaxItems: 3 }));
      if ((await e.scope.jobs.get(jobId))?.status === "completed") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const done = await api("GET", `/jobs/${jobId}`, { key: e.key });
    expect(done.json.status).toBe("completed");
    const items = await api("GET", `/jobs/${jobId}/items`, { key: e.key });
    expect(items.json.data).toHaveLength(3);
    for (const it of items.json.data) expect(it.status).toBe("done");
    const prompts = e.fake.requests.join("\n");
    for (const n of [1, 2, 3]) expect(prompts).toContain(`Widget ${n}`);
    const one = await api("GET", `/jobs/${jobId}/items/${items.json.data[0].id}`, { key: e.key });
    expect(one.status).toBe(200);
    expect(one.json).toEqual(items.json.data[0]);
    expect(items.json.data[0].mediaId).toBe(image.id);
    const list = await api("GET", "/jobs?limit=100", { key: e.key });
    expect(list.status).toBe(200);
    expect(list.json.data.find((j: { id: string }) => j.id === jobId)).toMatchObject({
      itemCount: 3,
      counts: { done: 3 },
      createdBy: { type: "api_key" },
      startedAt: expect.any(String),
    });
  }, 60_000);

  it("refuses an image reserved by another job, naming the item, and adds nothing", async () => {
    const e = await setup();
    const image = await e.asset();
    const a = (await e.create()).json.id as string;
    expect((await e.add(a, [item(1, { mediaId: image.id })])).status).toBe(201);
    const b = (await e.create()).json.id as string;
    const r = await e.add(b, [item(1), item(2, { mediaId: image.id })]);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("media_reserved");
    expect(JSON.stringify(r.json.error)).toMatch(/2/);
    expect((await api("GET", `/jobs/${b}`, { key: e.key })).json.itemCount).toBe(0);
  });

  it("caps a job at 500 items and refuses undeclared fields", async () => {
    const e = await setup();
    const id = (await e.create()).json.id as string;
    for (let i = 0; i < 5; i++) {
      const batch = Array.from({ length: 100 }, (_, n) => item(i * 100 + n));
      expect((await e.add(id, batch)).status).toBe(201);
    }
    const over = await e.add(id, [item(501)]);
    expect(over.status).toBe(400);
    expect(over.json.error.code).toBe("job_item_limit");

    const other = (await e.create()).json.id as string;
    const bad = await e.add(other, [item(1), { fields: { product: "x", colour: "red" } }]);
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.json.error)).toContain("colour");
    expect((await api("GET", `/jobs/${other}`, { key: e.key })).json.itemCount).toBe(0);
  });

  it("refuses an appended item whose rendered instructions are too long, naming it, and adds nothing", async () => {
    const e = await setup();
    const id = (await e.create()).json.id as string;
    const long = { fields: { product: "x".repeat(12_000), price: "$1" } };
    const r = await e.add(id, [item(1), long]);
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("validation_failed");
    expect(JSON.stringify(r.json.error)).toContain("items.1");
    expect((await api("GET", `/jobs/${id}`, { key: e.key })).json.itemCount).toBe(0);
  });

  it("will not close an empty open job", async () => {
    const e = await setup();
    const id = (await e.create()).json.id as string;
    const r = await api("POST", `/jobs/${id}/close`, { key: e.key });
    expect(r.status).toBe(409);
  });

  it("skips an already-posted item silently and surfaces the skip over the API", async () => {
    const e = await setup((user) => (user.includes("Widget 1") ? modelOk("One") : modelOk("Other")));
    const made = await e.create();
    const jobId = made.json.id as string;
    const first = await e.add(jobId, [item(1, { externalId: "already-posted" })]);
    expect(first.status).toBe(201);
    await api("POST", `/jobs/${jobId}/close`, { key: e.key });
    for (let i = 0; i < 40; i++) {
      await runTick(tickConfig({ jobMaxItems: 3 }));
      if ((await e.scope.jobs.get(jobId))?.status === "completed") break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const second = await e.create();
    const secondId = second.json.id as string;
    const added = await e.add(secondId, [item(1, { externalId: "already-posted" }), item(2)]);
    expect(added.status).toBe(201);
    expect(added.json).toMatchObject({ added: 1, skippedAlreadyPosted: 1, itemCount: 1 });
    await api("POST", `/jobs/${secondId}/close`, { key: e.key });

    for (let i = 0; i < 40; i++) {
      await runTick(tickConfig({ jobMaxItems: 3 }));
      if ((await e.scope.jobs.get(secondId))?.status === "completed") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const done = await api("GET", `/jobs/${secondId}`, { key: e.key });
    expect(done.json.status).toBe("completed");
    expect(done.json.counts).toMatchObject({ skipped: 0, done: 1 });

    const skippedOnly = await api("GET", `/jobs/${jobId}/items?status=skipped`, { key: e.key });
    expect(skippedOnly.json.data).toEqual([]);
  }, 60_000);

  it("ends an item skipped when its id is claimed between ingest and execution, visible on the API", async () => {
    const e = await setup();
    const made = await e.create({ source: { kind: "api", fields: ["product", "price"], open: true } });
    const jobId = made.json.id as string;
    const added = await e.add(jobId, [item(99, { externalId: "already-there" })]);
    expect(added.status).toBe(201);
    const [row] = added.json.items as [{ id: string }];

    const other = await e.scope.posts.insert({ baseText: "Already posted elsewhere" });
    await e.scope.externalClaims.insert({ sourceKey: "default", externalId: "already-there", postId: other.id, claimedAt: new Date() });

    for (let i = 0; i < 40; i++) {
      await runTick(tickConfig({ jobMaxItems: 3 }));
      const refreshed = await api("GET", `/jobs/${jobId}/items/${row.id}`, { key: e.key });
      if (refreshed.json.status === "skipped") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const itemRead = await api("GET", `/jobs/${jobId}/items/${row.id}`, { key: e.key });
    expect(itemRead.json).toMatchObject({
      status: "skipped",
      externalId: "already-there",
      error: null,
      skipped: { externalId: "already-there", postId: other.id },
    });
    expect(typeof itemRead.json.skipped.reason).toBe("string");

    const list = await api("GET", `/jobs/${jobId}/items?status=skipped`, { key: e.key });
    expect(list.json.data.map((i: { id: string }) => i.id)).toEqual([row.id]);

    const jobRead = await api("GET", `/jobs/${jobId}`, { key: e.key });
    expect(jobRead.json.counts.skipped).toBe(1);
  }, 60_000);

  it("creates media jobs from unused images and refuses csv", async () => {
    const e = await setup();
    await e.assets(2);
    const media = await e.create({
      source: { kind: "media", selection: { mode: "unused" } },
      template: "Write about this photo.",
    });
    expect(media.status).toBe(201);
    expect(media.json).toMatchObject({ open: false, itemCount: 2 });
    const csv = await e.create({ source: { kind: "csv" } });
    expect(csv.status).toBeGreaterThanOrEqual(400);
    expect(csv.status).toBeLessThan(500);
  });

  it("shows a held item as queued over the API, and a concurrent POST /generate as 503 credit_exhausted", async () => {
    const e = await setup();
    const image = await e.asset();
    const made = await e.create();
    const jobId = made.json.id as string;
    await e.add(jobId, [item(1, { mediaId: image.id })]);
    await api("POST", `/jobs/${jobId}/close`, { key: e.key });

    setLlmForTests(createFakeLlm([{ fail: "credit_exhausted" }]));
    await runTick(tickConfig({ jobMaxItems: 3 }));

    const items = await api("GET", `/jobs/${jobId}/items`, { key: e.key });
    expect(items.json.data).toHaveLength(1);
    expect(items.json.data[0]).toMatchObject({
      status: "queued",
      error: { kind: "credit_exhausted", message: llmFailureMessage("credit_exhausted") },
    });

    const jobRead = await api("GET", `/jobs/${jobId}`, { key: e.key });
    expect(jobRead.json.counts).toMatchObject({ queued: 1, failed: 0 });

    setLlmForTests(createFakeLlm([{ fail: "credit_exhausted" }]));
    const generateKey = (await createKey(e.scope, ["read", "generate"], { rateLimitPerMinute: 1000 })).secret;
    const generated = await api("POST", "/generate", {
      key: generateKey,
      body: { brief: "Announce the thing", accountIds: [e.account.id], voiceProfileId: e.profile.id },
    });
    expect(generated.status).toBe(503);
    expect(generated.json.error).toMatchObject({ code: "generation_unavailable", details: { kind: "credit_exhausted" } });
  }, 60_000);
});
