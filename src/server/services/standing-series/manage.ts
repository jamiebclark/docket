// standing-series/manage: create, edit, pause, resume and delete a standing series (contracts/services.md §5).
import { unknownPlaceholders } from "@/lib/jobs/template";
import { nextBoundaryAfter } from "@/lib/series/cadence";
import { createStandingSeriesSchema, updateStandingSeriesSchema, type CreateStandingSeriesInput } from "@/lib/validation/standing-series";
import * as clock from "../../dal/clock";
import { ConflictError, NotFoundError, ValidationIssuesError } from "../../dal/errors";
import { clearPostLinksForSeries, type NewStandingSeries, type StandingSeriesPatch, type StandingSeriesRecord } from "../../dal/standing-series";
import type { ProjectScope } from "../../dal/scope";
import { getStorage, MEDIA_STORAGE_NOT_SET_UP } from "../../storage";
import { assertGroupLimit, groupsForAccounts } from "../generation/groups";
import { resolvePolicies } from "../generation/policy";
import { isUniqueViolation, loadAccounts, need, takeVoice } from "../generation/single";

function requireManage(scope: ProjectScope): void {
  need(scope, { standing_series: ["manage"] });
}

const issue = (field: string, message: string, code = "template") =>
  new ValidationIssuesError([{ code, field, message }], message);

function duplicateNameError(name: string): ConflictError {
  return new ConflictError(`A standing series called "${name}" already exists in this project.`, "name");
}

async function getOrThrow(scope: ProjectScope, seriesId: string): Promise<StandingSeriesRecord> {
  const row = await scope.standingSeries.get(seriesId);
  if (!row) throw new NotFoundError("Standing series not found");
  return row;
}

/** Steps 3–7 of contracts/services.md §5, shared by create and update. */
async function resolveInput(scope: ProjectScope, parsed: CreateStandingSeriesInput) {
  const policies = resolvePolicies(scope, {
    approval: parsed.approval,
    scheduling: parsed.scheduling,
    confirmUnreviewedQueue: parsed.confirmUnreviewedQueue,
  });
  await takeVoice(scope, parsed.voiceProfileId);
  const accounts = await loadAccounts(scope, parsed.targetAccountIds);
  assertGroupLimit(groupsForAccounts(accounts));

  const unknown = unknownPlaceholders(parsed.template, []);
  if (unknown.length > 0) throw issue("template", `Unknown field: ${unknown.join(", ")}. Available: none`);

  if ((parsed.media.source === "pool" || parsed.media.source === "generate") && !getStorage()) {
    throw issue("media", MEDIA_STORAGE_NOT_SET_UP, "media_storage");
  }
  return policies;
}

function fieldsFrom(
  parsed: CreateStandingSeriesInput,
  policies: ReturnType<typeof resolvePolicies>,
): Omit<NewStandingSeries, "nextRunAt"> {
  return {
    name: parsed.name,
    brief: parsed.brief,
    template: parsed.template,
    templateFields: [],
    voiceProfileId: parsed.voiceProfileId,
    targetAccountIds: parsed.targetAccountIds,
    cadenceCount: parsed.cadence.count,
    cadencePeriod: parsed.cadence.period,
    mediaSource: parsed.media.source,
    mediaPoolTag: parsed.media.source === "pool" ? (parsed.media.tag ?? null) : null,
    imagePrompt: parsed.media.source === "generate" ? parsed.media.prompt : null,
    requestedApproval: policies.requested.approval,
    requestedScheduling: policies.requested.scheduling,
    approvalPolicy: policies.resolved.approval,
    schedulingPolicy: policies.resolved.scheduling,
  };
}

