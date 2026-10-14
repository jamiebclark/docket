import { randomUUID } from "node:crypto";
import { createVoiceProfile } from "./factories";
import { jobsEnv } from "./jobs-env";

/** A jobsEnv project plus a voice profile and a `create()` helper for standing-series input (contracts/services.md §3). */
export async function standingSeriesEnv() {
  const e = await jobsEnv();
  const profile = await createVoiceProfile(e.project.id, { content: { voiceAndTone: "Warm and direct." } });
  const create = (over: Record<string, unknown> = {}) => ({
    name: `Series ${randomUUID().slice(0, 8)}`,
    brief: "Brief.",
    template: "Write a short post.",
    voiceProfileId: profile.id,
    targetAccountIds: [e.account.id],
    cadence: { count: 1, period: "day" as const },
    media: { source: "none" as const },
    approval: null,
    scheduling: null,
    confirmUnreviewedQueue: false,
    ...over,
  });
  return { ...e, profile, create };
}
