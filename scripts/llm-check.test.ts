import { afterEach, describe, expect, it } from "vitest";
import { createFakeLlm } from "../tests/helpers/fake-llm";
import { setLlmForTests } from "../src/server/llm";
import { main, UNMEASURED_LINE } from "./llm-check";

const NAMES = ["LLM_PROVIDER", "LLM_MODEL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"];

afterEach(() => setLlmForTests(null));

describe("llm-check main()", () => {
  it("prints the measured line with an injected LLM", async () => {
    const lines: string[] = [];
    const ok = { ok: { text: "Hello" } };
    const code = await main({ llm: createFakeLlm([ok, ok, ok]), log: (l) => void lines.push(l) });
    expect(code).toBe(0);
    expect(lines).toEqual([
      "provider=openai model=fake-model outcome=ok latency_ms=5",
      "job_call kind=text outcome=ok latency_ms=5 window_ms=17000 fits=yes",
      "job_call kind=image outcome=ok latency_ms=5 window_ms=17000 fits=yes",
      "jobs budget_ms=20000 reserve_ms=3000 max_items_per_tick=2",
    ]);
  });

  it("prints the failure kind and exits non-zero when the call fails", async () => {
    const lines: string[] = [];
    const code = await main({ llm: createFakeLlm([{ fail: "auth" }]), log: (l) => void lines.push(l) });
    expect(code).toBe(1);
    expect(lines[0]).toContain("outcome=auth");
  });

  it("prints the unmeasured line and exits 0 with no configuration", async () => {
    const saved = NAMES.map((n) => [n, process.env[n]] as const);
    for (const n of NAMES) delete process.env[n];
    try {
      const lines: string[] = [];
      expect(await main({ log: (l) => void lines.push(l) })).toBe(0);
      expect(lines).toEqual([UNMEASURED_LINE]);
    } finally {
      for (const [n, v] of saved) if (v !== undefined) process.env[n] = v;
    }
  });
});