export async function createStandingSeries(scope: ProjectScope, input: unknown): Promise<{ seriesId: string }> {
  requireManage(scope);
  const parsed = createStandingSeriesSchema.parse(input);
  const policies = await resolveInput(scope, parsed);
  if (await scope.standingSeries.nameTaken(parsed.name)) throw duplicateNameError(parsed.name);
  const now = await clock.now();
  const nextRunAt = nextBoundaryAfter(now, scope.project.timezone, parsed.cadence.period);

  const write = () =>
    scope.transaction(async (tx) => {
      requireManage(tx);
      const row = await tx.standingSeries.insert({
        ...fieldsFrom(parsed, policies),
        nextRunAt,
        createdByUserId: tx.membership.userId || null,
      });
      await tx.audit.insert({
        action: "standing_series_create",
        actorUserId: tx.membership.userId || null,
        details: { seriesId: row.id, name: row.name },
      });
      return row;
    });

  try {
    const row = await write();
    return { seriesId: row.id };
  } catch (error) {
    if (isUniqueViolation(error)) throw duplicateNameError(parsed.name);
    throw error;
  }
}

/** Does not touch `next_run_at` except on a period change (FR-056). */
export async function updateStandingSeries(scope: ProjectScope, seriesId: string, input: unknown): Promise<void> {
  requireManage(scope);
  const parsed = updateStandingSeriesSchema.parse(input);
  const policies = await resolveInput(scope, parsed);
  if (await scope.standingSeries.nameTaken(parsed.name, seriesId)) throw duplicateNameError(parsed.name);

  const write = () =>
    scope.transaction(async (tx) => {
      requireManage(tx);
      const existing = await getOrThrow(tx, seriesId);
      const patch: StandingSeriesPatch = { ...fieldsFrom(parsed, policies) };
      if (parsed.cadence.period !== existing.cadencePeriod) {
        patch.nextRunAt = nextBoundaryAfter(await clock.now(), tx.project.timezone, parsed.cadence.period);
      }
      await tx.standingSeries.update(seriesId, patch);
      await tx.audit.insert({
        action: "standing_series_update",
        actorUserId: tx.membership.userId || null,
        details: { seriesId, name: parsed.name },
      });
    });

  try {
    await write();
  } catch (error) {
    if (isUniqueViolation(error)) throw duplicateNameError(parsed.name);
    throw error;
  }
}

export async function pauseStandingSeries(scope: ProjectScope, seriesId: string): Promise<void> {
  requireManage(scope);
  await scope.transaction(async (tx) => {
    requireManage(tx);
    await getOrThrow(tx, seriesId);
    await tx.standingSeries.update(seriesId, { enabled: false, autoPausedReason: null });
    await tx.audit.insert({
      action: "standing_series_pause",
      actorUserId: tx.membership.userId || null,
      details: { seriesId },
    });
  });
}

export async function resumeStandingSeries(scope: ProjectScope, seriesId: string): Promise<{ nextRunAt: Date }> {
  requireManage(scope);
  return scope.transaction(async (tx) => {
    requireManage(tx);
    const existing = await getOrThrow(tx, seriesId);
    const now = await clock.now();
    const nextRunAt = nextBoundaryAfter(now, tx.project.timezone, existing.cadencePeriod);
    await tx.standingSeries.update(seriesId, { enabled: true, autoPausedReason: null, nextRunAt });
    await tx.audit.insert({
      action: "standing_series_resume",
      actorUserId: tx.membership.userId || null,
      details: { seriesId },
    });
    return { nextRunAt };
  });
}

/** Runs and positions cascade; failures cascade through runs; posts keep everything but the link (FR-057). */
export async function deleteStandingSeries(scope: ProjectScope, seriesId: string): Promise<void> {
  requireManage(scope);
  await scope.transaction(async (tx) => {
    requireManage(tx);
    await getOrThrow(tx, seriesId);
    await clearPostLinksForSeries(tx.exec, tx.project.id, seriesId);
    const deleted = await tx.standingSeries.delete(seriesId);
    if (!deleted) throw new NotFoundError("Standing series not found");
    await tx.audit.insert({
      action: "standing_series_delete",
      actorUserId: tx.membership.userId || null,
      details: { seriesId },
    });
  });
}
