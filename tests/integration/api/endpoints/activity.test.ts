import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { api, createKey, world } from "../../../helpers/api";
import { closeDb } from "../../../helpers/db";
import { parkAllDueTargets } from "../../../helpers/scheduling";

beforeEach(parkAllDueTargets);
afterAll(closeDb);

const at = (min: number) => new Date(Date.UTC(2020, 0, 1, 12, min));
const accountId = randomUUID();
const event = (i: number, extra: object = {}) => ({
  kind: "target_published" as const,
  occurredAt: at(i),
  postId: randomUUID(),
  postTargetId: randomUUID(),
  socialAccountId: accountId,
  providerKey: "bluesky",
  message: `Event ${i}`,
  details: {},
  ...extra,
});

async function setup() {
  const w = await world();
  const key = (await createKey(w.a.scope, ["read"], { rateLimitPerMinute: 1000 })).secret;
  return { w, key };
}

describe("GET /activity", () => {
  it("returns the documented shape, newest first, and no other project's events", async () => {
    const { w, key } = await setup();
    await w.a.scope.activity.insert(event(1));
    await w.a.scope.activity.insert(event(2, { kind: "target_failed", message: "Gave up", details: { attempt: 5, gaveUp: true } }));
    await w.b.scope.activity.insert(event(3, { message: "Elsewhere" }));
    const res = await api("GET", "/activity", { key });
    expect(res.status).toBe(200);
    expect(res.json.nextCursor).toBeNull();
    expect(res.json.data.map((e: { message: string }) => e.message)).toEqual(["Gave up", "Event 1"]);
    expect(res.json.data[0]).toMatchObject({
      kind: "target_failed",
      outcome: "failed",
      occurredAt: at(2).toISOString(),
      platform: "bluesky",
      platforms: ["bluesky"],
      actor: { type: "scheduler", name: "Scheduler" },
      details: { attempt: 5, gaveUp: true },
    });
    expect(res.json.data[0].occurredAtLocal).toMatch(/\[.+\]$/);
    expect(Object.keys(res.json.data[0]).sort()).toEqual(
      ["account", "actor", "details", "id", "kind", "message", "occurredAt", "occurredAtLocal", "outcome", "platform", "platforms", "post"].sort(),
    );
  });

  it("filters by outcome, preset, platform, account, dates and range", async () => {
    const { w, key } = await setup();
    const other = randomUUID();
    await w.a.scope.activity.insert(event(1));
    await w.a.scope.activity.insert(event(2, { kind: "target_failed", providerKey: "threads", socialAccountId: other }));
    await w.a.scope.activity.insert(event(3, { kind: "target_ambiguous" }));
    const msgs = async (q: string) => ((await api("GET", `/activity?${q}`, { key })).json.data as { message: string }[]).map((e) => e.message);
    expect(await msgs("outcome=failed")).toEqual(["Event 2"]);
    expect(await msgs("outcome=failed&outcome=published")).toEqual(["Event 2", "Event 1"]);
    expect(await msgs("outcome=failed,ambiguous")).toEqual(["Event 3", "Event 2"]);
    expect(await msgs("outcome=problems")).toEqual(["Event 3", "Event 2"]);
    expect(await msgs("outcome=successes")).toEqual(["Event 1"]);
    expect(await msgs("platform=threads")).toEqual(["Event 2"]);
    expect(await msgs(`account=${other}`)).toEqual(["Event 2"]);
    expect(await msgs(`account=${randomUUID()}`)).toEqual([]);
    expect(await msgs("from=2020-01-01&to=2020-01-01")).toHaveLength(3);
    expect(await msgs("from=2020-01-02")).toEqual([]);
    expect(await msgs("range=7d")).toEqual([]);
  });

  it("answers 400 per bad field, an unknown parameter, from after to, and bad cursors", async () => {
    const { key } = await setup();
    const bad = async (q: string) => api("GET", `/activity?${q}`, { key });
    for (const q of ["outcome=oops", "platform=nope", "account=nope", "from=2026-13-01", "to=yesterday", "range=1y", "limit=0", "limit=101", "cursor=!!", "bogus=1"]) {
      const res = await bad(q);
      expect(res.status, q).toBe(400);
      expect(res.json.error.code).toBe("validation_failed");
    }
    const range = await bad("from=2026-10-07&to=2026-10-01");
    expect(range.status).toBe(400);
    expect(range.json.error.details).toEqual([expect.objectContaining({ field: "from" })]);
    const cursor = await bad(`cursor=${Buffer.from("{}").toString("base64url")}`);
    expect(cursor.status).toBe(400);
    expect(cursor.json.error.details).toEqual([expect.objectContaining({ field: "cursor", message: "The cursor is not valid." })]);
    const many = await bad("outcome=oops&platform=nope");
    expect(many.json.error.details.map((d: { field: string }) => d.field)).toEqual(["outcome", "platform"]);
  });

  it("walks with the cursor, returning each event once while events are inserted mid-walk", async () => {
    const { w, key } = await setup();
    for (let i = 0; i < 7; i++) await w.a.scope.activity.insert(event(i));
    const first = await api("GET", "/activity?limit=3", { key });
    expect(first.json.data).toHaveLength(3);
    expect(first.json.nextCursor).toEqual(expect.any(String));
    for (let i = 10; i < 13; i++) await w.a.scope.activity.insert(event(i));
    const second = await api("GET", `/activity?limit=3&cursor=${first.json.nextCursor}`, { key });
    const third = await api("GET", `/activity?limit=3&cursor=${second.json.nextCursor}`, { key });
    expect(third.json.nextCursor).toBeNull();
    const seen = [...first.json.data, ...second.json.data, ...third.json.data].map((e: { message: string }) => e.message);
    expect(seen).toEqual(["Event 6", "Event 5", "Event 4", "Event 3", "Event 2", "Event 1", "Event 0"]);
  });

  it("answers 401 for a missing or revoked key and 403 without read", async () => {
    const { w, key } = await setup();
    expect((await api("GET", "/activity")).status).toBe(401);
    const noRead = (await createKey(w.a.scope, ["write_posts"], { rateLimitPerMinute: 1000 })).secret;
    const denied = await api("GET", "/activity", { key: noRead });
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe("missing_permission");
    expect((await api("GET", "/activity", { key })).status).toBe(200);
    expect((await api("GET", "/activity", { key: `${key}x` })).status).toBe(401);
  });
});
