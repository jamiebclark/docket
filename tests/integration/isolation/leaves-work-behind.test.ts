import { describe, expect, it } from "vitest";
import { claimDueEngagementReads } from "../../../src/server/dal/engagement-read-claims";
import { createDueTarget } from "../../helpers/scheduling";
import { postsEnv } from "../../helpers/posts-env";

// Deliberately leaves due work behind: no parking helper, no cleanup, no `afterEach`. Sorts before
// `leftovers.test.ts` (tests/integration/isolation/leftovers.test.ts), whose probe proves that
// leaving work here cannot leak into a later file's claim (SC-011).
describe("a file that leaves due work behind on purpose", () => {
  it("creates a due target and never claims it", async () => {
    const env = await postsEnv();
    const account = await env.account();
    const { target } = await createDueTarget(env.project.id, account.id);
    expect(target.status).toBe("scheduled");
  });

  it("creates an engagement-read account state lazily, then expires its own lease", async () => {
    const env = await postsEnv();
    const account = await env.account();
    // `claimDueEngagementReads` creates the state row for this account on first sight (FR-010). A
    // zero lease expires immediately, so the row is left ready to claim again — exactly the shape
    // a later file's claim must never see.
    const claimed = await claimDueEngagementReads({ now: new Date(), limit: 10, leaseMs: 0, minIntervalMs: 0, providerKeys: ["mock"] });
    expect(claimed.some((c) => c.account.id === account.id)).toBe(true);
  });
});
