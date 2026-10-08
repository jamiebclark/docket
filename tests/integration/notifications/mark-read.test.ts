import pg from "pg";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createActivityRepo, type NewActivityEvent } from "../../../src/server/dal/activity";
import { forMyProjects } from "../../../src/server/dal/my-projects";
import {
  createNotificationsRepo,
  NotificationsBusyError,
  setNotificationsAfterLockHookForTests,
  setNotificationsLockTimeoutForTests,
} from "../../../src/server/dal/notifications";
import { queryObservers, type Database } from "../../../src/server/db/client";
import { markAllRead, markProblemsView, unreadSummary } from "../../../src/server/services/notifications";
import { closeDb, testDb } from "../../helpers/db";
import { addMember, createProject, createUser } from "../../helpers/factories";
import { recordEvent, startReading } from "../../helpers/notifications";

afterEach(() => {
  setNotificationsAfterLockHookForTests(null);
  setNotificationsLockTimeoutForTests(2000);
});
afterAll(async () => {
  await closeDb();
});

const setOf = (userId: string) => forMyProjects({ user: { id: userId } });
const count = async (userId: string) => (await unreadSummary(await setOf(userId))).count;
const repoOf = (projectId: string, userId: string) => createNotificationsRepo(testDb(), projectId, userId);
const seenSeq = async (projectId: string, userId: string) => BigInt((await repoOf(projectId, userId).get())!.seenSeq);
async function seqOf(eventId: string): Promise<bigint> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const r = await client.query("select seq::text as seq from activity_events where id = $1", [eventId]);
    return BigInt(r.rows[0].seq);
  } finally {
    await client.end();
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fixture() {
  const [project, other] = await Promise.all([createProject({ name: "Alpha" }), createProject({ name: "Bravo" })]);
  const u = await createUser();
  await addMember(project.id, u.id, "editor");
  await addMember(other.id, u.id, "editor");
  await startReading(project.id, u.id);
  await startReading(other.id, u.id);
  return { project, other, u };
}

const failedEvent = (): NewActivityEvent =>
  ({
    kind: "target_failed",
    occurredAt: new Date(),
    postId: crypto.randomUUID(),
    postTargetId: crypto.randomUUID(),
    socialAccountId: crypto.randomUUID(),
    providerKey: "bluesky",
    message: "Failed.",
    details: { attempt: 1 },
  }) as NewActivityEvent;

/** A raw connection holding the project row lock; `release` commits. */
async function holdLock(projectId: string) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query("begin");
  await client.query("select id from projects where id = $1 for update", [projectId]);
  return {
    release: async () => {
      await client.query("commit");
      await client.end();
    },
  };
}

/** Resolves once some backend is waiting on a lock. */
async function waitForLockWait(): Promise<void> {
  const probe = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await probe.connect();
  try {
    for (let i = 0; i < 60; i++) {
      const r = await probe.query("select 1 from pg_locks where not granted limit 1");
      if (r.rowCount) return;
      await sleep(50);
    }
    throw new Error("no lock wait appeared");
  } finally {
    await probe.end();
  }
}

describe("marking read is exact", () => {
  it("moves the position to the newest event and the count to zero", async () => {
    const { project, u } = await fixture();
    await recordEvent(project.id, "target_failed");
    await recordEvent(project.id, "target_failed");
    expect(await count(u.id)).toBe(2);
    const newest = await recordEvent(project.id, "target_failed");
    expect(await repoOf(project.id, u.id).write({ markRead: true })).toBe("changed");
    expect(await count(u.id)).toBe(0);
    expect(await seenSeq(project.id, u.id)).toBe(await seqOf(newest.id));
  });

  it("never moves the position backwards", async () => {
    const { project, u } = await fixture();
    const e = await recordEvent(project.id, "target_failed");
    await repoOf(project.id, u.id).write({ markRead: true });
    await repoOf(project.id, u.id).write({ markRead: true });
    expect(await seenSeq(project.id, u.id)).toBe(await seqOf(e.id));
  });

  it("takes no FOR UPDATE when nothing is newer", async () => {
    const { project, u } = await fixture();
    const seen: string[] = [];
    const obs = (q: { sql: string }) => seen.push(q.sql);
    queryObservers.add(obs);
    try {
      expect(await repoOf(project.id, u.id).write({ markRead: true })).toBe("unchanged");
    } finally {
      queryObservers.delete(obs);
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((s) => /for update/i.test(s))).toBe(false);
  });
});

