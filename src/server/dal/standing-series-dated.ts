import { and, asc, eq, inArray, isNotNull, lt, lte, sql } from "drizzle-orm";
import { getDb, type Database } from "../db/client";
import {
  standingSeriesDatedRows,
  standingSeriesOccurrences,
  type StandingSeriesDatedRowRow,
  type StandingSeriesOccurrenceRow,
} from "../db/schema";

export type DatedRowRecord = StandingSeriesDatedRowRow;
export type DatedOccurrenceRecord = StandingSeriesOccurrenceRow;
export type DatedOutcome = NonNullable<DatedOccurrenceRecord["outcome"]>;

export type NewDatedRow = Omit<
  typeof standingSeriesDatedRows.$inferInsert,
  "id" | "projectId" | "seriesId" | "createdAt" | "updatedAt"
>;
export type DatedRowPatch = Partial<
  Pick<
    typeof standingSeriesDatedRows.$inferInsert,
    "ordinal" | "month" | "day" | "year" | "keyValue" | "fields" | "mediaFilename" | "mediaAssetId" | "nextTargetDate" | "sourceLine"
  >
>;
export type NewDatedOccurrence = Omit<
  typeof standingSeriesOccurrences.$inferInsert,
  "id" | "projectId" | "recordedAt" | "settledAt" | "outcome"
>;

export interface DatedRowsRepo {
  /** File order. Throws 23505 on the identity index. */
  insertMany(seriesId: string, rows: readonly NewDatedRow[]): Promise<DatedRowRecord[]>;
  insert(seriesId: string, row: NewDatedRow): Promise<DatedRowRecord>;
  get(id: string): Promise<DatedRowRecord | null>;
  /** All rows of a series, `ordinal ASC`. Used by the importer's identity match and `upcoming`. */
  listForSeries(seriesId: string): Promise<DatedRowRecord[]>;
  /** One page, `ordinal ASC`, plus the total (FR-047's paginated table). */
  page(seriesId: string, opts: { page: number; pageSize: number }): Promise<{ rows: DatedRowRecord[]; total: number }>;
  count(seriesId: string): Promise<number>;
  update(id: string, patch: DatedRowPatch): Promise<DatedRowRecord | null>;
  delete(id: string): Promise<boolean>;
  deleteMany(ids: readonly string[]): Promise<number>;
  /** Rows whose window is open or past, `next_target_date ASC` then `ordinal ASC`, limit `n`.
   *  `today` is the project's local date as "YYYY-MM-DD", from the engine clock. */
  dueOrPast(seriesId: string, today: string, leadDays: number, limit: number): Promise<DatedRowRecord[]>;
  /** Rows whose `next_target_date` equals `date`, `ordinal ASC`. The run's positions (A28). */
  dueOn(seriesId: string, date: string): Promise<DatedRowRecord[]>;
  /** `UPDATE … SET next_target_date = $2 WHERE id = $1 AND next_target_date = $3`.
   *  `false` means another worker already advanced it — forward-only, never backwards. */
  advance(id: string, to: string | null, from: string | null): Promise<boolean>;
  /** Fired years per row, for `nextTargetDate`. One query for a set of rows. */
  firedYears(rowIds: readonly string[]): Promise<Map<string, number[]>>;
}

export interface DatedOccurrencesRepo {
  /** Throws 23505 on `unique(row_id, year)` — the FR-040 guard. */
  insert(input: NewDatedOccurrence): Promise<DatedOccurrenceRecord>;
  /** `ON CONFLICT (row_id, year) DO NOTHING`, then a re-select. For the bounded missed pass. */
  recordMissed(input: { seriesId: string; rowId: string; year: number; targetDate: string; at: Date }): Promise<void>;
  get(id: string): Promise<DatedOccurrenceRecord | null>;
  forPosition(positionId: string): Promise<DatedOccurrenceRecord | null>;
  /** Writes `outcome` and `settled_at` WHERE outcome IS NULL. `false` means already settled. */
  settle(id: string, outcome: DatedOutcome, at: Date): Promise<boolean>;
  listForSeries(seriesId: string, opts: { limit: number }): Promise<DatedOccurrenceRecord[]>;
  listForRow(rowId: string, opts: { limit: number }): Promise<DatedOccurrenceRecord[]>;
}

