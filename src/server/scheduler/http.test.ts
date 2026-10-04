import { describe, expect, it, vi } from "vitest";
import { handleTickRequest } from "./http";

const SECRET = "s".repeat(32);
const req = (headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/internal/tick", { method: "POST", headers });

describe("handleTickRequest", () => {
  it("401s without running when no secret is configured", async () => {
    const runTick = vi.fn();
    const res = await handleTickRequest(req({ authorization: `Bearer ${SECRET}` }), { secret: undefined, runTick });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(runTick).not.toHaveBeenCalled();
  });

  it("gives an identical 401 for missing, wrong-scheme and wrong-secret auth", async () => {
    const runTick = vi.fn();
    const cases: Record<string, string>[] = [{}, { authorization: `Basic ${SECRET}` }, { authorization: "Bearer wrong" }, { authorization: "Bearer " }];
    const bodies: string[] = [];
    for (const headers of cases) {
      const res = await handleTickRequest(req(headers), { secret: SECRET, runTick });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
      bodies.push(await res.text());
    }
    expect(new Set(bodies)).toEqual(new Set(['{"error":"unauthorized"}']));
    expect(runTick).not.toHaveBeenCalled();
  });

  it("runs a tick for the right secret and returns the summary uncached", async () => {
    const runTick = vi.fn(async () => ({ tickId: "t1" }));
    const res = await handleTickRequest(req({ authorization: `Bearer ${SECRET}` }), { secret: SECRET, runTick });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ tickId: "t1" });
  });

  it("503s when the tick throws, without leaking the error", async () => {
    const runTick = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED secret-host");
    });
    const res = await handleTickRequest(req({ authorization: `Bearer ${SECRET}` }), { secret: SECRET, runTick });
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('{"error":"tick_failed"}');
  });
});
