import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as posts from "../../../src/server/services/posts";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { LATER } from "../../helpers/failures";
import { failedTarget } from "../../helpers/retry";
import { parkAllDueTargets } from "../../helpers/scheduling";

beforeEach(parkAllDueTargets);
afterAll(async () => {
  await closeDb();
});

/** The same scope, but the project reads as being in New York. */
async function nyTarget() {
  const t = await failedTarget();
  const scope = Object.create(t.env.scope, { project: { value: { ...t.env.scope.project, timezone: "America/New_York" } } }) as typeof t.env.scope;
  return { ...t, scope };
}

describe("retry at a picked time across DST", () => {
  it.each([
    ["spring-forward gap", "2027-03-14T02:30", "gap"],
    ["fall-back overlap", "2026-11-01T01:30", "overlap"],
  ] as const)("stores the previewed instant for the %s", async (_name, local, kind) => {
    const { env, scope, targetId } = await nyTarget();
    const preview = await posts.previewExplicitTime(scope, { local, accountIds: [] });
    expect(preview.kind).toBe(kind);
    const res = await atTime(LATER, () => posts.retryTarget(env.scope, targetId, { mode: "at", at: preview.instant }));
    expect(res).toMatchObject({ status: "scheduled", scheduledAt: preview.instant });
    expect((await env.scope.targets.get(targetId))!.scheduledAt?.toISOString()).toBe(preview.instant);
  });

  it("resolves the overlap to the earlier instant", async () => {
    const { scope } = await nyTarget();
    const preview = await posts.previewExplicitTime(scope, { local: "2026-11-01T01:30", accountIds: [] });
    expect(preview.instant).toBe("2026-11-01T05:30:00.000Z");
  });
});
