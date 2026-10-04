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

/** Digest of a value nobody can present, so an unset secret still costs one comparison. */
const UNSET = digest("tick-secret-not-configured");

const refuse = () => json(401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });

/**
 * `POST /api/internal/tick` (FR-043, FR-022). Pure apart from the injected `runTick`, so tests need no env.
 * Every refusal (no secret configured, no or wrong bearer, secret in the query string) is the same response.
 */
export async function handleTickRequest(request: Request, deps: TickRequestDeps): Promise<Response> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  // Always compare digests, so every failure path costs the same.
  const matches = timingSafeEqual(digest(match?.[1] ?? ""), deps.secret ? digest(deps.secret) : UNSET);
  const hasQuery = new URL(request.url).search !== "";
  if (!deps.secret || match === null || !matches || hasQuery) return refuse();

  try {
    return json(200, await deps.runTick(), { "cache-control": "no-store" });
  } catch {
    return json(503, { error: "tick_failed" }, { "cache-control": "no-store" });
  }
}
