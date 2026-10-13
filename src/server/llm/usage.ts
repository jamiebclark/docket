import * as clock from "../dal/clock";
import { llmUsageRepoFor, type LlmUsageInsert, type LlmUsageLink, type LlmUsageRepo } from "../dal/llm-usage";
import { redact } from "../scheduler/redact";
import type { LlmProvider } from "./types";

export type UsagePurpose =
  | "generate.single"
  | "generate.series_plan"
  | "generate.series_post"
  | "generate.regenerate"
  | "generate.job_item"
  | "voice.try"
  | "llm.check";

export interface UsageRecorder {
  /** The provider, with recording. Delegates `generate`, returns its result unchanged. */
  wrap(llm: LlmProvider): LlmProvider;
  /** Writes every call observed so far with `link`, then forgets them. Never throws, never rejects. */
  flush(link?: LlmUsageLink): Promise<void>;
}

type BufferedCall = Omit<LlmUsageInsert, "purpose" | "credentialSource" | keyof LlmUsageLink>;

/**
 * Mirrors `withCreditHold` (`src/server/services/generation/credit.ts`) exactly: wrap the provider,
 * observe the result, buffer it, swallow every write failure. `generate`'s return value is never
 * altered, delayed beyond its own buffering, or replaced.
 */
export function createUsageRecorder(args: {
  projectId: string;
  purpose: UsagePurpose;
  source: "project" | "install";
  repo?: LlmUsageRepo;
}): UsageRecorder {
  const repo = args.repo ?? llmUsageRepoFor(args.projectId);
  let buffer: BufferedCall[] = [];

  return {
    wrap(llm) {
      return {
        ...llm,
        async generate(request) {
          const result = await llm.generate(request);
          buffer.push({
            provider: result.provider,
            model: result.model,
            ok: result.ok,
            failureKind: result.ok ? null : result.kind,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            latencyMs: Math.round(result.latencyMs),
            calledAt: await clock.now(),
          });
          return result;
        },
      };
    },
    async flush(link) {
      if (buffer.length === 0) return;
      const rows: LlmUsageInsert[] = buffer.map((call) => ({
        ...call,
        purpose: args.purpose,
        credentialSource: args.source,
        ...link,
      }));
      buffer = [];
      try {
        await repo.record(rows);
      } catch {
        // The exception text is never printed — it may be a driver error carrying a connection
        // string or other value this module has no way to vet. Only the fixed, already-redacted
        // fields below ever reach this line: never a prompt, output or credential (FR-005).
        console.error(redact({ event: "llm usage write failed", purpose: args.purpose, rows: rows.length }));
      }
    },
  };
}
