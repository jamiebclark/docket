import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { apiIdempotencyKeys } from "../../../src/server/db/schema";
import { runTick } from "../../../src/server/scheduler";
import { runHousekeeping } from "../../../src/server/scheduler/housekeeping";
import { createKey } from "../../helpers/api";
import { atTime } from "../../helpers/clock";
import { closeDb, testDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

afterAll(closeDb);

describe("housekeeping", () => {
  it("purges idempotency rows past their retention, across projects, and keeps live ones", async () => {
    const env = await postsEnv();
    const key = await createKey(env.scope, ["read"]);
    const claim = (idemKey: string) =>
      env.scope.idempotency.claim({ apiKeyId: key.id, method: "POST", route: "/x", idemKey, bodyHash: "h", holdMs: 1000 });
    await claim("old");
    await atTime(new Date(Date.now() + 6 * 24 * 3600_000), () => claim("recent"));

    const rows = () => testDb().select().from(apiIdempotencyKeys).where(eq(apiIdempotencyKeys.projectId, env.project.id));
    expect(await rows()).toHaveLength(2);
    // "old" is 8 days old and "recent" 2 days old at this point.
    await atTime(new Date(Date.now() + 8 * 24 * 3600_000), () => runHousekeeping());
    expect((await rows()).map((r) => r.idemKey)).toEqual(["recent"]);
  });

  it("is a section of the tick", async () => {
    const summary = await runTick();
    expect(summary.housekeeping.ok).toBe(true);
  });
});
