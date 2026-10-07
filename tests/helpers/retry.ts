import * as slots from "../../src/server/services/slots";
import { outcomeTarget } from "./failures";
import { postsEnv } from "./posts-env";

export const NEXT_MONDAY = "2026-10-12T09:00:00.000Z";

export async function failedTarget(text = "Hello") {
  const env = await postsEnv();
  const t = await outcomeTarget(env, "fatal", text);
  return { env, ...t };
}

export async function pauseAllSlots(env: Awaited<ReturnType<typeof postsEnv>>, accountId: string) {
  for (const s of await slots.listSlots(env.scope, accountId)) await slots.setSlotPaused(env.scope, s.id, true);
}
