// US4: nothing but the caller's own four-field UnreadSummary ever goes on the wire, for any event
// (contracts/stream.md §4). Responses are never cacheable or shared between callers.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { frame } from "../../../src/lib/notifications/stream-protocol";
import { openNotificationStream } from "../../../src/server/services/notifications/stream";
import { getRegistry, resetRegistryForTests, type StreamConnection } from "../../../src/server/services/notifications/stream/registry";
import { resetWatcherForTests } from "../../../src/server/services/notifications/stream/watcher";
import { actAs } from "../../helpers/actions";
import { closeDb } from "../../helpers/db";
import { addMember, createProject, createSession, createUser } from "../../helpers/factories";
import { recordEvent, startReading } from "../../helpers/notifications";
import { frameReader } from "../../helpers/stream";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);

// Every field listed in contracts/stream.md §4 as never on the wire, plus the shapes that would carry them.
const NEVER_ON_WIRE = [
  "postId",
  "eventId",
  "message",
  "projectId",
  "project_id",
  "slug",
  "accountId",
  "account_id",
  "platform",
  "providerKey",
  "email",
  "token",
  "cookie",
  "sessionId",
  "session_id",
  "userId",
  "user_id",
  "cursor",
  "seq",
  "Last-Event-ID",
];

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

describe("GET /api/me/notifications/stream — payload shape (US4)", () => {
  it("every statically producible frame carries none of the never-on-the-wire fields", () => {
    const samples = [
      frame("snapshot", { count: 3, display: "3", label: "3 unread problems", nextChangeAt: null }),
      frame("ping"),
      frame("reconnect"),
      frame("unavailable", { reason: "busy" }),
      frame("unavailable", { reason: "displaced" }),
      frame("ended", { reason: "unauthenticated" }),
    ];
    for (const raw of samples) {
      for (const field of NEVER_ON_WIRE) {
        expect(raw.toLowerCase()).not.toContain(field.toLowerCase());
      }
      expect(raw).not.toMatch(/^id:/m);
      expect(raw).not.toMatch(/^retry:/m);
    }
  });

  it("the opening snapshot's body is exactly the four UnreadSummary fields", async () => {
    const user = await signedInUser();
    const project = await createProject();
    await addMember(project.id, user.id, "editor");
    await startReading(project.id, user.id);
    await recordEvent(project.id, "target_failed");

    const { frames } = await openStream(user.id);
    const opening = await frames.next();
    expect(opening.event).toBe("snapshot");
    const body = JSON.parse(opening.data);
    expect(Object.keys(body).sort()).toEqual(["count", "display", "label", "nextChangeAt"].sort());
    for (const field of NEVER_ON_WIRE) {
      expect(opening.data.toLowerCase()).not.toContain(field.toLowerCase());
    }
  });

  it("a pushed snapshot after a change is also exactly the four fields, with nothing else added", async () => {
    const user = await signedInUser();
    const project = await createProject();
    await addMember(project.id, user.id, "editor");
    await startReading(project.id, user.id);

    const { frames } = await openStream(user.id);
    await frames.next(); // opening

    await recordEvent(project.id, "target_failed");
    const pushed = await frames.next(6_000);
    const body = JSON.parse(pushed.data);
    expect(Object.keys(body).sort()).toEqual(["count", "display", "label", "nextChangeAt"].sort());
  });

  it("the response is private, no-store, Vary: Cookie, and two callers' responses carry none of each other's data", async () => {
    const a = await signedInUser();
    const projectA = await createProject();
    await addMember(projectA.id, a.id, "editor");
    await startReading(projectA.id, a.id);
    await recordEvent(projectA.id, "target_failed");
    const { response: responseA, frames: framesA } = await openStream(a.id);

    expect(responseA.headers.get("cache-control")).toBe("private, no-store");
    expect(responseA.headers.get("vary")).toBe("Cookie");
    expect(responseA.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(responseA.headers.get("content-length")).toBeNull();
    expect(responseA.headers.get("set-cookie")).toBeNull();
    expect(responseA.headers.get("etag")).toBeNull();

    const openingA = JSON.parse((await framesA.next()).data);
    expect(openingA.count).toBe(1);

    const b = await signedInUser();
    const { response: responseB, frames: framesB } = await openStream(b.id);
    const openingB = JSON.parse((await framesB.next()).data);
    expect(openingB.count).toBe(0);
    expect(openingB).not.toEqual(openingA);
    expect(responseA).not.toBe(responseB);
  });
});
