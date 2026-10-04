import { afterEach, expect, test, vi } from "vitest";
import { logLlmCall } from "./log";

afterEach(() => vi.restoreAllMocks());

test("logs fixed fields only; secrets and text passed in the input never appear", () => {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  const input = {
    provider: "openai",
    model: "m",
    label: "generate.single",
    latencyMs: 123.6,
    outcome: "ok",
    usage: { inputTokens: 10, outputTokens: 20 },
    apiKey: "sk-FAKEKEY-123456",
    system: "SYSTEM-TEXT-XYZ",
    user: "USER-TEXT-XYZ",
    rawText: "RAW-TEXT-XYZ",
  } as Parameters<typeof logLlmCall>[0];
  logLlmCall(input);
  const out = spy.mock.calls.map((c) => c.join(" ")).join("\n");
  expect(spy).toHaveBeenCalledTimes(1);
  for (const s of ["sk-FAKEKEY", "SYSTEM-TEXT", "USER-TEXT", "RAW-TEXT"]) expect(out).not.toContain(s);
  expect(out).toContain('"latencyMs":124');
  expect(out).toContain('"outcome":"ok"');
  expect(out).toContain('"usage":{"in":10,"out":20}');
});
