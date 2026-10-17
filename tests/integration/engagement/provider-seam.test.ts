import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forProject } from "../../../src/server/dal/scope";
import { mockEngagement } from "../../../src/providers/mock/engagement";
import { listProviders } from "../../../src/providers/registry";
import { runTick } from "../../../src/server/scheduler";
import * as accounts from "../../../src/server/services/accounts";
import { listEngagementAccounts } from "../../../src/server/services/engagement/inbox";
import { fakeSession } from "../../helpers/auth";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
import { createMockAccount, parkAllEngagementReads } from "../../helpers/scheduling";

// The tick's engagement-read section claims across every project and is `limit`-bounded, so accounts
// left active by other files on this worker's database fill the claim and this file's own account is
// never read. Park them first.
beforeEach(parkAllEngagementReads);

afterAll(async () => {
  await closeDb();
});

const AT = new Date("2026-10-11T12:00:00Z");
const NO_WAIT = { engagementReadMinIntervalMs: 0 };

/** Provider keys actually registered, as quoted literals — the module-scan proof below depends on this list. */
const PROVIDER_KEYS = listProviders().map((p) => `"${p.key}"`);

const SEAM_MODULES = [
  "src/server/services/engagement/inbox.ts",
  "src/server/services/engagement/draft.ts",
  "src/server/services/engagement/review.ts",
  "src/lib/activity/details.ts",
  "src/lib/activity/outcomes.ts",
  "src/lib/activity/text.ts",
  "src/lib/notifications/attention.ts",
  "src/lib/notifications/eligibility.ts",
  "src/lib/notifications/snooze.ts",
  "src/lib/notifications/stream-protocol.ts",
  "src/lib/notifications/text.ts",
  "src/lib/notifications/types.ts",
];

describe("provider engagement seam (US4, FR-052–FR-056, SC-012)", () => {
  const originalDeclaration = mockEngagement.declaration;
  afterEach(() => {
    mockEngagement.declaration = originalDeclaration;
    vi.restoreAllMocks();
  });

  it("shows a declared-but-unavailable surface with its reason and docs link, and never calls read() (FR-055)", async () => {
    const ctx = await createProjectWithMembers();
    const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
    await accounts.connectMock(scope, { displayName: "Mock" });
    mockEngagement.declaration = {
      ...mockEngagement.declaration,
      unavailable: { reason: "Mock engagement needs a permission this install does not hold.", docsPath: "/docs/engagement" },
    };
    const readSpy = vi.spyOn(mockEngagement, "read");

    const [accountViews, tick] = await Promise.all([
      listEngagementAccounts(scope),
      atTime(AT, () => runTick({ config: NO_WAIT })),
    ]);

    expect(accountViews).toHaveLength(1);
    expect(accountViews[0]!.unavailable).toEqual({
      reason: "Mock engagement needs a permission this install does not hold.",
      docsPath: "/docs/engagement",
    });
    expect(tick.engagementRead.ok).toBe(true);
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("omits a provider with no `engagement` member, with no error (FR-053)", async () => {
    const ctx = await createProjectWithMembers();
    const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
    await createMockAccount(ctx.project.id, {}, { providerKey: "tiktok" });

    const accountViews = await listEngagementAccounts(scope);

    expect(accountViews).toEqual([]);
  });

  it("keeps every provider key out of the inbox, drafting, review, notification and activity modules (SC-012)", () => {
    for (const path of SEAM_MODULES) {
      const source = readFileSync(path, "utf8");
      for (const key of PROVIDER_KEYS) {
        expect(source.includes(key), `${path} must not mention the provider key ${key}`).toBe(false);
      }
    }
  });
});