export function createDatedRowsRepo(db: Database, projectId: string): DatedRowsRepo {
  const inSeries = (seriesId: string) =>
    and(eq(standingSeriesDatedRows.projectId, projectId), eq(standingSeriesDatedRows.seriesId, seriesId));
  const mine = (id: string) => and(eq(standingSeriesDatedRows.projectId, projectId), eq(standingSeriesDatedRows.id, id));
  return {
    async insertMany(seriesId, rows) {
      if (rows.length === 0) return [];
      return db
        .insert(standingSeriesDatedRows)
        .values(rows.map((r) => ({ ...r, projectId, seriesId })))
        .returning();
    },
    async insert(seriesId, row) {
      const [r] = await db
        .insert(standingSeriesDatedRows)
        .values({ ...row, projectId, seriesId })
        .returning();
      return r!;
    },
    async get(id) {
      const [row] = await db.select().from(standingSeriesDatedRows).where(mine(id)).limit(1);
      return row ?? null;
    },
    async listForSeries(seriesId) {
      return db
        .select()
        .from(standingSeriesDatedRows)
        .where(inSeries(seriesId))
        .orderBy(asc(standingSeriesDatedRows.ordinal));
    },
    async page(seriesId, { page, pageSize }) {
      const [rows, [count]] = await Promise.all([
        db
          .select()
          .from(standingSeriesDatedRows)
          .where(inSeries(seriesId))
          .orderBy(asc(standingSeriesDatedRows.ordinal))
          .limit(pageSize)
          .offset((Math.max(1, page) - 1) * pageSize),
        db.select({ n: sql<number>`count(*)::int` }).from(standingSeriesDatedRows).where(inSeries(seriesId)),
      ]);
      return { rows, total: count?.n ?? 0 };
    },
    async count(seriesId) {
      const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(standingSeriesDatedRows).where(inSeries(seriesId));
      return row?.n ?? 0;
    },
    async update(id, patch) {
      if (Object.keys(patch).length === 0) return this.get(id);
      const [row] = await db.update(standingSeriesDatedRows).set(patch).where(mine(id)).returning();
      return row ?? null;
    },
    async delete(id) {
      const rows = await db.delete(standingSeriesDatedRows).where(mine(id)).returning({ id: standingSeriesDatedRows.id });
      return rows.length > 0;
    },
    async deleteMany(ids) {
      if (ids.length === 0) return 0;
      const rows = await db
        .delete(standingSeriesDatedRows)
        .where(and(eq(standingSeriesDatedRows.projectId, projectId), inArray(standingSeriesDatedRows.id, [...ids])))
        .returning({ id: standingSeriesDatedRows.id });
      return rows.length;
    },
    async dueOrPast(seriesId, today, _leadDays, limit) {
      return db
        .select()
        .from(standingSeriesDatedRows)
        .where(and(inSeries(seriesId), lte(standingSeriesDatedRows.nextTargetDate, today)))
        .orderBy(asc(standingSeriesDatedRows.nextTargetDate), asc(standingSeriesDatedRows.ordinal))
        .limit(limit);
    },
    async dueOn(seriesId, date) {
      return db
        .select()
        .from(standingSeriesDatedRows)
        .where(and(inSeries(seriesId), eq(standingSeriesDatedRows.nextTargetDate, date)))
        .orderBy(asc(standingSeriesDatedRows.ordinal));
    },
    async advance(id, to, from) {
      const fromCond = from === null ? sql`${standingSeriesDatedRows.nextTargetDate} IS NULL` : eq(standingSeriesDatedRows.nextTargetDate, from);
      const rows = await db
        .update(standingSeriesDatedRows)
        .set({ nextTargetDate: to })
        .where(and(mine(id), fromCond))
        .returning({ id: standingSeriesDatedRows.id });
      return rows.length > 0;
    },
    async firedYears(rowIds) {
      const result = new Map<string, number[]>();
      if (rowIds.length === 0) return result;
      const rows = await db
        .select({ rowId: standingSeriesOccurrences.rowId, year: standingSeriesOccurrences.year })
        .from(standingSeriesOccurrences)
        .where(and(eq(standingSeriesOccurrences.projectId, projectId), inArray(standingSeriesOccurrences.rowId, [...rowIds])));
      for (const r of rows) {
        const list = result.get(r.rowId) ?? [];
        list.push(r.year);
        result.set(r.rowId, list);
      }
      return result;
    },
  };
}

