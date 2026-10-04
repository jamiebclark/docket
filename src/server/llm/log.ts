import { redact } from "../scheduler/redact";
import type { LlmFailureKind, LlmProviderName, LlmUsage } from "./types";

export interface LlmCallLog {
  provider: LlmProviderName;
  model: string;
  label: string;
  latencyMs: number;
  outcome: "ok" | LlmFailureKind;
  usage: LlmUsage;
}

/** One line, fixed fields only: never prompts, images, raw output or SDK error text. */
export function logLlmCall(call: LlmCallLog): void {
  const line = redact({
    provider: call.provider,
    model: call.model,
    label: call.label,
    latencyMs: Math.round(call.latencyMs),
    outcome: call.outcome,
    // redact() drops keys that look like "token", so usage counts use neutral names.
    usage: { in: call.usage.inputTokens, out: call.usage.outputTokens },
  });
  console.log(`Docket llm: ${JSON.stringify(line)}`);
}
