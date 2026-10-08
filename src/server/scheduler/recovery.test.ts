import { describe, expect, it } from "vitest";
import type { TargetRecord } from "../dal/targets";
import type { SchedulerConfig } from "./config";
import { recoverExpiredLease } from "./recovery";

const config = { maxAttempts: 3 } as SchedulerConfig;
const target = (over: Partial<TargetRecord>) => ({ inFlightStep: "check_publish", inFlightMayPublish: false, attemptCount: 2, ...over }) as TargetRecord;

describe("recoverExpiredLease", () => {
  it("at the cap fails a step that is not after publishing", () => {
    const r = recoverExpiredLease(target({}), config, "t1");
    expect(r).toMatchObject({ kind: "settled", outcome: "failed" });
  });
  it("at the cap settles ambiguous for a step after publishing", () => {
    const r = recoverExpiredLease(target({}), config, "t1", { afterPublish: true });
    expect(r).toMatchObject({ kind: "settled", outcome: "ambiguous", patch: { status: "ambiguous", attemptCount: 3 } });
    if (r.kind === "settled") expect(r.patch.lastError).toBe("Publishing was interrupted too many times after the post was sent; check before retrying.");
  });
  it("below the cap retries either way", () => {
    expect(recoverExpiredLease(target({ attemptCount: 0 }), config, "t1", { afterPublish: true }).kind).toBe("retry");
  });
});