export function createDatedOccurrencesRepo(db: Database, projectId: string): DatedOccurrencesRepo {
  const mine = (id: string) => and(eq(standingSeriesOccurrences.projectId, projectId), eq(standingSeriesOccurrences.id, id));
  return {
    async insert(input) {
      const [row] = await db
        .insert(standingSeriesOccurrences)
        .values({ ...input, projectId })
        .returning();
      return row!;
    },
    async recordMissed({ seriesId, rowId, year, targetDate, at }) {
      await db
        .insert(standingSeriesOccurrences)
        .values({ projectId, seriesId, rowId, year, targetDate, outcome: "missed", positionId: null, recordedAt: at, settledAt: at })
        .onConflictDoNothing({ target: [standingSeriesOccurrences.rowId, standingSeriesOccurrences.year] });
    },
    async get(id) {
      const [row] = await db.select().from(standingSeriesOccurrences).where(mine(id)).limit(1);
      return row ?? null;
    },
    async forPosition(positionId) {
      const [row] = await db
        .select()
        .from(standingSeriesOccurrences)
        .where(and(eq(standingSeriesOccurrences.projectId, projectId), eq(standingSeriesOccurrences.positionId, positionId)))
        .limit(1);
      return row ?? null;
    },
    async settle(id, outcome, at) {
      const rows = await db
        .update(standingSeriesOccurrences)
        .set({ outcome, settledAt: at })
        .where(and(mine(id), sql`${standingSeriesOccurrences.outcome} IS NULL`))
        .returning({ id: standingSeriesOccurrences.id });
      return rows.length > 0;
    },
    async listForSeries(seriesId, { limit }) {
      return db
        .select()
        .from(standingSeriesOccurrences)
        .where(and(eq(standingSeriesOccurrences.projectId, projectId), eq(standingSeriesOccurrences.seriesId, seriesId)))
        .orderBy(sql`${standingSeriesOccurrences.targetDate} DESC`)
        .limit(limit);
    },
    async listForRow(rowId, { limit }) {
      return db
        .select()
        .from(standingSeriesOccurrences)
        .where(and(eq(standingSeriesOccurrences.projectId, projectId), eq(standingSeriesOccurrences.rowId, rowId)))
        .orderBy(sql`${standingSeriesOccurrences.year} DESC`)
        .limit(limit);
    },
  };
}

/**
 * Deletes at most `limit` settled occurrences recorded before `before` (contracts/worker.md §6): the
 * same 90-day horizon and batch size the closed-run prune uses. A pending occurrence
 * (`outcome IS NULL`) is never matched.
 */
export async function pruneSettledOccurrencesBefore(before: Date, limit: number): Promise<number> {
  const db = getDb();
  const ids = await db
    .select({ id: standingSeriesOccurrences.id })
    .from(standingSeriesOccurrences)
    .where(and(isNotNull(standingSeriesOccurrences.outcome), lt(standingSeriesOccurrences.recordedAt, before)))
    .limit(limit);
  if (ids.length === 0) return 0;
  const gone = await db
    .delete(standingSeriesOccurrences)
    .where(
      inArray(
        standingSeriesOccurrences.id,
        ids.map((r) => r.id),
      ),
    )
    .returning({ id: standingSeriesOccurrences.id });
  return gone.length;
}
