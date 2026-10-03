import { databaseIsHealthy } from "@/server/dal";

export const dynamic = "force-dynamic";

export async function GET() {
  const ok = await databaseIsHealthy();
  return Response.json({ ok }, { status: ok ? 200 : 503 });
}
