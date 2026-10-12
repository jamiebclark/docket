// N82: a stream request is never treated as a problems view and never marks anything read, structurally
// — the admission path imports nothing from the view-mark module (contracts/server.md §1).

import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openNotificationStream } from "../../../src/server/services/notifications/stream";
import { getRegistry, resetRegistryForTests, type StreamConnection } from "../../../src/server/services/notifications/stream/registry";
import { resetWatcherForTests } from "../../../src/server/services/notifications/stream/watcher";
import { actAs } from "../../helpers/actions";
import { closeDb } from "../../helpers/db";
import { addMember, createProject, createSession, createUser } from "../../helpers/factories";
import { markEventFor, marksFor, recordEvent, startReading } from "../../helpers/notifications";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);

const opened: StreamConnection[] = [];

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

describe("the stream is never a problems view (N82)", () => {
  it("never imports or calls ensureProblemsViewMarked, markProblemsView or the view-mark module", () => {
    for (const file of ["index.ts", "connection.ts", "watcher.ts", "registry.ts"]) {
      const source = readFileSync(
        new URL(`../../../src/server/services/notifications/stream/${file}`, import.meta.url),
        "utf8",
      );
      expect(source).not.toContain("ensureProblemsViewMarked");
      expect(source).not.toContain("markProblemsView");
      expect(source).not.toContain("view-mark");
    }
  });

  it("opening a stream with a path that would mark a problems view, if it were read, marks nothing", async () => {
    const user = await signedInUser();
    const project = await createProject({ slug: "stream-view-mark" });
    await addMember(project.id, user.id, "editor");
    await startReading(project.id, user.id);
    const event = await recordEvent(project.id, "target_failed");

    const request = new Request(
      `http://localhost/api/me/notifications/stream?x-docket-path=${encodeURIComponent(`/p/${project.slug}/activity?outcome=problems`)}`,
      { headers: { "x-docket-path": `/p/${project.slug}/activity?outcome=problems` } },
    );
    const response = await openNotificationStream(request);
    const connections = getRegistry().byUser().get(user.id) ?? [];
    opened.push(...connections);
    await response.body?.cancel().catch(() => {});

    expect(await marksFor(project.id, user.id)).toEqual([]);
  });

  it("holding an open stream across other marks leaves them exactly as they were — the stream never prunes or writes a mark itself", async () => {
    const user = await signedInUser();
    const project = await createProject();
    await addMember(project.id, user.id, "editor");
    await startReading(project.id, user.id);
    const event = await recordEvent(project.id, "target_failed");
    await markEventFor(project.id, user.id, event.id);

    const response = await openNotificationStream(new Request("http://localhost/api/me/notifications/stream"));
    const connections = getRegistry().byUser().get(user.id) ?? [];
    opened.push(...connections);
    await response.body?.cancel().catch(() => {});

    expect(await marksFor(project.id, user.id)).toHaveLength(1);
  });
});
