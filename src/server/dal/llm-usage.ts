import { and, eq, gte, lt, sql } from "drizzle-orm";
import { getDb, type Database } from "../db/client";
import { llmCallUsage, type LlmCallUsageRow } from "../db/schema";
import type { LlmFailureKind } from "../llm/types";
import type { LlmProviderName } from "../llm/types";

export interface LlmUsageLink {
  postId?: string | null;
  seriesId?: string | null;
  seriesPosition?: number | null;
  generationJobId?: string | null;
  generationJobItemId?: string | null;
}

export interface LlmUsageInsert extends LlmUsageLink {
  purpose: LlmCallUsageRow["purpose"];
  provider: LlmProviderName;
  model: string;
  credentialSource: "project" | "install";
  ok: boolean;
  failureKind: LlmFailureKind | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  calledAt: Date;
}

/** Half-open [from, to); a null bound is open, so "all time" is { from: null, to: null }. */
export interface UsageWindow {
  from: Date | null;
  to: Date | null;
}

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  callsWithoutCounts: number;
  failedCalls: number;
  failedInputTokens: number;
  failedOutputTokens: number;
  projectCredentialCalls: number;
  installCredentialCalls: number;
}

export interface ModelTotals extends UsageTotals {
  provider: LlmProviderName;
  model: string;
}

export interface PurposeTotals {
  purpose: LlmCallUsageRow["purpose"];
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmUsageRepo {
  /** Insert-only. One statement for the batch. No update, no delete — by design (FR-007). */
  record(rows: readonly LlmUsageInsert[]): Promise<void>;
  /** Aggregates for one window. */
  summary(window: UsageWindow): Promise<UsageTotals>;
  byModel(window: UsageWindow): Promise<ModelTotals[]>;
  byPurpose(window: UsageWindow): Promise<PurposeTotals[]>;
  /** The job page (FR-028). One indexed aggregate, no join. */
  totalsForJob(jobId: string): Promise<UsageTotals>;
}

const totalsSelect = {
  calls: sql<number>`count(*)::int`,
  inputTokens: sql<number>`coalesce(sum(${llmCallUsage.inputTokens}), 0)::int`,
  outputTokens: sql<number>`coalesce(sum(${llmCallUsage.outputTokens}), 0)::int`,
  callsWithoutCounts: sql<number>`count(*) FILTER (WHERE ${llmCallUsage.inputTokens} IS NULL AND ${llmCallUsage.outputTokens} IS NULL)::int`,
  failedCalls: sql<number>`count(*) FILTER (WHERE NOT ${llmCallUsage.ok})::int`,
  failedInputTokens: sql<number>`coalesce(sum(${llmCallUsage.inputTokens}) FILTER (WHERE NOT ${llmCallUsage.ok}), 0)::int`,
  failedOutputTokens: sql<number>`coalesce(sum(${llmCallUsage.outputTokens}) FILTER (WHERE NOT ${llmCallUsage.ok}), 0)::int`,
  projectCredentialCalls: sql<number>`count(*) FILTER (WHERE ${llmCallUsage.credentialSource} = 'project')::int`,
  installCredentialCalls: sql<number>`count(*) FILTER (WHERE ${llmCallUsage.credentialSource} = 'install')::int`,
};

function windowWhere(projectId: string, window: UsageWindow) {
  const parts = [eq(llmCallUsage.projectId, projectId)];
  if (window.from) parts.push(gte(llmCallUsage.calledAt, window.from));
  if (window.to) parts.push(lt(llmCallUsage.calledAt, window.to));
  return and(...parts);
}

export function createLlmUsageRepo(exec: Database, projectId: string): LlmUsageRepo {
  return {
    async record(rows) {
      if (rows.length === 0) return;
      await exec.insert(llmCallUsage).values(
        rows.map((row) => ({
          projectId,
          purpose: row.purpose,
          provider: row.provider,
          model: row.model,
          credentialSource: row.credentialSource,
          ok: row.ok,
          failureKind: row.failureKind,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          latencyMs: row.latencyMs,
          calledAt: row.calledAt,
          postId: row.postId ?? null,
          seriesId: row.seriesId ?? null,
          seriesPosition: row.seriesPosition ?? null,
          generationJobId: row.generationJobId ?? null,
          generationJobItemId: row.generationJobItemId ?? null,
        })),
      );
    },
    async summary(window) {
      const [row] = await exec.select(totalsSelect).from(llmCallUsage).where(windowWhere(projectId, window));
      return row!;
    },
    async byModel(window) {
      const rows = await exec
        .select({ provider: llmCallUsage.provider, model: llmCallUsage.model, ...totalsSelect })
        .from(llmCallUsage)
        .where(windowWhere(projectId, window))
        .groupBy(llmCallUsage.provider, llmCallUsage.model);
      return rows.map((row) => ({ ...row, provider: row.provider as LlmProviderName }));
    },
    async byPurpose(window) {
      const rows = await exec
        .select({
          purpose: llmCallUsage.purpose,
          calls: sql<number>`count(*)::int`,
          inputTokens: sql<number>`coalesce(sum(${llmCallUsage.inputTokens}), 0)::int`,
          outputTokens: sql<number>`coalesce(sum(${llmCallUsage.outputTokens}), 0)::int`,
        })
        .from(llmCallUsage)
        .where(windowWhere(projectId, window))
        .groupBy(llmCallUsage.purpose);
      return rows;
    },
    async totalsForJob(jobId) {
      const [row] = await exec
        .select(totalsSelect)
        .from(llmCallUsage)
        .where(and(eq(llmCallUsage.projectId, projectId), eq(llmCallUsage.generationJobId, jobId)));
      return row!;
    },
  };
}

/** For `runLlmCheck`, which is given a project id and no scope — same seam as `projectLlmRepoFor`. */
export function llmUsageRepoFor(projectId: string): LlmUsageRepo {
  return createLlmUsageRepo(getDb(), projectId);
}
