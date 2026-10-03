import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb } from "../helpers/db";
import { parkAllDueTargets } from "../helpers/scheduling";

beforeEach(parkAllDueTargets);

afterAll(async () => {
  vi.unstubAllEnvs();
  await closeDb();
});

const SECRET = "t".repeat(40);

async function post(headers: Record<string, string> = {}) {
  // The env is memoised per module instance, so load a fresh route for each secret setting.
  vi.resetModules();
  const { POST } = await import("../../src/app/api/internal/tick/route");
  return POST(new Request("http://localhost/api/internal/tick", { method: "POST", headers }));
}

describe("POST /api/internal/tick", () => {
  it("404s when TICK_SECRET is unset", async () => {
    vi.stubEnv("TICK_SECRET", "");
    expect((await post({ authorization: `Bearer ${SECRET}` })).status).toBe(404);
  });

  it("401s with a wrong secret", async () => {
    vi.stubEnv("TICK_SECRET", SECRET);
    const res = await post({ authorization: "Bearer nope" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("runs a tick for the right secret and returns counts only", async () => {
    vi.stubEnv("TICK_SECRET", SECRET);
    const res = await post({ authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ publishing: { ok: true }, tokenRefresh: { ok: true } });
    expect(typeof body.tickId).toBe("string");
  });
});
