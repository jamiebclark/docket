import { afterEach, describe, expect, it } from "vitest";
import { createFakeGraph } from "./fake-graph";

const graph = createFakeGraph();
afterEach(() => {
  graph.uninstall();
  graph.reset();
});

const url = (path: string, query = "") => `https://graph.example.test${path}${query}`;

describe("fake Graph", () => {
  it("replies by method and path, logs the request, and never records the token", async () => {
    graph.install().on("GET", "/v21.0/me", { kind: "ok", body: { id: "1" } });
    const res = await fetch(url("/v21.0/me", "?fields=id&access_token=SECRETTOKEN"));
    expect(await res.json()).toEqual({ id: "1" });
    expect(graph.requests).toEqual([
      { method: "GET", path: "/v21.0/me", host: "graph.example.test", params: { fields: "id", access_token: "[redacted]" }, hadToken: true, headers: {}, bodyBytes: 0 },
    ]);
    expect(JSON.stringify(graph.requests)).not.toContain("SECRETTOKEN");
  });

  it("reads form bodies, and consumes a list in order repeating the last", async () => {
    graph
      .install()
      .on("POST", "/v21.0/9/feed", [{ kind: "http", status: 503 }, { kind: "ok", body: { id: "9_1" } }]);
    const post = () => fetch(url("/v21.0/9/feed"), { method: "POST", body: new URLSearchParams({ message: "hi", access_token: "T" }) });
    expect((await post()).status).toBe(503);
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    expect(graph.requests[0]?.params).toEqual({ message: "hi", access_token: "[redacted]" });
  });

  it("renders a Graph error body", async () => {
    graph.install().on("GET", "/x", { kind: "graph_error", code: 190, subcode: 463, message: "expired" });
    const res = await fetch(url("/x"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 190, error_subcode: 463, message: "expired" } });
  });

  it("answers unscripted requests with a 404 Graph error", async () => {
    graph.install();
    expect((await fetch(url("/nope"))).status).toBe(404);
  });

  it("returns an unparseable 2xx and a 2xx without an id", async () => {
    graph.install().on("GET", "/a", { kind: "unparseable" }).on("GET", "/b", { kind: "missing_id" });
    await expect((await fetch(url("/a"))).json()).rejects.toThrow();
    expect(await (await fetch(url("/b"))).json()).not.toHaveProperty("id");
  });

  it("hangs until the signal aborts", async () => {
    graph.install().on("GET", "/h", { kind: "hang" });
    const pending = fetch(url("/h"), { signal: AbortSignal.timeout(20) });
    await expect(pending).rejects.toBeDefined();
  });

  it("resets mid-body", async () => {
    graph.install().on("GET", "/r", { kind: "reset_mid_body" });
    const res = await fetch(url("/r"));
    expect(res.status).toBe(200);
    await expect(res.text()).rejects.toBeInstanceOf(TypeError);
  });

  it("fails before sending", async () => {
    graph.install().on("GET", "/p", { kind: "pre_send_failure" });
    const error = await fetch(url("/p")).catch((e: unknown) => e as Error & { cause: { code: string } });
    expect(error).toBeInstanceOf(TypeError);
    expect((error as { cause: { code: string } }).cause.code).toBe("ECONNREFUSED");
  });
});
