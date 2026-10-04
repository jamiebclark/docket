import { describe, expect, it } from "vitest";
import { createFakePds, latch, mintJwt } from "./fake-pds";

describe("fake PDS", () => {
  it("answers scripted routes in order, repeats the last, and logs requests", async () => {
    const pds = createFakePds().route("POST", "/xrpc/a", [{ status: 500, json: { error: "x" } }, { json: { ok: true } }]);
    const post = () =>
      pds.fetch("https://pds.test/xrpc/a", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer t" }, body: JSON.stringify({ n: 1 }) });
    expect((await post()).status).toBe(500);
    expect(await (await post()).json()).toEqual({ ok: true });
    expect((await post()).status).toBe(200);
    expect(pds.callsTo("POST", "/xrpc/a")).toHaveLength(3);
    expect(pds.requests[0]).toMatchObject({ method: "POST", path: "/xrpc/a", headers: { authorization: "Bearer t" }, body: { n: 1 } });
  });

  it("records binary uploads as bytes and fails on an unknown route", async () => {
    const pds = createFakePds().route("POST", "/up", { json: {} });
    await pds.fetch("https://pds.test/up", { method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array([1, 2, 3]) });
    expect(pds.requests[0]!.body).toEqual(new Uint8Array([1, 2, 3]));
    await expect(pds.fetch("https://pds.test/nope")).rejects.toThrow(/no route/);
  });

  it("hang rejects when the signal aborts", async () => {
    const pds = createFakePds().route("GET", "/h", { mode: "hang" });
    const ac = new AbortController();
    const pending = pds.fetch("https://pds.test/h", { signal: ac.signal });
    ac.abort(new Error("timed out"));
    await expect(pending).rejects.toThrow("timed out");
  });

  it("reset-mid-body errors while the body is read", async () => {
    const pds = createFakePds().route("GET", "/r", { mode: "reset-mid-body" });
    const res = await pds.fetch("https://pds.test/r");
    expect(res.status).toBe(200);
    await expect(res.text()).rejects.toThrow();
  });

  it("pre-send-failure throws a fetch-failed TypeError with a cause code", async () => {
    const pds = createFakePds().route("GET", "/p", { mode: "pre-send-failure" });
    const error = await pds.fetch("https://pds.test/p").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toBe("fetch failed");
    expect((error as { cause: { code: string } }).cause.code).toBe("ECONNREFUSED");
  });

  it("delayed holds the response until the latch is released", async () => {
    const l = latch();
    const pds = createFakePds().route("GET", "/d", { mode: "delayed", latch: l.promise, then: { json: { late: true } } });
    let settled = false;
    const pending = pds.fetch("https://pds.test/d").then((r) => ((settled = true), r));
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    l.release();
    expect(await (await pending).json()).toEqual({ late: true });
  });

  it("mints a JWT with the chosen exp", () => {
    const exp = new Date("2026-10-03T12:00:00Z");
    const payload = JSON.parse(Buffer.from(mintJwt(exp, { scope: "x" }).split(".")[1]!, "base64url").toString());
    expect(payload).toEqual({ exp: exp.getTime() / 1000, scope: "x" });
  });
});
