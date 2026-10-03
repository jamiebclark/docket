import { getEnv } from "@/server/env";
import { runTick } from "@/server/scheduler";
import { handleTickRequest } from "@/server/scheduler/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleTickRequest(request, { secret: getEnv().TICK_SECRET, runTick: () => runTick() });
}
