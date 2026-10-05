// jobs/create: validate, reserve and insert a job and its items. No model call is ever made here (SC-001).
import { z } from "zod";
import { findProvider } from "@/providers/registry";
import { JOB_RENDERED_INSTRUCTIONS_MAX, renderTemplate, unknownPlaceholders } from "@/lib/jobs/template";
import { createJobSchema, jobSourceSchema, type JobInstructionsSnapshot } from "@/lib/validation/jobs";
import * as clock from "../../dal/clock";
import { ConflictError, ValidationIssuesError } from "../../dal/errors";
import type { JobRecord } from "../../dal/jobs";
import { actorColumns, type ProjectScope } from "../../dal/scope";
import { getLlmStatus, LlmNotConfiguredError } from "../../llm";
import { resolvePolicies } from "../generation/policy";
import { assertGroupLimit, groupsForAccounts } from "../generation/groups";
import { assertMediaFits, distinctProviderKeys, isUniqueViolation, loadAccounts, need, takeVoice } from "../generation/single";
import { refreshJobStatus } from "./status";
import { sourceFor } from "./sources";
import { assertApiMediaAvailable } from "./sources/api";
import type { PreparedSource, SourceItem } from "./sources/types";

export interface CreateJobResult {
  jobId: string;
  itemCount: number;
  excluded: { reason: "already_used" | "deleted"; count: number }[];
  skippedReserved: number;
}

type FileCtx = { file?: { name: string; bytes: Buffer } };

function addExcluded(into: PreparedSource["excluded"], reason: "already_used" | "deleted", count: number) {
  if (count <= 0) return;
  const found = into.find((e) => e.reason === reason);
  if (found) found.count += count;
  else into.push({ reason, count });
}

const issue = (field: string, message: string, code = "template") =>
  new ValidationIssuesError([{ code, field, message }], message);

function emptyMessage(kind: string, mode: string | undefined): string {
  if (kind === "csv") return "The file has no data rows.";
  return mode === "unused" ? "No unused images left to generate for." : "None of the selected images can be used.";
}

function checkTemplate(kind: string, template: string, prepared: PreparedSource): void {
  const unknown = unknownPlaceholders(template, prepared.fields);
  if (unknown.length > 0) {
    const what = kind === "csv" ? "column" : "field";
    throw issue(
      "template",
      `Unknown ${what}: ${unknown.join(", ")}. Available: ${prepared.fields.join(", ") || "none"}`,
    );
  }
  assertRenderedFits(template, prepared.items, () => "template");
}

/**
 * Refuses the first item whose rendered instructions exceed `JOB_RENDERED_INSTRUCTIONS_MAX`, so every stored item
 * renders to instructions the generation record accepts. `field(i)` names the offending item in the issue.
 * Shared by `createJob` and `appendItems`.
 */
export function assertRenderedFits(
  template: string,
  items: readonly SourceItem[],
  field: (index: number) => string,
  code = "template",
): void {
  items.forEach((item, i) => {
    const n = renderTemplate(template, item.fields, { mark: true }).length;
    if (n > JOB_RENDERED_INSTRUCTIONS_MAX) {
      throw issue(
        field(i),
        `${item.label}: the instructions would be ${n} characters; the limit is ${JOB_RENDERED_INSTRUCTIONS_MAX.toLocaleString("en-US")}`,
        code,
      );
    }
  });
}

/** Appends items to a job, numbering positions from the current count. Call inside a transaction. */
export async function insertItems(tx: ProjectScope, job: JobRecord, items: readonly SourceItem[]): Promise<number> {
  const counts = await tx.jobItems.countByStatus(job.id);
  const base = counts.queued + counts.running + counts.done + counts.failed + counts.cancelled;
  const now = await clock.now();
  await tx.jobItems.insertMany(
    job.id,
    items.map((item, i) => ({
      position: base + i,
      label: item.label.slice(0, 200),
      payload: { v: 1, fields: item.fields },
      mediaAssetId: item.mediaAssetId,
      nextAttemptAt: now,
    })),
  );
  await tx.jobs.update(job.id, { itemCount: base + items.length });
  await refreshJobStatus(tx, job.id);
  return items.length;
}

