// US4 §7: exactly the stream's two cross-project reasons appear, plus the two `forMyProjects()` already
// produces, and no unpinned project-owned statement is made anywhere in the admission or watcher path
// (contracts/server.md §7, FR-007).

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryObservers, type ObservedQuery } from "../../../src/server/db/client";
import { probeChangeFingerprint } from "../../../src/server/dal/notification-probe";
import { streamSessionIsLive } from "../../../src/server/dal/sessions";
import { projectOwnedTables } from "../../../src/server/db/project-owned";
import { openNotificationStream } from "../../../src/server/services/notifications/stream";
import { getRegistry, resetRegistryForTests, type StreamConnection } from "../../../src/server/services/notifications/stream/registry";
import { resetWatcherForTests } from "../../../src/server/services/notifications/stream/watcher";
import { actAs } from "../../helpers/actions";
import { closeDb } from "../../helpers/db";
import { addMember, createProject, createSession, createUser } from "../../helpers/factories";
import { recordEvent, startReading } from "../../helpers/notifications";
import { checkScope, type QueryRecord } from "../../helpers/scope-check";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);

const opened: StreamConnection[] = [];

async function capture(fn: () => Promise<unknown>): Promise<QueryRecord[]> {
  const seen: QueryRecord[] = [];
  const obs = (q: ObservedQuery) =>
    seen.push({
      sql: q.sql,
      params: q.params,
      ...(q.crossProjectReason ? { crossProjectReason: q.crossProjectReason } : {}),
      ...(q.projectSet ? { projectSet: q.projectSet } : {}),
    });
  queryObservers.add(obs);
  try {
    await fn();
  } finally {
    queryObservers.delete(obs);
  }
  return seen;
}

async function signedInUser() {
  const user = await createUser();
  const session = await createSession(user.id);
  actAs({ id: user.id }, session.id);
  return { user, session };
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

describe("the stream's statements (US4 §7)", () => {
  it("admission runs with no scope violation and no unexpected cross-project reason", async () => {
    const { user } = await signedInUser();
    const project = await createProject();
    await addMember(project.id, user.id, "editor");
    await startReading(project.id, user.id);
    await recordEvent(project.id, "target_failed");

    const records = await capture(async () => {
      const response = await openNotificationStream(new Request("http://localhost/api/me/notifications/stream"));
      const connections = getRegistry().byUser().get(user.id) ?? [];
      opened.push(...connections);
      await response.body?.cancel().catch(() => {});
    });

    const result = checkScope(records, projectOwnedTables);
    expect(result.violations).toEqual([]);
    // Admission also starts the watcher (step 8), whose first probe establishes its baseline inline.
    const reasons = new Set(result.crossProject.map((c) => c.reason));
    expect(reasons).toEqual(new Set(["resolve my projects", "notifications stream: install probe"]));
    const projectSetReasons = new Set(result.projectSet.map((c) => c.reason));
    expect(projectSetReasons).toEqual(new Set(["activity: my projects"]));
  });

  it("the watcher's own probe and session re-check use exactly their two named reasons, and nothing else", async () => {
    const { user, session } = await signedInUser();

    const records = await capture(async () => {
      await probeChangeFingerprint();
      await streamSessionIsLive({ sessionId: session.id, userId: user.id });
    });

    const result = checkScope(records, projectOwnedTables);
    expect(result.violations).toEqual([]);
    const reasons = new Set(result.crossProject.map((c) => c.reason));
    expect(reasons).toEqual(
      new Set(["notifications stream: install probe", "notifications stream: session re-check"]),
    );
  });

  it("a full round — probe, recompute and re-check together — produces exactly the four known reasons", async () => {
    const { user, session } = await signedInUser();
    const project = await createProject();
    await addMember(project.id, user.id, "editor");
    await startReading(project.id, user.id);
    await recordEvent(project.id, "target_failed");

    const { forMyProjects } = await import("../../../src/server/dal/my-projects");
    const { unreadSummary } = await import("../../../src/server/services/notifications");

    const records = await capture(async () => {
      await probeChangeFingerprint();
      await streamSessionIsLive({ sessionId: session.id, userId: user.id });
      await unreadSummary(await forMyProjects({ user: { id: user.id } }));
    });

    const result = checkScope(records, projectOwnedTables);
    expect(result.violations).toEqual([]);
    const reasons = new Set(result.crossProject.map((c) => c.reason));
    expect(reasons).toEqual(
      new Set([
        "notifications stream: install probe",
        "notifications stream: session re-check",
        "resolve my projects",
      ]),
    );
    const projectSetReasons = new Set(result.projectSet.map((c) => c.reason));
    expect(projectSetReasons).toEqual(new Set(["activity: my projects"]));
  });
});
