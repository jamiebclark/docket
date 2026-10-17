import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { claimDueTargets } from "../../../src/server/dal/scheduler";
import { claimDueEngagementReads } from "../../../src/server/dal/engagement-read-claims";
import { createDueTarget } from "../../helpers/scheduling";
import { postsEnv } from "../../helpers/posts-env";

/** Claims whatever is due, leasing it so a double count would show up as an error, not a pass. */
async function claimEverythingDue() {
  const now = new Date();
  return claimDueTargets({
    now,
    limit: 50,
    excludeIds: [],
    async decide() {
      return { patch: { status: "publishing", leaseOwner: randomUUID(), leaseUntil: new Date(now.getTime() + 60_000) } };
    },
  });
}

describe("leftovers: a test sees only the work it created (contracts/test-harness.md)", () => {
  // No parking helper, no filter-by-own-id trick, no `beforeEach` cleanup of its own — the default
  // reset (tests/setup/reset-database.ts) is the only isolation code in this file.

  it("claims only its own due target, even though leaves-work-behind.test.ts ran first and left one unclaimed (SC-011)", async () => {
    const env = await postsEnv();
    const account = await env.account();
    const { target } = await createDueTarget(env.project.id, account.id);

    const claimed = await claimEverythingDue();

    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.target.id).toBe(target.id);
  });

  describe("two tests in one file (FR-008)", () => {
    it("the first leaves a due target behind and does not claim it", async () => {
      const env = await postsEnv();
      const account = await env.account();
      const { target } = await createDueTarget(env.project.id, account.id);
      expect(target.status).toBe("scheduled");
    });

    it("the second's claim cannot see the first test's leftover (FR-008)", async () => {
      const env = await postsEnv();
      const account = await env.account();
      const { target } = await createDueTarget(env.project.id, account.id);

      const claimed = await claimEverythingDue();

      expect(claimed).toHaveLength(1);
      expect(claimed[0]!.target.id).toBe(target.id);
    });
  });

  describe("a lazily created state row (FR-010)", () => {
    it("the first test creates its own engagement-read state row and expires its own lease", async () => {
      const env = await postsEnv();
      const account = await env.account();
      const claimed = await claimDueEngagementReads({ now: new Date(), limit: 10, leaseMs: 0, minIntervalMs: 0, providerKeys: ["mock"] });
      expect(claimed.map((c) => c.account.id)).toEqual([account.id]);
    });

    it("the second test's claim sees none of the first test's lazily created row (FR-010)", async () => {
      const env = await postsEnv();
      const account = await env.account();
      const claimed = await claimDueEngagementReads({ now: new Date(), limit: 10, leaseMs: 0, minIntervalMs: 0, providerKeys: ["mock"] });
      expect(claimed.map((c) => c.account.id)).toEqual([account.id]);
    });
  });
});