export async function createJob(scope: ProjectScope, input: unknown, ctx: FileCtx = {}): Promise<CreateJobResult> {
  const parsed = createJobSchema.parse(input);
  need(scope, { generation: ["run"], post: ["edit"] });
  const llm = getLlmStatus();
  if (!llm.configured) throw new LlmNotConfiguredError(llm.problems.map((p) => p.name));

  const policies = resolvePolicies(scope, {
    approval: parsed.approval,
    scheduling: parsed.scheduling,
    confirmUnreviewedQueue: parsed.confirmUnreviewedQueue,
  });
  const voice = await takeVoice(scope, parsed.voiceProfileId);
  const accounts = await loadAccounts(scope, parsed.targetAccountIds);
  const snapshot: JobInstructionsSnapshot = {
    v: 1,
    byAccount: Object.fromEntries(accounts.map((a) => [a.id, a.postingInstructions])),
  };
  assertGroupLimit(groupsForAccounts(accounts, (a) => snapshot.byAccount[a.id] ?? null));

  const kind = parsed.source.kind;
  if (kind === "csv" && scope.actor.kind === "api_key") {
    throw issue("source", "CSV jobs are created in the app.", "unsupported_source");
  }
  const source = sourceFor(kind);
  const prepared = await source.prepare(scope, source.inputSchema.parse(parsed.source), ctx);
  const includeUsed = parsed.source.kind === "media" && parsed.source.includeUsed;
  const mode = parsed.source.kind === "media" ? parsed.source.selection.mode : undefined;
  const open = kind === "api" && (prepared.meta as { open?: boolean }).open === true;
  const rules = prepared.mediaRules ?? { onReserved: "skip" as const, skipUsed: !includeUsed };

  if (prepared.items.some((i) => i.mediaAssetId !== null)) {
    assertMediaFits(distinctProviderKeys(accounts), 1);
  }
  checkTemplate(kind, parsed.template, prepared);
  if (prepared.items.length === 0 && !open) throw issue("selection", emptyMessage(kind, mode), "selection");

  const write = () =>
    scope.transaction(async (tx) => {
      need(tx, { generation: ["run"], post: ["edit"] });
      const excluded = prepared.excluded.map((e) => ({ ...e }));
      let items = prepared.items;
      let skippedReserved = 0;

      const mediaIds = items.map((i) => i.mediaAssetId).filter((id): id is string => id !== null);
      if (mediaIds.length > 0 && rules.onReserved === "refuse") {
        await assertApiMediaAvailable(tx, items);
      } else if (mediaIds.length > 0) {
        const live = new Set((await tx.media.lockForReservation(mediaIds)).map((m) => m.id));
        const liveIds = [...live];
        const reserved = new Set(await tx.media.reservedAmong(liveIds));
        const used = new Set(!rules.skipUsed ? [] : await tx.media.usedAmong(liveIds));
        items = items.filter((i) => {
          if (i.mediaAssetId === null) return true;
          if (!live.has(i.mediaAssetId)) {
            addExcluded(excluded, "deleted", 1);
            return false;
          }
          if (reserved.has(i.mediaAssetId)) {
            skippedReserved++;
            return false;
          }
          if (used.has(i.mediaAssetId)) {
            addExcluded(excluded, "already_used", 1);
            return false;
          }
          return true;
        });
      }
      if (items.length === 0 && !open) throw issue("selection", emptyMessage(kind, mode), "selection");

      const job = await tx.jobs.insert({
        sourceKind: kind,
        // The count in a media summary leads it; keep it true after reservations drop items.
        sourceSummary: (items.length === prepared.items.length ? prepared.summary : prepared.summary.replace(/^\d+/, String(items.length))).slice(0, 200),
        sourceMeta: prepared.meta,
        postingInstructionsSnapshot: snapshot,
        voiceProfileId: voice.id,
        voiceProfileVersionId: voice.versionId,
        template: parsed.template,
        templateFields: prepared.fields,
        targetAccountIds: accounts.map((a) => a.id),
        requestedApproval: policies.requested.approval,
        requestedScheduling: policies.requested.scheduling,
        approvalPolicy: policies.resolved.approval,
        schedulingPolicy: policies.resolved.scheduling,
        status: "queued",
        open,
        itemCount: items.length,
        ...actorColumns(tx),
      });
      await insertItems(tx, job, items);
      return { jobId: job.id, itemCount: items.length, excluded, skippedReserved } satisfies CreateJobResult;
    });

  try {
    return await write();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  try {
    return await write();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    throw new ConflictError("Some images were just taken by another job. Try again.");
  }
}

const previewSchema = z.object({
  source: jobSourceSchema,
  targetAccountIds: z.array(z.uuid()).max(50).default([]),
});

export interface JobPreview {
  itemCount: number;
  excluded: { reason: "already_used" | "deleted"; count: number }[];
  reserved: number;
  fields: string[];
  first: { label: string; fields: Record<string, string>; mediaAssetId: string | null } | null;
  emptyByField: Record<string, number>;
  instagramWithoutMedia: boolean;
}

/** What a job would contain, for the form. Writes nothing. */
export async function previewJob(scope: ProjectScope, input: unknown, ctx: FileCtx = {}): Promise<JobPreview> {
  const parsed = previewSchema.parse(input);
  need(scope, { generation: ["run"], post: ["view"] });
  const source = sourceFor(parsed.source.kind);
  const prepared = await source.prepare(scope, source.inputSchema.parse(parsed.source), ctx);

  const mediaIds = prepared.items.map((i) => i.mediaAssetId).filter((id): id is string => id !== null);
  const reserved = (await scope.media.reservedAmong(mediaIds)).length;
  const emptyByField: Record<string, number> = Object.fromEntries(prepared.fields.map((f) => [f, 0]));
  for (const item of prepared.items) {
    for (const f of prepared.fields) if ((item.fields[f] ?? "").trim() === "") emptyByField[f]!++;
  }
  const accounts = await loadAccounts(scope, parsed.targetAccountIds);
  const carriesMedia = prepared.items.some((i) => i.mediaAssetId !== null);
  const first = prepared.items[0];
  return {
    itemCount: prepared.items.length,
    excluded: prepared.excluded,
    reserved,
    fields: prepared.fields,
    first: first ? { label: first.label, fields: first.fields, mediaAssetId: first.mediaAssetId } : null,
    emptyByField,
    instagramWithoutMedia:
      !carriesMedia &&
      accounts.some((a) => findProvider(a.providerKey)?.capabilities.media.required === true),
  };
}
