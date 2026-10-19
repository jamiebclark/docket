import { randomUUID } from "node:crypto";
import { z } from "zod";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mockProvider } from "../../../src/providers/mock";
import { getEnv } from "../../../src/server/env";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { schedulerConfig } from "../../../src/server/scheduler/config";
import { runEngagementRead } from "../../../src/server/scheduler/engagement-read";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
import { registerTestProvider } from "../../helpers/provider-fixtures";
import { parkAllEngagementReads } from "../../helpers/scheduling";
import { tickConfig } from "../../helpers/tick";

// The read claim sweeps every project and is `limit`-bounded, so accounts left active by other
// files fill the claim and squeeze this file's own account out of it. Park them first.
beforeEach(parkAllEngagementReads);

afterAll(async () => {
  await closeDb();
});

const AT = new Date("2026-10-19T12:00:00Z");
const NO_WAIT = { engagementReadMinIntervalMs: 0 };

async function runSection(now: Date) {
  const config = schedulerConfig(getEnv(), tickConfig(NO_WAIT).config);
  return atTime(now, () => runEngagementRead({ config, tickId: randomUUID(), startedAt: now }));
}

/** Every call's `providerState` is recorded in order, so a test can assert what the *next* call saw. */
const echoedStates: unknown[] = [];
let echoCalls = 0;
const echoProvider = registerTestProvider({
  ...mockProvider,
  key: "provider-state-echo-test",
  engagement: {
    declaration: { reads: ["comment"], canReply: false },
    itemDataSchema: z.object({}).passthrough(),
    stateSchema: z.object({}).passthrough(),
    async read(ctx) {
      echoCalls++;
      echoedStates.push(ctx.providerState);
      return {
        kind: "page" as const,
        items: [
          {
            kind: "comment" as const,
            externalId: `echo-${echoCalls}`,
            text: `Comment ${echoCalls}`,
            author: { displayName: null, handle: `user-${echoCalls}`, externalId: null, url: null, identityStable: false },
            saidAt: AT,
            parentExternalId: null,
          },
        ],
        cursor: null,
        exhausted: true,
        providerState: { seen: echoCalls },
      };
    },
    async send() {
      return { kind: "fatal_error" as const, error: "not used" };
    },
  },
});

/** First call inserts an item then stops; the committed `provider_state` must not move at all. */
let stopCalls = 0;
const stopProvider = registerTestProvider({
  ...mockProvider,
  key: "provider-state-stop-test",
  engagement: {
    declaration: { reads: ["comment"], canReply: false },
    itemDataSchema: z.object({}).passthrough(),
    stateSchema: z.object({}).passthrough(),
    async read() {
      stopCalls++;
      if (stopCalls === 1) {
        return {
          kind: "page" as const,
          items: [
            {
              kind: "comment" as const,
              externalId: "stop-1",
              text: "Before the stop",
              author: { displayName: null, handle: "user-stop", externalId: null, url: null, identityStable: false },
              saidAt: AT,
              parentExternalId: null,
            },
          ],
          cursor: "cursor-1",
          exhausted: false,
          providerState: { afterPage: 1 },
        };
      }
      return { kind: "retryable_error" as const, error: "Mock retryable read failure." };
    },
    async send() {
      return { kind: "fatal_error" as const, error: "not used" };
    },
  },
});

describe("the scheduler honours the provider_state field the sweep's position lives in (FR-033, FR-022, SC-006)", () => {
  it("hands a successful page's returned providerState to the provider's next read() call", async () => {
    const ctx = await createProjectWithMembers();
    const repos = forSchedulerProject(ctx.project.id);
    const account = await repos.accounts.upsertConnected({
      providerKey: echoProvider.key,
      displayName: "Echo",
      externalAccountId: "provider-state-echo",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
    });

    await runSection(AT);
    expect(echoedStates[0]).toEqual({});
    const afterFirst = await repos.engagementAccountStates.get(account.id);
    expect(afterFirst?.providerState).toEqual({ seen: 1 });

    await runSection(new Date(AT.getTime() + 60_000));
    expect(echoedStates[1]).toEqual({ seen: 1 });
    const afterSecond = await repos.engagementAccountStates.get(account.id);
    expect(afterSecond?.providerState).toEqual({ seen: 2 });
  });

  it("leaves provider_state byte-for-byte unchanged when a run stops after inserting items, while the inserted items remain committed", async () => {
    const ctx = await createProjectWithMembers();
    const repos = forSchedulerProject(ctx.project.id);
    const account = await repos.accounts.upsertConnected({
      providerKey: stopProvider.key,
      displayName: "Stop",
      externalAccountId: "provider-state-stop",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
    });
    const before = await repos.engagementAccountStates.get(account.id);
    expect(before).toBeNull();

    await runSection(AT);

    const after = await repos.engagementAccountStates.get(account.id);
    expect(after?.providerState).toEqual({});
    expect(await repos.engagementItems.getByExternalId(account.id, "stop-1")).not.toBeNull();
  });
});
