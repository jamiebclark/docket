// standing-series/read: list and detail views, gated on `post: ["view"]` (contracts/services.md §6, S26).
import { findProvider } from "@/providers/registry";
import type { CadencePeriod } from "@/lib/series/cadence";
import { upcoming as upcomingOccurrences } from "@/lib/series/dated";
import type { ImportProblem } from "@/lib/validation/dated-rows";
import { NotFoundError } from "../../dal/errors";
import type { ProjectScope } from "../../dal/scope";
import type { DatedOutcome, DatedRowRecord } from "../../dal/standing-series-dated";
import type {
  StandingSeriesOutcome,
  StandingSeriesPositionRecord,
  StandingSeriesRecord,
  StandingSeriesRunRecord,
} from "../../dal/standing-series";
import { generationCreditHold } from "../jobs/read";
import { need } from "../generation/single";

export const STANDING_SERIES_PAGE_SIZE = 50;
export const STANDING_SERIES_RUN_HISTORY_LIMIT = 20;
export const DATED_ROWS_PAGE_SIZE = 50;

function canView(scope: ProjectScope): void {
  need(scope, { post: ["view"] });
}

export interface StandingSeriesAccountView {
  id: string;
  displayName: string;
  providerName: string;
  removed: boolean;
}

async function resolveAccounts(scope: ProjectScope, accountIds: readonly string[]): Promise<StandingSeriesAccountView[]> {
  return Promise.all(
    accountIds.map(async (id) => {
      const account = await scope.accounts.get(id);
      return {
        id,
        displayName: account?.displayName ?? "Removed account",
        providerName: account ? findProvider(account.providerKey)?.displayName ?? account.providerKey : "",
        removed: !account,
      };
    }),
  );
}

export interface StandingSeriesView {
  id: string;
  name: string;
  occurrenceRule: StandingSeriesRecord["occurrenceRule"];
  leadDays: number;
  cadence: { count: number; period: CadencePeriod } | null;
  enabled: boolean;
  autoPausedReason: StandingSeriesRecord["autoPausedReason"];
  accounts: StandingSeriesAccountView[];
  media: { source: StandingSeriesRecord["mediaSource"]; tag: string | null; prompt: string | null };
  lastRunAt: Date | null;
  lastRunOutcome: StandingSeriesOutcome | null;
  /** Always NULL for a dated series (B5); the screen shows `upcoming[0]` instead. */
  nextRunAt: Date | null;
  approvalPolicy: StandingSeriesRecord["approvalPolicy"];
  schedulingPolicy: StandingSeriesRecord["schedulingPolicy"];
  producedCount: number;
}

async function toView(scope: ProjectScope, row: StandingSeriesRecord): Promise<StandingSeriesView> {
  const [accounts, [lastRunOutcome], producedCount] = await Promise.all([
    resolveAccounts(scope, row.targetAccountIds),
    scope.standingSeriesRuns.recentClosedOutcomes(row.id, 1),
    scope.standingSeries.countProduced(row.id),
  ]);
  return {
    id: row.id,
    name: row.name,
    occurrenceRule: row.occurrenceRule,
    leadDays: row.leadDays,
    cadence: row.occurrenceRule === "cadence" ? { count: row.cadenceCount!, period: row.cadencePeriod as CadencePeriod } : null,
    enabled: row.enabled,
    autoPausedReason: row.autoPausedReason,
    accounts,
    media: { source: row.mediaSource, tag: row.mediaPoolTag, prompt: row.imagePrompt },
    lastRunAt: row.lastRunAt,
    lastRunOutcome: lastRunOutcome ?? null,
    nextRunAt: row.nextRunAt,
    approvalPolicy: row.approvalPolicy,
    schedulingPolicy: row.schedulingPolicy,
    producedCount,
  };
}

export async function listStandingSeries(
  scope: ProjectScope,
  { page = 1 }: { page?: number } = {},
): Promise<{ items: StandingSeriesView[]; total: number; page: number }> {
  canView(scope);
  const { rows, total } = await scope.standingSeries.list({ page, pageSize: STANDING_SERIES_PAGE_SIZE });
  const items = await Promise.all(rows.map((row) => toView(scope, row)));
  return { items, total, page };
}

export interface StandingSeriesRunProblem {
  /** `null` for the series-level `blocked_reason` line. */
  position: number | null;
  skipReason: StandingSeriesPositionRecord["skipReason"];
  account: StandingSeriesAccountView | null;
  /** The failure's fixed, already-written message (never provider text, FR-026). */
  failureMessage: string | null;
}

export interface StandingSeriesRun {
  id: string;
  period: StandingSeriesRunRecord["period"];
  periodStart: string;
  periodStartAt: Date;
  openedAt: Date;
  closedAt: Date | null;
  outcome: StandingSeriesOutcome | null;
  requestedCount: number;
  missedPeriods: number;
  blockedReason: StandingSeriesRunRecord["blockedReason"];
  droppedAccountIds: string[];
  counts: Record<StandingSeriesPositionRecord["status"], number>;
  /** Each produced position's post, in position order. */
  produced: { position: number; postId: string }[];
  problems: StandingSeriesRunProblem[];
}

