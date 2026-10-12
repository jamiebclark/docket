// US5: a held connection is a held authorization decision that is re-checked (contracts/server.md §3.1,
// §4.4). `SESSION_RECHECK_MS` is shrunk for this file alone, by mocking the protocol module, so sign-out,
// expiry and replacement all take effect within a test-sized window rather than the real 60 s.

import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROBE_INTERVAL_MS } from "../../../src/lib/notifications/stream-protocol";
import { openNotificationStream } from "../../../src/server/services/notifications/stream";
import { getRegistry, resetRegistryForTests, type StreamConnection } from "../../../src/server/services/notifications/stream/registry";
import { resetWatcherForTests } from "../../../src/server/services/notifications/stream/watcher";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { member } from "../../../src/server/db/schema";
import { actAs } from "../../helpers/actions";
import { closeDb, testDb } from "../../helpers/db";
import { addMember, createProject, createSession, createUser } from "../../helpers/factories";
import { muteProject, recordEvent, startReading } from "../../helpers/notifications";
import { frameReader } from "../../helpers/stream";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("@/lib/notifications/stream-protocol", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notifications/stream-protocol")>()),
  SESSION_RECHECK_MS: 150,
}));

const opened: StreamConnection[] = [];

async function openStream(userId: string) {
  const response = await openNotificationStream(new Request("http://localhost/api/me/notifications/stream"));
  const connections = getRegistry().byUser().get(userId) ?? [];
  const connection = connections[connections.length - 1];
  if (connection) opened.push(connection);
  return { response, frames: frameReader(response) };
}

async function signedInUser() {
  const user = await createUser();
  const session = await createSession(user.id);
  actAs({ id: user.id }, session.id);
  return { user, session };
}

async function deleteSession(sessionId: string) {
  await runCrossProject("test: delete a session", async () => {
    await testDb().execute(sql`DELETE FROM session WHERE id = ${sessionId}`);
  });
}

async function expireSession(sessionId: string) {
  await runCrossProject("test: expire a session", async () => {
    await testDb().execute(sql`UPDATE session SET expires_at = now() - interval '1 hour' WHERE id = ${sessionId}`);
  });
}

async function readExpiresAt(sessionId: string) {
  return runCrossProject("test: read a session's expiry", async () => {
    const rows = await testDb().execute<{ expires_at: string }>(sql`SELECT expires_at FROM session WHERE id = ${sessionId}`);
    return rows.rows[0]?.expires_at ?? null;
  });
}

beforeEach(() => {
  resetRegistryForTests();
  resetWatcherForTests();
  opened.length = 0;
});

afterEach(() => {
  for (const c of opened) c.end("reconnect");
  opened.length = 0;
  resetRegistryForTests();
  resetWatcherForTests();
  actAs(null);
});

afterAll(async () => {
  await closeDb();
});

