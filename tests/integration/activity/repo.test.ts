import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createActivityRepo, type NewActivityEvent } from "../../../src/server/dal/activity";
import { closeDb, testDb } from "../../helpers/db";
import { createProject } from "../../helpers/factories";

afterAll(async () => {
  await closeDb();
});

const T0 = new Date("2030-05-01T12:00:00.000Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

function target(kind: "target_published" | "target_failed", minutes: number, extra: Partial<NewActivityEvent> = {}): NewActivityEvent {
  return {
    kind,
    occurredAt: at(minutes),
    postId: randomUUID(),
    postTargetId: randomUUID(),
    socialAccountId: randomUUID(),
    providerKey: "mock",
    message: kind === "target_published" ? "Published." : "Failed.",
    details: kind === "target_published" ? {} : { attempt: 1 },
    ...extra,
  } as NewActivityEvent;
}

describe("activity repo", () => {
  it("inserts, lists newest first with a stable tie-break, and pages both ways", async () => {
    const p = await createProject();
    const repo = createActivityRepo(testDb(), p.id);
    const ids: string[] = [];
    for (const m of [1, 2, 2, 3]) ids.push((await repo.insert(target("target_published", m))).id);
    const q = { windows: [{ projectId: p.id, from: null, to: null }], outcomes: null, platform: null, accountId: null };

    const all = await repo.list({ ...q, cursor: null, direction: "older", limit: 10 });
    expect(all.map((r) => r.id)).toEqual([ids[3], ids[2], ids[1], ids[0]]);
    expect(all[0]!.projectSlug).toBe(p.slug);
    expect(all[0]!.occurredAt.toISOString()).toBe(at(3).toISOString());

    const first = await repo.list({ ...q, cursor: null, direction: "older", limit: 2 });
    expect(first).toHaveLength(3); // limit + 1
    const edge = first[1]!;
    const older = await repo.list({ ...q, cursor: { occurredAt: edge.occurredAt, seq: edge.seq }, direction: "older", limit: 2 });
    expect(older.map((r) => r.id)).toEqual([ids[1], ids[0]]);
    const top = all[2]!;
    const newer = await repo.list({ ...q, cursor: { occurredAt: top.occurredAt, seq: top.seq }, direction: "newer", limit: 5 });
    expect(newer.map((r) => r.id)).toEqual([ids[3], ids[2]]);
  });

  it("filters by outcome, platform, account and window, and summarises", async () => {
    const p = await createProject();
    const repo = createActivityRepo(testDb(), p.id);
    const acct = randomUUID();
    await repo.insert(target("target_published", 1, { socialAccountId: acct, providerKey: "bluesky" }));
    await repo.insert(target("target_failed", 2));
    await repo.insert({ kind: "account_connect_failed", occurredAt: at(3), providerKey: null, providerKeys: ["x", "bluesky"], groupKey: "meta", message: "No.", details: { via: "oauth", code: "platform_error" } });
    const base = { windows: [{ projectId: p.id, from: null, to: null }], outcomes: null, platform: null, accountId: null };
    const run = (o: object) => repo.list({ ...base, ...o, cursor: null, direction: "older", limit: 10 });

    expect(await run({ outcomes: ["failed"] })).toHaveLength(1);
    expect(await run({ platform: "bluesky" })).toHaveLength(2);
    expect(await run({ accountId: acct })).toHaveLength(1);
    expect(await run({ windows: [{ projectId: p.id, from: at(2), to: at(3) }] })).toHaveLength(1);
    expect(await repo.summary(base)).toEqual({ successes: 1, problems: 2 });
    expect(await repo.summary({ ...base, outcomes: ["published"] })).toEqual({ successes: 1, problems: 0 });
  });

  it("scopes to its project and rejects a foreign window before running SQL", async () => {
    const a = await createProject();
    const b = await createProject();
    await createActivityRepo(testDb(), b.id).insert(target("target_published", 1));
    const repo = createActivityRepo(testDb(), a.id);
    const q = { windows: [{ projectId: b.id, from: null, to: null }], outcomes: null, platform: null, accountId: null };
    await expect(repo.list({ ...q, cursor: null, direction: "older", limit: 5 })).rejects.toThrow(/outside this scope/);
    await expect(repo.summary(q)).rejects.toThrow(/outside this scope/);
    expect(await repo.list({ ...q, windows: [{ projectId: a.id, from: null, to: null }], cursor: null, direction: "older", limit: 5 })).toEqual([]);
  });

  it("rejects details that do not match the kind, and clips long messages", async () => {
    const p = await createProject();
    const repo = createActivityRepo(testDb(), p.id);
    await expect(repo.insert(target("target_published", 1, { details: { token: "secret" } as never }))).rejects.toThrow();
    await repo.insert(target("target_published", 2, { message: "x".repeat(600) }));
    const [row] = await repo.list({ windows: [{ projectId: p.id, from: null, to: null }], outcomes: null, platform: null, accountId: null, cursor: null, direction: "older", limit: 1 });
    expect(Array.from(row!.message)).toHaveLength(500);
  });

  it("exposes no update or delete", () => {
    expect(Object.keys(createActivityRepo(testDb(), randomUUID())).sort()).toEqual(["insert", "list", "summary"]);
  });
});
