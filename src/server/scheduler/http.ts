import { createHash, timingSafeEqual } from "node:crypto";

export interface TickRequestDeps {
  secret: string | undefined;
  runTick: () => Promise<unknown>;
}

const digest = (value: string) => createHash("sha256").update(value).digest();

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** `POST /api/internal/tick` (FR-043). Pure apart from the injected `runTick`, so tests need no env. */
export async function handleTickRequest(request: Request, deps: TickRequestDeps): Promise<Response> {
  if (!deps.secret) return json(404, { error: "not_found" });

  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  // Always compare, so every failure path costs the same.
  const given = digest(match?.[1] ?? "");
  const ok = timingSafeEqual(given, digest(deps.secret)) && match !== null;
  if (!ok) return json(401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });

  try {
    return json(200, await deps.runTick(), { "cache-control": "no-store" });
  } catch {
    return json(503, { error: "tick_failed" }, { "cache-control": "no-store" });
  }
}
