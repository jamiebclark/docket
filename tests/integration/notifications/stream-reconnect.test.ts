// US3: reconnection is idempotent and lossless — no resume cursor, no replay buffer, no message ids
// (N69, FR-005). `CONNECTION_LIFETIME_MS` is shrunk for this file only, so the 270s boundary is reachable
// without either faking the global clock (the watcher's own loop shares it) or a slow test.

import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openNotificationStream } from "../../../src/server/services/notifications/stream";
import { getRegistry, resetRegistryForTests, type StreamConnection } from "../../../src/server/services/notifications/stream/registry";
import { resetWatcherForTests } from "../../../src/server/services/notifications/stream/watcher";
import { actAs } from "../../helpers/actions";
import { closeDb } from "../../helpers/db";
import { addMember, createProject, createSession, createUser } from "../../helpers/factories";
import { recordEvent, startReading } from "../../helpers/notifications";
import { frameReader } from "../../helpers/stream";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);

const opened: StreamConnection[] = [];

/** Opens a stream for `userId` and returns its frame reader, keeping a handle for cleanup. */
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

describe("GET /api/me/notifications/stream — reconnection (US3)", () => {
  it("a drop with two problems written while down produces the true total exactly once on reconnect", async () => {
    const user = await signedInUser();
    const project = await createProject();
    await addMember(project.id, user.id, "editor");
    await startReading(project.id, user.id);

    const first = await openStream(user.id);
    expect(JSON.parse((await first.frames.next()).data).count).toBe(0);

    // The drop: the connection goes away with no notice to the server.
    await first.frames.close();
    first.response.body?.cancel().catch(() => {});

    await recordEvent(project.id, "target_failed");
    await recordEvent(project.id, "target_ambiguous");

    // The reconnect: a brand-new request, carrying nothing about what was missed.
    const second = await openStream(user.id);
    const opening = JSON.parse((await second.frames.next()).data);
    expect(opening.count).toBe(2); // the true total, never total-plus-missed and never a per-event increment
  });

  it("the same snapshot redelivered leaves the count unchanged: the watcher never resends an identical value", async () => {
    const user = await signedInUser();
    const project = await createProject();
    await addMember(project.id, user.id, "editor");
    await startReading(project.id, user.id);

    const { frames } = await openStream(user.id);
    expect(JSON.parse((await frames.next()).data).count).toBe(0);

    await recordEvent(project.id, "target_failed");
    expect(JSON.parse((await frames.next(6_000)).data).count).toBe(1);

    // Nothing else changes. Further probe rounds must not re-send the identical count (FR-010, N69): the
    // client's own dedup (refresh.test.ts) only ever sees a repeat as "no change", because the server
    // never produces one.
    await expect(frames.next(2_500)).rejects.toThrow();
  });

  it("a clean close at the connection's lifetime boundary is an invisible reconnect", async () => {
    // `CONNECTION_LIFETIME_MS` is shrunk for this test alone, by resetting the module graph under a
    // mock, so the 270s boundary is reachable without a slow test and without disturbing the other
    // tests in this file, which need the real lifetime.
    const SHRUNK_LIFETIME_MS = 150;
    vi.resetModules();
    vi.doMock("@/lib/notifications/stream-protocol", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/notifications/stream-protocol")>()),
      CONNECTION_LIFETIME_MS: SHRUNK_LIFETIME_MS,
    }));
    const { openNotificationStream: openShortLived } = await import("../../../src/server/services/notifications/stream");

    async function openShortStream(userId: string) {
      const response = await openShortLived(new Request("http://localhost/api/me/notifications/stream"));
      const connections = getRegistry().byUser().get(userId) ?? [];
      const connection = connections[connections.length - 1];
      if (connection) opened.push(connection);
      return { response, frames: frameReader(response) };
    }

    const user = await signedInUser();
    const project = await createProject();
    await addMember(project.id, user.id, "editor");
    await startReading(project.id, user.id);
    await recordEvent(project.id, "target_failed");

    const first = await openShortStream(user.id);
    expect(JSON.parse((await first.frames.next()).data).count).toBe(1);

    const closed = await first.frames.next(SHRUNK_LIFETIME_MS + 2_000);
    expect(closed.event).toBe("reconnect");
    expect(closed.data).toBe("");

    // The client's reaction to `reconnect` is a fresh connection, not an error (contracts/client.md §3).
    // Whether it reconnects immediately or after a backed-off delay, the result is identical: the true
    // count, not a resend of what was already on screen and not an error.
    const immediate = await openShortStream(user.id);
    expect(JSON.parse((await immediate.frames.next()).data).count).toBe(1);
    await immediate.frames.close();

    await new Promise((resolve) => setTimeout(resolve, 20));
    const delayed = await openShortStream(user.id);
    expect(JSON.parse((await delayed.frames.next()).data).count).toBe(1);

    vi.doUnmock("@/lib/notifications/stream-protocol");
    vi.resetModules();
  });

  it("never writes a message id and never reads Last-Event-ID", async () => {
    for (const file of ["connection.ts", "index.ts", "watcher.ts"]) {
      const source = readFileSync(
        new URL(`../../../src/server/services/notifications/stream/${file}`, import.meta.url),
        "utf8",
      );
      expect(source).not.toMatch(/Last-Event-ID/i);
    }

    // The frame actually written on the wire has no `id:` line, for any event — the property that lets
    // the browser omit `Last-Event-ID` in the first place (N69).
    const { frame } = await import("../../../src/lib/notifications/stream-protocol");
    expect(frame("snapshot", { count: 1, display: "1", label: "1 problem", nextChangeAt: null })).not.toMatch(/^id:/m);
    expect(frame("reconnect")).not.toMatch(/^id:/m);
    expect(frame("unavailable", { reason: "busy" })).not.toMatch(/^id:/m);
  });
});
