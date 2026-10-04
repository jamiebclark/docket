// Measures one sample generation through the configured provider (FR-037, research D7).
// Without LLM settings it says so and exits 0: an unconfigured install is not a failure.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { getLlm, getLlmStatus } from "../src/server/llm";
import type { LlmProvider } from "../src/server/llm/types";

export const UNMEASURED_LINE = "latency: unmeasured (no LLM key configured)";

export async function main(
  deps: { llm?: LlmProvider; log?: (line: string) => void } = {},
): Promise<number> {
  const log = deps.log ?? console.log;
  if (!deps.llm && !getLlmStatus().configured) {
    log(UNMEASURED_LINE);
    return 0;
  }
  const llm = deps.llm ?? getLlm();
  const result = await llm.generate({
    label: "llm.check",
    system: "You write one short, friendly sentence.",
    user: "Write one sentence welcoming people to a bakery's spring opening.",
    images: [],
    schemaName: "check_output",
    schema: z.object({ text: z.string() }),
    timeoutMs: 30_000,
  });
  const head = `provider=${result.provider} model=${result.model}`;
  const latency = `latency_ms=${Math.round(result.latencyMs)}`;
  if (result.ok) {
    log(`${head} outcome=ok ${latency}`);
    return 0;
  }
  log(`${head} outcome=${result.kind} ${latency}`);
  return 1;
}

// Run only as the entry point; realpath so a symlinked output directory (macOS /tmp) still matches.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().then(
    (code) => process.exit(code),
    () => {
      console.error("llm:check failed unexpectedly.");
      process.exit(1);
    },
  );
}
