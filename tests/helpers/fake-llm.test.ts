import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createFakeLlm } from "./fake-llm";
import { createFakeLlmFetch } from "./fake-llm-http";

const schema = z.object({ text: z.string() });
const req = (label = "t") => ({ label, system: "SYS", user: "USR", images: [], schemaName: "out", schema });

describe("createFakeLlm", () => {
  test("replays in order and records requests", async () => {
    const llm = createFakeLlm([{ ok: { text: "a" } }, { ok: { text: "b" } }]);
    const a = await llm.generate(req("one"));
    const b = await llm.generate(req("two"));
    expect(a.ok && a.value.text).toBe("a");
    expect(b.ok && b.value.text).toBe("b");
    expect(llm.remaining()).toBe(0);
    expect(llm.requests).toEqual([
      { label: "one", system: "SYS", user: "USR", images: [], schemaName: "out" },
      { label: "two", system: "SYS", user: "USR", images: [], schemaName: "out" },
    ]);
  });

  test("invalid raw JSON is invalid_output with rawText", async () => {
    const r = await createFakeLlm([{ raw: "{nope" }]).generate(req());
    expect(r).toMatchObject({ ok: false, kind: "invalid_output", rawText: "{nope" });
  });

  test("a value that breaks the schema is invalid_output", async () => {
    const r = await createFakeLlm([{ ok: { text: 3 } }]).generate(req());
    expect(r).toMatchObject({ ok: false, kind: "invalid_output" });
  });

  test("fail steps return the fixed message", async () => {
    const r = await createFakeLlm([{ fail: "timeout" }]).generate(req());
    expect(r).toMatchObject({ ok: false, kind: "timeout", message: "The model took too long to answer.", rawText: null });
  });

  test("running out of steps throws", async () => {
    await expect(createFakeLlm([]).generate(req())).rejects.toThrow(/ran out/);
  });
});

describe("createFakeLlmFetch", () => {
  test("replays in order and records bodies", async () => {
    const f = createFakeLlmFetch([{ status: 200, json: { n: 1 } }, { status: 500 }]);
    const a = await f("https://x.test/a", { method: "POST", body: JSON.stringify({ q: 1 }) });
    const b = await f("https://x.test/b");
    expect(await a.json()).toEqual({ n: 1 });
    expect(b.status).toBe(500);
    expect(f.calls).toEqual([
      { url: "https://x.test/a", body: { q: 1 } },
      { url: "https://x.test/b", body: undefined },
    ]);
  });

  test("honours an abort signal", async () => {
    const f = createFakeLlmFetch([{ status: 200, delayMs: 5000 }]);
    const signal = AbortSignal.timeout(20);
    await expect(f("https://x.test/", { signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});