describe("GET /api/me/notifications/stream — teardown (US5)", () => {
  it("sign-out (the session row gone) ends the stream within the re-check window", async () => {
    const { user, session } = await signedInUser();
    const project = await createProject();
    await addMember(project.id, user.id, "editor");
    await startReading(project.id, user.id);

    const { frames } = await openStream(user.id);
    await frames.next(); // opening snapshot

    await deleteSession(session.id);

    const ended = await frames.next(2_000);
    expect(ended.event).toBe("ended");
    expect(getRegistry().byUser().get(user.id) ?? []).toEqual([]);
  });

  it("session expiry ends the stream the same way", async () => {
    const { user, session } = await signedInUser();
    const project = await createProject();
    await addMember(project.id, user.id, "editor");
    await startReading(project.id, user.id);

    const { frames } = await openStream(user.id);
    await frames.next(); // opening snapshot

    await expireSession(session.id);

    const ended = await frames.next(2_000);
    expect(ended.event).toBe("ended");
    expect(getRegistry().byUser().get(user.id) ?? []).toEqual([]);
  });

  it("a second person signing in to the same browser ends the first person's stream rather than serving their counts", async () => {
    const { user: first, session: firstSession } = await signedInUser();
    const project = await createProject();
    await addMember(project.id, first.id, "editor");
    await startReading(project.id, first.id);

    const { frames } = await openStream(first.id);
    await frames.next(); // opening snapshot

    // The browser's cookie slot is overwritten by a second person signing in: the first session row is
    // gone, replaced by one for someone else entirely. The held connection is still bound to the first
    // person's userId/sessionId from admission (contracts/server.md §4), so it must end, never adopt the
    // new session's identity.
    const second = await createUser();
    await deleteSession(firstSession.id);
    await createSession(second.id);

    const ended = await frames.next(2_000);
    expect(ended.event).toBe("ended");
    expect(ended.data).not.toContain(second.id);
  });

  it("a membership removal changes the next snapshot within 5 seconds without ending the stream", async () => {
    const { user } = await signedInUser();
    const project = await createProject();
    await addMember(project.id, user.id, "editor");
    await startReading(project.id, user.id);
    await recordEvent(project.id, "target_failed");

    const { frames } = await openStream(user.id);
    expect(JSON.parse((await frames.next()).data).count).toBe(1);

    // This was the person's only project: removing it drops the count to 0, not to any residual value.
    await runCrossProject("test: remove a membership", () =>
      testDb().delete(member).where(and(eq(member.organizationId, project.id), eq(member.userId, user.id))),
    );

    const pushed = await frames.next(PROBE_INTERVAL_MS * 3 + 2_000);
    expect(pushed.event).toBe("snapshot");
    expect(JSON.parse(pushed.data).count).toBe(0);
  });

  it("a rolled-back membership removal leaves the count unchanged", async () => {
    const { user } = await signedInUser();
    const project = await createProject();
    await addMember(project.id, user.id, "editor");
    await startReading(project.id, user.id);
    await recordEvent(project.id, "target_failed");

    const { frames } = await openStream(user.id);
    expect(JSON.parse((await frames.next()).data).count).toBe(1);

    await runCrossProject("test: a rolled-back membership removal", async () => {
      await expect(
        testDb().transaction(async (tx) => {
          await tx.delete(member).where(and(eq(member.organizationId, project.id), eq(member.userId, user.id)));
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
    });

    // Nothing actually changed, so no snapshot differing from the one already shown ever arrives.
    await expect(frames.next(PROBE_INTERVAL_MS * 2 + 1_000)).rejects.toThrow();
  });

  it("a project switched fully off from another device is reflected on the next push", async () => {
    const { user } = await signedInUser();
    const project = await createProject();
    await addMember(project.id, user.id, "editor");
    await startReading(project.id, user.id);
    await recordEvent(project.id, "target_failed");

    const { frames } = await openStream(user.id);
    expect(JSON.parse((await frames.next()).data).count).toBe(1);

    await muteProject(project.id, user.id);

    const pushed = await frames.next(PROBE_INTERVAL_MS * 3 + 2_000);
    expect(pushed.event).toBe("snapshot");
    expect(JSON.parse(pushed.data).count).toBe(0);
  });

  it("the session's expires_at is unchanged after living through several re-checks: no session extension", async () => {
    const { user, session } = await signedInUser();
    const project = await createProject();
    await addMember(project.id, user.id, "editor");
    await startReading(project.id, user.id);

    const before = await readExpiresAt(session.id);
    const { frames } = await openStream(user.id);
    await frames.next(); // opening snapshot

    // SESSION_RECHECK_MS is shrunk to 150ms for this file: wait long enough for several re-checks.
    await new Promise((resolve) => setTimeout(resolve, 800));

    const after = await readExpiresAt(session.id);
    expect(after).toEqual(before);
    expect(getRegistry().byUser().get(user.id)?.length ?? 0).toBe(1); // still live and held, not ended
  });
});