async function toRunView(scope: ProjectScope, run: StandingSeriesRunRecord): Promise<StandingSeriesRun> {
  const [positions, counts] = await Promise.all([
    scope.standingSeriesPositions.listForRun(run.id),
    scope.standingSeriesPositions.countByStatus(run.id),
  ]);
  const produced = (
    await Promise.all(
      positions
        .filter((p) => p.status === "produced")
        .map(async (p) => {
          const post = await scope.posts.findByStandingSeriesPosition(p.id);
          return post ? { position: p.position, postId: post.id } : null;
        }),
    )
  ).filter((p): p is { position: number; postId: string } => p !== null);

  const skipAccountIds = [...new Set(positions.map((p) => p.skipAccountId).filter((id): id is string => id != null))];
  const skipAccounts = new Map((await resolveAccounts(scope, skipAccountIds)).map((a) => [a.id, a]));

  const problems: StandingSeriesRunProblem[] = [];
  if (run.blockedReason) problems.push({ position: null, skipReason: null, account: null, failureMessage: null });
  for (const p of positions) {
    if (p.status === "skipped") {
      problems.push({
        position: p.position,
        skipReason: p.skipReason,
        account: p.skipAccountId ? skipAccounts.get(p.skipAccountId) ?? null : null,
        failureMessage: null,
      });
    } else if (p.status === "failed") {
      problems.push({ position: p.position, skipReason: null, account: null, failureMessage: p.lastError });
    }
  }

  return {
    id: run.id,
    period: run.period,
    periodStart: run.periodStart,
    periodStartAt: run.periodStartAt,
    openedAt: run.openedAt,
    closedAt: run.closedAt,
    outcome: run.outcome,
    requestedCount: run.requestedCount,
    missedPeriods: run.missedPeriods,
    blockedReason: run.blockedReason,
    droppedAccountIds: run.droppedAccountIds,
    counts,
    produced: produced.sort((a, b) => a.position - b.position),
    problems,
  };
}

export interface UpcomingOccurrence {
  rowId: string;
  keyValue: string;
  target: string;
  dueAt: Date;
}

export interface DatedRowView {
  id: string;
  date: string;
  year: number | null;
  keyValue: string;
  fields: Record<string, string>;
  mediaFilename: string | null;
  mediaMissing: boolean;
  nextTargetDate: string | null;
  lastOutcome: DatedOutcome | null;
}

const UPCOMING_LIMIT = 10;

export interface StandingSeriesDetail extends StandingSeriesView {
  brief: string;
  template: string;
  voiceProfile: { id: string; name: string; archived: boolean };
  requestedApproval: StandingSeriesRecord["requestedApproval"];
  requestedScheduling: StandingSeriesRecord["requestedScheduling"];
  creditHold: Awaited<ReturnType<typeof generationCreditHold>>;
  runs: StandingSeriesRun[];
  /** Dated only. Up to 10, soonest first (FR-047). Computed from the rows, never cached (B5). */
  upcoming: UpcomingOccurrence[];
  /** Dated only, the first page (FR-047). */
  rows: { items: DatedRowView[]; total: number; page: number };
  lastImport: { filename: string; at: Date; rowCount: number; problems: ImportProblem[] } | null;
  templateFields: string[];
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

async function datedRowView(scope: ProjectScope, row: DatedRowRecord): Promise<DatedRowView> {
  const [lastOccurrence] = await scope.datedOccurrences.listForRow(row.id, { limit: 1 });
  return {
    id: row.id,
    date: `${pad(row.month)}-${pad(row.day)}`,
    year: row.year,
    keyValue: row.keyValue,
    fields: row.fields as Record<string, string>,
    mediaFilename: row.mediaFilename,
    mediaMissing: row.mediaFilename != null && row.mediaAssetId == null,
    nextTargetDate: row.nextTargetDate,
    lastOutcome: lastOccurrence?.outcome ?? null,
  };
}

export async function getStandingSeries(
  scope: ProjectScope,
  seriesId: string,
  opts: { rowsPage?: number } = {},
): Promise<StandingSeriesDetail> {
  canView(scope);
  const row = await scope.standingSeries.get(seriesId);
  if (!row) throw new NotFoundError("Standing series not found");
  const [view, voice, runRows, creditHold] = await Promise.all([
    toView(scope, row),
    scope.voiceProfiles.get(row.voiceProfileId),
    scope.standingSeriesRuns.listForSeries(seriesId, { limit: STANDING_SERIES_RUN_HISTORY_LIMIT }),
    generationCreditHold(scope),
  ]);
  const runs = await Promise.all(runRows.map((r) => toRunView(scope, r)));

  let upcoming: UpcomingOccurrence[] = [];
  const rowsPage = Math.max(1, opts.rowsPage ?? 1);
  let rows: { items: DatedRowView[]; total: number; page: number } = { items: [], total: 0, page: rowsPage };
  if (row.occurrenceRule === "dated_list") {
    const [allRows, page] = await Promise.all([
      scope.datedRows.listForSeries(seriesId),
      scope.datedRows.page(seriesId, { page: rowsPage, pageSize: DATED_ROWS_PAGE_SIZE }),
    ]);
    upcoming = upcomingOccurrences(allRows, row.leadDays, scope.project.timezone, UPCOMING_LIMIT);
    rows = { items: await Promise.all(page.rows.map((r) => datedRowView(scope, r))), total: page.total, page: rowsPage };
  }

  const lastImport =
    row.lastImportAt && row.lastImportFilename
      ? {
          filename: row.lastImportFilename,
          at: row.lastImportAt,
          rowCount: row.lastImportRowCount ?? 0,
          problems: (row.lastImportProblems as ImportProblem[] | null) ?? [],
        }
      : null;

  return {
    ...view,
    brief: row.brief,
    template: row.template,
    voiceProfile: { id: row.voiceProfileId, name: voice?.name ?? "Voice profile", archived: voice?.archivedAt != null },
    requestedApproval: row.requestedApproval,
    requestedScheduling: row.requestedScheduling,
    creditHold,
    runs,
    upcoming,
    rows,
    lastImport,
    templateFields: row.templateFields,
  };
}
