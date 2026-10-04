import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb } from "../helpers/db";
import { parkAllDueTargets } from "../helpers/scheduling";

beforeEach(parkAllDueTargets);

afterAll(async () => {
  vi.unstubAllEnvs();
  await closeDb();
});

const SECRET = "t".repeat(40);

async function post(headers: Record<string, string> = {}, query = "") {
  // The env is memoised per module instance, so load a fresh route for each secret setting.
  vi.resetModules();
  const { POST } = await import("../../src/app/api/internal/tick/route");
  return POST(new Request(`http://localhost/api/internal/tick${query}`, { method: "POST", headers }));
}

const snapshot = async (res: Response) => ({
  status: res.status,
  headers: [...res.headers.entries()].sort(),
  body: await res.text(),
});

describe("POST /api/internal/tick", () => {
  it("refuses with 401 when TICK_SECRET is unset", async () => {
    vi.stubEnv("TICK_SECRET", "");
    const res = await post({ authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("401s with a wrong secret", async () => {
    vi.stubEnv("TICK_SECRET", SECRET);
    const res = await post({ authorization: "Bearer nope" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("refuses the right secret when it also appears in the query string", async () => {
    vi.stubEnv("TICK_SECRET", SECRET);
    expect((await post({ authorization: `Bearer ${SECRET}` }, `?secret=${SECRET}`)).status).toBe(401);
    expect((await post({}, `?secret=${SECRET}`)).status).toBe(401);
  });

  it("gives the five refusals identical bytes", async () => {
    const refusals: Awaited<ReturnType<typeof snapshot>>[] = [];
    vi.stubEnv("TICK_SECRET", "");
    refusals.push(await snapshot(await post({ authorization: `Bearer ${SECRET}` })));
    vi.stubEnv("TICK_SECRET", SECRET);
    refusals.push(await snapshot(await post({})));
    refusals.push(await snapshot(await post({ authorization: `Basic ${SECRET}` })));
    refusals.push(await snapshot(await post({ authorization: "Bearer wrong" })));
    refusals.push(await snapshot(await post({ authorization: `Bearer ${SECRET}` }, `?secret=${SECRET}`)));
    for (const r of refusals) expect(r).toEqual(refusals[0]);
    expect(refusals[0]!.status).toBe(401);
  });

  it("never logs the presented value", async () => {
    vi.stubEnv("TICK_SECRET", SECRET);
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const stdout = vi.spyOn(process.stdout, "write");
    const stderr = vi.spyOn(process.stderr, "write");
    const presented = "presented-secret-value-0123456789";
    await post({ authorization: `Bearer ${presented}` }, `?secret=${presented}`);
    const seen = [...spies, stdout, stderr].flatMap((s) => s.mock.calls.map((c) => String(c[0])));
    vi.restoreAllMocks();
    expect(seen.join("\n")).not.toContain(presented);
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
