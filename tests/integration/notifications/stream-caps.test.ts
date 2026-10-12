// US6 §1: the operator-visible caps — the process ceiling and the per-person ceiling — and the flat,
// registry-size-independent cost of a round (contracts/server.md §1-§3, FR-009, FR-014, SC-004).

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryObservers, type ObservedQuery } from "../../../src/server/db/client";
import { probeChangeFingerprint } from "../../../src/server/dal/notification-probe";
import { openNotificationStream } from "../../../src/server/services/notifications/stream";
import { getRegistry, resetRegistryForTests, type StreamConnection } from "../../../src/server/services/notifications/stream/registry";
import { resetWatcherForTests, runRound, type WatcherDeps, type WatcherState } from "../../../src/server/services/notifications/stream/watcher";
import { actAs } from "../../helpers/actions";
import { closeDb } from "../../helpers/db";
import { createSession, createUser } from "../../helpers/factories";
import { frameReader } from "../../helpers/stream";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);

const opened: StreamConnection[] = [];

async function capture(fn: () => Promise<unknown>): Promise<ObservedQuery[]> {
  const seen: ObservedQuery[] = [];
  const obs = (q: ObservedQuery) => seen.push(q);
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

async function openStreamFor(userId: string) {
  const response = await openNotificationStream(new Request("http://localhost/api/me/notifications/stream"));
  const connections = getRegistry().byUser().get(userId) ?? [];
  const connection = connections[connections.length - 1];
  if (connection) opened.push(connection);
  return { response, frames: frameReader(response) };
}

function fakeConnection(userId: string): StreamConnection {
  return {
    id: `fake-${userId}-${Math.random()}`,
    userId,
    sessionId: "fake-session",
    openedAt: Date.now(),
    lastSent: { count: 0, nextChangeAt: null },
    write: () => true,
    end: () => {},
  };
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

describe("stream caps (US6)", () => {
  it("a process holding 50 streams refuses a 51st with `unavailable: busy` and closes nobody", async () => {
    const connections: StreamConnection[] = [];
    for (let i = 0; i < 50; i++) {
      const { user } = await signedInUser();
      const { frames } = await openStreamFor(user.id);
      await frames.next(); // the opening snapshot
      const connection = getRegistry().byUser().get(user.id)![0]!;
      connections.push(connection);
    }
    expect(getRegistry().size()).toBe(50);

    const { user: refusedUser } = await signedInUser();
    const refusedResponse = await openNotificationStream(new Request("http://localhost/api/me/notifications/stream"));
    const refusedFrames = frameReader(refusedResponse);
    const refused = await refusedFrames.next();
    expect(refused.event).toBe("unavailable");
    expect(JSON.parse(refused.data)).toEqual({ reason: "busy" });
    expect(getRegistry().byUser().get(refusedUser.id) ?? []).toEqual([]);

    // Nobody already held was closed to make room.
    expect(getRegistry().size()).toBe(50);
    for (const c of connections) expect(getRegistry().all().some((held) => held.id === c.id)).toBe(true);
  }, 30_000);

  it("a person's sixth stream closes their oldest (`unavailable: displaced`) and serves the sixth", async () => {
    const { user } = await signedInUser();
    const firstFew: { response: Response; frames: ReturnType<typeof frameReader> }[] = [];
    for (let i = 0; i < 5; i++) {
      const opened = await openStreamFor(user.id);
      await opened.frames.next(); // opening snapshot
      firstFew.push(opened);
    }
    expect(getRegistry().byUser().get(user.id)?.length).toBe(5);

    const sixth = await openStreamFor(user.id);
    const sixthOpening = await sixth.frames.next();
    expect(sixthOpening.event).toBe("snapshot");

    const oldestDisplacement = await firstFew[0]!.frames.next();
    expect(oldestDisplacement.event).toBe("unavailable");
    expect(JSON.parse(oldestDisplacement.data)).toEqual({ reason: "displaced" });

    // The oldest is gone, the rest plus the sixth remain: still five for this person.
    expect(getRegistry().byUser().get(user.id)?.length).toBe(5);
  }, 15_000);

  it("the probe makes the same number of statements at registry size 1 and registry size 50", async () => {
    const registry = getRegistry();
    registry.add(fakeConnection("solo"));
    const atOne = await capture(() => probeChangeFingerprint());

    for (let i = 0; i < 49; i++) registry.add(fakeConnection(`extra-${i}`));
    expect(registry.size()).toBe(50);
    const atFifty = await capture(() => probeChangeFingerprint());

    expect(atFifty.length).toBe(atOne.length);
  });

  it("a quiet round makes zero per-person recompute queries however many connections are registered", async () => {
    const registry = getRegistry();
    for (let i = 0; i < 50; i++) registry.add(fakeConnection(`quiet-${i}`));
    expect(registry.size()).toBe(50);

    const recompute = vi.fn();
    const deps: WatcherDeps = {
      probe: probeChangeFingerprint,
      recompute,
      sessionIsLive: async () => true,
      registry,
      now: () => Date.now(),
      sleep: async () => {},
      log: () => {},
    };

    // The first round of this state only establishes the baseline (contracts/server.md §3.2).
    const state: WatcherState = { baseline: null };
    await runRound(deps, state);
    const summary = await runRound(deps, state);

    expect(summary.ran).toBe(false);
    expect(recompute).not.toHaveBeenCalled();
  });
});
