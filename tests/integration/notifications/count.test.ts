import { afterAll, describe, expect, it } from "vitest";
import { queryObservers, type ObservedQuery } from "../../../src/server/db/client";
import { forMyProjects } from "../../../src/server/dal/my-projects";
import { unreadSummary } from "../../../src/server/services/notifications";
import { setNotificationsBySlug } from "../../../src/server/services/notifications";
import { closeDb } from "../../helpers/db";
import { addMember, createProject, createUser } from "../../helpers/factories";
import { ALL_KINDS, recordEvent, startReading } from "../../helpers/notifications";

afterAll(async () => {
  await closeDb();
});

const count = async (userId: string) => (await unreadSummary(await forMyProjects({ user: { id: userId } }))).count;

async function twoProjects() {
  const [a, b, c] = await Promise.all([createProject({ name: "Alpha" }), createProject({ name: "Bravo" }), createProject({ name: "Charlie" })]);
  const [u, v] = await Promise.all([createUser(), createUser()]);
  for (const p of [a, b]) {
    await addMember(p.id, u.id, "editor");
    await addMember(p.id, v.id, "editor");
  }
  return { a, b, c, u, v };
}

describe("unread count", () => {
  it("counts exactly the attention events after the position, across projects", async () => {
    const { a, b, u } = await twoProjects();
    for (const kind of ALL_KINDS) await recordEvent(a.id, kind, { actorUserId: u.id });
    await startReading(a.id, u.id);
    await startReading(b.id, u.id);
    expect(await count(u.id)).toBe(0);
    for (const kind of ALL_KINDS) {
      await recordEvent(a.id, kind, { actorUserId: u.id });
      await recordEvent(b.id, kind, { actorUserId: u.id });
    }
    // failed, ambiguous, needs_reauth, and U's own connect failure: 4 per project
    expect(await count(u.id)).toBe(8);
  });

  it("counts a connect failure only for the person who attempted it; a null actor counts for nobody", async () => {
    const { a, u, v } = await twoProjects();
    await startReading(a.id, u.id);
    await startReading(a.id, v.id);
    await recordEvent(a.id, "account_connect_failed", { actorUserId: v.id });
    expect(await count(u.id)).toBe(0);
    expect(await count(v.id)).toBe(1);
    await recordEvent(a.id, "account_connect_failed", { actorUserId: null });
    expect(await count(u.id)).toBe(0);
    expect(await count(v.id)).toBe(1);
  });

  it("drops a muted project and starts it from read on unmute", async () => {
    const { a, b, u } = await twoProjects();
    await startReading(a.id, u.id);
    await startReading(b.id, u.id);
    await recordEvent(a.id, "target_failed");
    await recordEvent(b.id, "target_failed");
    expect(await count(u.id)).toBe(2);
    await setNotificationsBySlug(await forMyProjects({ user: { id: u.id } }), { projectSlug: b.slug, on: "false" });
    expect(await count(u.id)).toBe(1);
    await setNotificationsBySlug(await forMyProjects({ user: { id: u.id } }), { projectSlug: b.slug, on: "true" });
    expect(await count(u.id)).toBe(1); // only A's
    await recordEvent(b.id, "target_failed");
    expect(await count(u.id)).toBe(2);
  });

  it("ignores a project the person is not in", async () => {
    const { a, c, u } = await twoProjects();
    await startReading(a.id, u.id);
    await recordEvent(c.id, "target_failed");
    expect(await count(u.id)).toBe(0);
  });

  it("stops at 100 and says so in the SQL", async () => {
    const { a, u } = await twoProjects();
    await startReading(a.id, u.id);
    for (let i = 0; i < 150; i++) await recordEvent(a.id, "target_failed");
    const seen: string[] = [];
    const obs = (q: ObservedQuery) => seen.push(q.sql);
    queryObservers.add(obs);
    let result;
    try {
      result = await unreadSummary(await forMyProjects({ user: { id: u.id } }));
    } finally {
      queryObservers.delete(obs);
    }
    expect(result.count).toBe(100);
    expect(result.display).toBe("99+");
    expect(seen.some((s) => /limit\s+\$?\d+/i.test(s) && /union all/i.test(s))).toBe(true);
  });
});
