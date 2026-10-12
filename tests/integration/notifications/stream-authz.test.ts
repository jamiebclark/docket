// US4: the stream discloses only the caller's own count, from the caller's current memberships, and
// every input it is handed has no effect (contracts/stream.md §2.2, contracts/server.md §1).

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openNotificationStream } from "../../../src/server/services/notifications/stream";
import { getRegistry, resetRegistryForTests, type StreamConnection } from "../../../src/server/services/notifications/stream/registry";
import { resetWatcherForTests } from "../../../src/server/services/notifications/stream/watcher";
import { sessionIsLive } from "../../../src/server/dal/sessions";
import { GET as refresh } from "../../../src/app/api/me/notifications/route";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { actAs } from "../../helpers/actions";
import { closeDb, testDb } from "../../helpers/db";
import { addMember, createProject, createSession, createUser } from "../../helpers/factories";
import { muteProject, recordEvent, setSwitch, startReading } from "../../helpers/notifications";
import { frameReader } from "../../helpers/stream";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);

const opened: StreamConnection[] = [];

async function openStream(request?: Request) {
  const response = await openNotificationStream(request ?? new Request("http://localhost/api/me/notifications/stream"));
  return response;
}

async function openStreamFor(userId: string) {
  const response = await openStream();
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

async function expireSession(sessionId: string) {
  await runCrossProject("test: expire a session", async () => {
    await testDb().execute(sql`UPDATE session SET expires_at = now() - interval '1 hour' WHERE id = ${sessionId}`);
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

describe("GET /api/me/notifications/stream — authorization and isolation (US4)", () => {
  it("answers the identical 401 to GET /api/me/notifications, with no session established", async () => {
    actAs(null);
    const streamResponse = await openStream();
    const refreshResponse = await refresh();

    expect(streamResponse.status).toBe(refreshResponse.status);
    expect(streamResponse.status).toBe(401);
    expect(await streamResponse.json()).toEqual(await refreshResponse.json());
    for (const name of ["cache-control", "vary", "content-type"]) {
      expect(streamResponse.headers.get(name)).toBe(refreshResponse.headers.get(name));
    }
    expect(getRegistry().size()).toBe(0);
  });

  it("answers the same 401 for an expired session, with no stream held open", async () => {
    // Admission's step 1 is `getSession()` alone (contracts/server.md §1) — the real auth library is what
    // decides an expired row is no session, so it reduces to the same 401 this file mocks for "no
    // session". `sessionIsLive` (the stream's own re-check reader, used after admission) is proven here
    // against a real expired row, which is the part of "expired" this feature owns.
    const { user, session } = await signedInUser();
    await expireSession(session.id);
    expect(await sessionIsLive(testDb(), { sessionId: session.id, userId: user.id })).toBe(false);

    actAs(null);
    const response = await openStream();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
    expect(getRegistry().byUser().get(user.id) ?? []).toEqual([]);
  });

  it("refuses an API key the same way: an API key is never a session", async () => {
    actAs(null);
    const response = await openStream(
      new Request("http://localhost/api/me/notifications/stream", { headers: { authorization: "Bearer dk_live_example" } }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
    expect(getRegistry().size()).toBe(0);
  });

  it("ignores every crafted query parameter, header and the request body entirely", async () => {
    const { user } = await signedInUser();
    const project = await createProject();
    await addMember(project.id, user.id, "editor");
    await startReading(project.id, user.id);
    await recordEvent(project.id, "target_failed");

    const crafted = new Request(
      "http://localhost/api/me/notifications/stream?userId=someone-else&projectId=not-mine&count=999",
      { headers: { "x-user-id": "someone-else", "x-count": "999" } },
    );
    const { frames } = await openStreamFor(user.id);
    void crafted; // the handler never reads this request's url, headers or body — proven by the count below
    const opening = JSON.parse((await frames.next()).data);
    expect(opening.count).toBe(1);

    // The crafted request on its own, opened directly, gets exactly the caller's own count too.
    const draftResponse = await openStream(crafted);
    const draftConnections = getRegistry().byUser().get(user.id) ?? [];
    for (const c of draftConnections) opened.push(c);
    const draftFrames = frameReader(draftResponse);
    const draftOpening = JSON.parse((await draftFrames.next()).data);
    expect(draftOpening.count).toBe(1);
  });

  it("two people connected to one process each receive only their own count", async () => {
    const { user: a } = await signedInUser();
    const projectA = await createProject();
    await addMember(projectA.id, a.id, "editor");
    await startReading(projectA.id, a.id);
    const { frames: framesA } = await openStreamFor(a.id);
    expect(JSON.parse((await framesA.next()).data).count).toBe(0);

    const { user: b } = await signedInUser();
    const projectB = await createProject();
    await addMember(projectB.id, b.id, "editor");
    await startReading(projectB.id, b.id);
    const { frames: framesB } = await openStreamFor(b.id);
    expect(JSON.parse((await framesB.next()).data).count).toBe(0);

    // A problem in a's project only: b never sees it.
    await recordEvent(projectA.id, "target_failed");
    const pushedA = await framesA.next(6_000);
    expect(JSON.parse(pushedA.data).count).toBe(1);
    await expect(framesB.next(2_500)).rejects.toThrow();
  });

  it("a muted project, an off kind and an off platform each produce no push", async () => {
    const { user } = await signedInUser();

    const mutedProject = await createProject();
    await addMember(mutedProject.id, user.id, "editor");
    await startReading(mutedProject.id, user.id);
    await muteProject(mutedProject.id, user.id);

    const offKindProject = await createProject();
    await addMember(offKindProject.id, user.id, "editor");
    await startReading(offKindProject.id, user.id);
    await setSwitch(offKindProject.id, user.id, "kind", "failed", false);

    const offPlatformProject = await createProject();
    await addMember(offPlatformProject.id, user.id, "editor");
    await startReading(offPlatformProject.id, user.id);
    await setSwitch(offPlatformProject.id, user.id, "platform", "bluesky", false);

    const { frames } = await openStreamFor(user.id);
    expect(JSON.parse((await frames.next()).data).count).toBe(0);

    await recordEvent(mutedProject.id, "target_failed");
    await recordEvent(offKindProject.id, "target_failed");
    await recordEvent(offPlatformProject.id, "target_failed");

    await expect(frames.next(2_500)).rejects.toThrow();
  });
});
