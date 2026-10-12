import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROBE_INTERVAL_MS } from "../../../src/lib/notifications/stream-protocol";
import { createNotificationsRepo } from "../../../src/server/dal/notifications";
import { openNotificationStream } from "../../../src/server/services/notifications/stream";
import { getRegistry, resetRegistryForTests, type StreamConnection } from "../../../src/server/services/notifications/stream/registry";
import { resetWatcherForTests } from "../../../src/server/services/notifications/stream/watcher";
import { actAs } from "../../helpers/actions";
import { closeDb, testDb } from "../../helpers/db";
import { addMember, createProject, createSession, createUser } from "../../helpers/factories";
import { markEventFor, recordEvent, startReading } from "../../helpers/notifications";
import { frameReader } from "../../helpers/stream";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);

const opened: StreamConnection[] = [];

/** Opens a stream for `userId` and returns its frame reader, keeping a handle for cleanup. */
async function openStream(userId: string) {
  const response = await openNotificationStream(new Request("http://localhost/api/me/notifications/stream"));
  const [connection] = getRegistry().byUser().get(userId) ?? [];
  if (connection) opened.push(connection);
  return { response, frames: frameReader(response) };
}

async function signedInUser() {
  const user = await createUser();
  const session = await createSession(user.id);
  actAs({ id: user.id }, session.id);
  return user;
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

describe("GET /api/me/notifications/stream — delivery (US1)", () => {
  it("pushes the new count within 5 seconds of a write in the same process", async () => {
    const user = await signedInUser();
    const project = await createProject();
    await addMember(project.id, user.id, "editor");
    await startReading(project.id, user.id);

    const { frames } = await openStream(user.id);
    const opening = await frames.next();
    expect(opening.event).toBe("snapshot");
    expect(JSON.parse(opening.data).count).toBe(0);

    const start = Date.now();
    await recordEvent(project.id, "target_failed");
    const pushed = await frames.next(6_000);
    const elapsed = Date.now() - start;

    expect(pushed.event).toBe("snapshot");
    expect(JSON.parse(pushed.data).count).toBe(1);
    expect(elapsed).toBeLessThan(5_000);
  });

  it("pushes the new count within 5 seconds of a write from a different process (same shared database)", async () => {
    const user = await signedInUser();
    const project = await createProject();
    await addMember(project.id, user.id, "editor");
    await startReading(project.id, user.id);

    const { frames } = await openStream(user.id);
    await frames.next(); // opening snapshot

    const start = Date.now();
    // The watcher discovers a change by polling the shared database, never by being notified — so a
    // write from another process looks identical to one in this process (N71).
    await recordEvent(project.id, "target_ambiguous");
    const pushed = await frames.next(6_000);

    expect(JSON.parse(pushed.data).count).toBe(1);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it("pushes when a snooze expires, with no new event written", async () => {
    const user = await signedInUser();
    const project = await createProject();
    await addMember(project.id, user.id, "editor");
    await startReading(project.id, user.id);
    const event = await recordEvent(project.id, "target_failed");
    await markEventFor(project.id, user.id, event.id, new Date(Date.now() + 500));

    const { frames } = await openStream(user.id);
    const opening = await frames.next();
    expect(JSON.parse(opening.data).count).toBe(0);
    expect(JSON.parse(opening.data).nextChangeAt).not.toBeNull();

    const pushed = await frames.next(PROBE_INTERVAL_MS * 3 + 2_000);
    expect(JSON.parse(pushed.data).count).toBe(1);
  });

  it("lowers the count for a second tab once the event is read elsewhere", async () => {
    const user = await signedInUser();
    const project = await createProject();
    await addMember(project.id, user.id, "editor");
    await startReading(project.id, user.id);
    await recordEvent(project.id, "target_failed");

    const first = await openStream(user.id);
    const firstOpening = await first.frames.next();
    expect(JSON.parse(firstOpening.data).count).toBe(1);

    const second = await openStream(user.id);
    await second.frames.next(); // its own opening snapshot

    // Read in the second tab's project — the same write `markAllRead` would make.
    await createNotificationsRepo(testDb(), project.id, user.id).write({ markRead: true });

    const pushedFirst = await first.frames.next(PROBE_INTERVAL_MS * 3 + 2_000);
    expect(JSON.parse(pushedFirst.data).count).toBe(0);
  });

  it("never imports or calls the problems-view marker (N82)", () => {
    for (const file of ["connection.ts", "index.ts", "watcher.ts"]) {
      const source = readFileSync(
        new URL(`../../../src/server/services/notifications/stream/${file}`, import.meta.url),
        "utf8",
      );
      expect(source).not.toContain("ensureProblemsViewMarked");
      expect(source).not.toContain("view-mark");
    }
  });
});
