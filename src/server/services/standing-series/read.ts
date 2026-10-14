// standing-series/read: list and detail views, gated on `post: ["view"]` (contracts/services.md §6, S26).
import { findProvider } from "@/providers/registry";
import { NotFoundError } from "../../dal/errors";
import type { ProjectScope } from "../../dal/scope";
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
  cadence: { count: number; period: StandingSeriesRecord["cadencePeriod"] };
  enabled: boolean;
  autoPausedReason: StandingSeriesRecord["autoPausedReason"];
  accounts: StandingSeriesAccountView[];
  media: { source: StandingSeriesRecord["mediaSource"]; tag: string | null; prompt: string | null };
  lastRunAt: Date | null;
  lastRunOutcome: StandingSeriesOutcome | null;
  nextRunAt: Date;
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
    cadence: { count: row.cadenceCount, period: row.cadencePeriod },
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

export interface StandingSeriesDetail extends StandingSeriesView {
  brief: string;
  template: string;
  voiceProfile: { id: string; name: string; archived: boolean };
  requestedApproval: StandingSeriesRecord["requestedApproval"];
  requestedScheduling: StandingSeriesRecord["requestedScheduling"];
  creditHold: Awaited<ReturnType<typeof generationCreditHold>>;
  runs: StandingSeriesRun[];
}

export async function getStandingSeries(scope: ProjectScope, seriesId: string): Promise<StandingSeriesDetail> {
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
  return {
    ...view,
    brief: row.brief,
    template: row.template,
    voiceProfile: { id: row.voiceProfileId, name: voice?.name ?? "Voice profile", archived: voice?.archivedAt != null },
    requestedApproval: row.requestedApproval,
    requestedScheduling: row.requestedScheduling,
    creditHold,
    runs,
  };
}
