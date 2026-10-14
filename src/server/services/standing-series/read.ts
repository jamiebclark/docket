// standing-series/read: list and detail views, gated on `post: ["view"]` (contracts/services.md §6, S26).
import { NotFoundError } from "../../dal/errors";
import type { ProjectScope } from "../../dal/scope";
import type { StandingSeriesOutcome, StandingSeriesRecord } from "../../dal/standing-series";
import { generationCreditHold } from "../jobs/read";
import { need } from "../generation/single";

export const STANDING_SERIES_PAGE_SIZE = 50;
export const STANDING_SERIES_RUN_HISTORY_LIMIT = 20;

function canView(scope: ProjectScope): void {
  need(scope, { post: ["view"] });
}

export interface StandingSeriesView {
  id: string;
  name: string;
  cadence: { count: number; period: StandingSeriesRecord["cadencePeriod"] };
  enabled: boolean;
  autoPausedReason: StandingSeriesRecord["autoPausedReason"];
  lastRunAt: Date | null;
  nextRunAt: Date;
  approvalPolicy: StandingSeriesRecord["approvalPolicy"];
  schedulingPolicy: StandingSeriesRecord["schedulingPolicy"];
}

function toView(row: StandingSeriesRecord): StandingSeriesView {
  return {
    id: row.id,
    name: row.name,
    cadence: { count: row.cadenceCount, period: row.cadencePeriod },
    enabled: row.enabled,
    autoPausedReason: row.autoPausedReason,
    lastRunAt: row.lastRunAt,
    nextRunAt: row.nextRunAt,
    approvalPolicy: row.approvalPolicy,
    schedulingPolicy: row.schedulingPolicy,
  };
}

export async function listStandingSeries(
  scope: ProjectScope,
  { page = 1 }: { page?: number } = {},
): Promise<{ items: StandingSeriesView[]; total: number; page: number }> {
  canView(scope);
  const { rows, total } = await scope.standingSeries.list({ page, pageSize: STANDING_SERIES_PAGE_SIZE });
  return { items: rows.map(toView), total, page };
}

export interface StandingSeriesDetail extends StandingSeriesView {
  brief: string;
  template: string;
  voiceProfileId: string;
  targetAccountIds: string[];
  media: { source: StandingSeriesRecord["mediaSource"]; tag: string | null; prompt: string | null };
  creditHold: Awaited<ReturnType<typeof generationCreditHold>>;
  runs: {
    id: string;
    openedAt: Date;
    closedAt: Date | null;
    outcome: StandingSeriesOutcome | null;
    counts: Record<string, number>;
  }[];
}

export async function getStandingSeries(scope: ProjectScope, seriesId: string): Promise<StandingSeriesDetail> {
  canView(scope);
  const row = await scope.standingSeries.get(seriesId);
  if (!row) throw new NotFoundError("Standing series not found");
  const [runs, creditHold] = await Promise.all([
    scope.standingSeriesRuns.listForSeries(seriesId, { limit: STANDING_SERIES_RUN_HISTORY_LIMIT }),
    generationCreditHold(scope),
  ]);
  const counts = await Promise.all(runs.map((r) => scope.standingSeriesPositions.countByStatus(r.id)));
  return {
    ...toView(row),
    brief: row.brief,
    template: row.template,
    voiceProfileId: row.voiceProfileId,
    targetAccountIds: row.targetAccountIds,
    media: { source: row.mediaSource, tag: row.mediaPoolTag, prompt: row.imagePrompt },
    creditHold,
    runs: runs.map((r, i) => ({
      id: r.id,
      openedAt: r.openedAt,
      closedAt: r.closedAt,
      outcome: r.outcome,
      counts: counts[i]!,
    })),
  };
}