describe("concurrency (quickstart §2)", () => {
  it("1. a writer started before the mark is covered by it", async () => {
    const { project, u } = await fixture();
    await recordEvent(project.id, "target_failed"); // visible, so the mark takes the lock
    let writerId = "";
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inserted!: () => void;
    const insertedP = new Promise<void>((r) => (inserted = r));
    const writer = testDb().transaction(async (tx) => {
      const e = await createActivityRepo(tx as unknown as Database, project.id).insert(failedEvent());
      writerId = e.id;
      inserted();
      await gate; // holds FOR KEY SHARE on the project row
    });
    await insertedP;
    let done = false;
    const mark = repoOf(project.id, u.id)
      .write({ markRead: true })
      .then((r) => ((done = true), r));
    await waitForLockWait();
    expect(done).toBe(false);
    release();
    await writer;
    expect(await mark).toBe("changed");
    expect(await seenSeq(project.id, u.id)).toBeGreaterThanOrEqual(await seqOf(writerId));
    expect(await count(u.id)).toBe(0);
  });

  it("2. a writer started after the mark took the lock counts", async () => {
    const { project, u } = await fixture();
    await recordEvent(project.id, "target_failed");
    let writer!: Promise<{ id: string }>;
    setNotificationsAfterLockHookForTests(async () => {
      writer = recordEvent(project.id, "target_failed");
      await waitForLockWait(); // the writer is blocked on FOR KEY SHARE behind the mark
    });
    expect(await repoOf(project.id, u.id).write({ markRead: true })).toBe("changed");
    const late = await writer;
    expect(await seqOf(late.id)).toBeGreaterThan(await seenSeq(project.id, u.id));
    expect(await count(u.id)).toBe(1);
  });

  it("3. a held lock makes the mark give up: view mark silent, mark-all busy", async () => {
    const { project, u } = await fixture();
    await recordEvent(project.id, "target_failed");
    setNotificationsLockTimeoutForTests(150);
    const before = await seenSeq(project.id, u.id);
    const lock = await holdLock(project.id);
    try {
      const set = await setOf(u.id);
      await expect(markProblemsView(set, { kind: "project", slug: project.slug })).resolves.toBeUndefined();
      expect(await seenSeq(project.id, u.id)).toBe(before);
      await expect(repoOf(project.id, u.id).write({ markRead: true })).rejects.toBeInstanceOf(NotificationsBusyError);
      expect(await markAllRead(set)).toEqual({ marked: 0, busy: ["Alpha"] });
    } finally {
      await lock.release();
    }
    expect(await count(u.id)).toBe(1);
  });

  it("4. does not deadlock with a writer inserting into two projects", async () => {
    const { project, other, u } = await fixture();
    await recordEvent(project.id, "target_failed");
    await recordEvent(other.id, "target_failed");
    const writer = testDb().transaction(async (tx) => {
      await createActivityRepo(tx as unknown as Database, project.id).insert(failedEvent());
      await sleep(150);
      await createActivityRepo(tx as unknown as Database, other.id).insert(failedEvent());
    });
    const marks = Promise.all([repoOf(project.id, u.id).write({ markRead: true }), repoOf(other.id, u.id).write({ markRead: true })]);
    const settled = await Promise.allSettled([writer, marks]);
    expect(settled.map((s) => s.status)).toEqual(["fulfilled", "fulfilled"]);
  });
});
