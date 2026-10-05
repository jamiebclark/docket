// Run-scoped test databases: naming, ownership labels and the stale-database sweep.
//
// Every Vitest run gets its own databases, named `<prefix>_<checkout>_<id>_test` (plus one
// `…_w<n>_test` clone per worker and any `docket_tmp_…_test` throwaways). Each one carries a
// JSON label (COMMENT ON DATABASE) saying which run owns it. Global teardown drops the run's
// databases; a sweep at the start of every run, and `pnpm db:test:clean`, drop databases left
// behind by runs that crashed or were killed. Nothing without a `_test` suffix is ever touched.
//
// Self-contained (pg and node built-ins only) so scripts/test-db-clean.ts can bundle it.
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { basename } from "node:path";
import pg from "pg";

/** What a run writes into COMMENT ON DATABASE for every database it creates. */
export interface RunLabel {
  docketTestRun: string;
  host: string;
  pid: number;
  started: string;
  cwd: string;
}

/** A database as the sweep sees it. */
export interface DatabaseInfo {
  name: string;
  connections: number;
  label: RunLabel | null;
}

/** Databases a sweep never drops, whatever their label says. */
export const PROTECTED_DATABASES = new Set(["postgres", "template0", "template1", "docket"]);

/** Labelled databases older than this are stale even if their owner looks alive (pid reuse, other hosts). */
export const DEFAULT_STALE_HOURS = 12;

/** Postgres truncates identifiers at 63 bytes; worker suffixes need room. */
const MAX_NAME = 63;

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

export function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}

export function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/** The maintenance database URL on the same server, for CREATE/DROP DATABASE. */
export function adminUrl(url: string): string {
  return withDatabase(url, "postgres");
}

/** Lowercase letters, digits and underscores, at most `max` characters. */
export function slug(text: string, max = 16): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, max)
    .replace(/_+$/g, "");
  return s || "run";
}

export function newRunId(): string {
  return randomBytes(3).toString("hex");
}

/**
 * The base database name for one run: `docket_test` run from `.claude/worktrees/ui-makeover`
 * becomes `docket_ui_makeover_3f9a1c_test`. Keeps the `_test` suffix the safety check needs and
 * leaves room for `_w<n>` worker suffixes.
 */
export function runDatabaseName(configured: string, cwd: string, runId: string): string {
  if (!configured.endsWith("_test")) throw new Error(`Refusing to derive a test database from "${configured}": the name must end in _test.`);
  const prefix = configured.slice(0, -"_test".length);
  const tail = `_${runId}_test`;
  const room = MAX_NAME - prefix.length - tail.length - "_w99".length - 1;
  const checkout = room >= 4 ? `_${slug(basename(cwd), Math.min(16, room))}` : "";
  return `${prefix}${checkout}${tail}`;
}

export function runLabel(runId: string, pid = process.pid, cwd = process.cwd(), now = new Date()): RunLabel {
  return { docketTestRun: runId, host: hostname(), pid, started: now.toISOString(), cwd };
}

/** Parses a database comment; anything that is not a Docket run label is `null`. */
export function parseLabel(comment: string | null | undefined): RunLabel | null {
  if (!comment) return null;
  try {
    const v = JSON.parse(comment) as Partial<RunLabel>;
    if (typeof v.docketTestRun !== "string" || typeof v.host !== "string" || typeof v.pid !== "number" || typeof v.started !== "string") return null;
    return { docketTestRun: v.docketTestRun, host: v.host, pid: v.pid, started: v.started, cwd: typeof v.cwd === "string" ? v.cwd : "" };
  } catch {
    return null;
  }
}

/** `true` when a process with this pid exists on this machine (EPERM means it exists but is not ours). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface StaleOptions {
  now: Date;
  host: string;
  isAlive: (pid: number) => boolean;
  staleHours?: number;
  /** Also consider unlabelled `_test` databases (left by runs from before labels existed). Manual cleanup only. */
  includeUnlabeled?: boolean;
  /** Names to keep regardless. */
  keep?: ReadonlySet<string>;
}

/**
 * Why a database may be dropped, or `null` to keep it. Rules, all required:
 * the name ends in `_test` and is not protected or kept; nobody is connected; and either
 * its owning run is gone (dead pid on this host, or older than `staleHours`) or, with
 * `includeUnlabeled`, it has no label at all.
 */
export function staleReason(db: DatabaseInfo, options: StaleOptions): string | null {
  if (!db.name.endsWith("_test") || PROTECTED_DATABASES.has(db.name) || options.keep?.has(db.name)) return null;
  if (db.connections > 0) return null;
  const label = db.label;
  if (!label) return options.includeUnlabeled ? "unlabelled" : null;
  const ageHours = (options.now.getTime() - Date.parse(label.started)) / 3_600_000;
  if (Number.isFinite(ageHours) && ageHours > (options.staleHours ?? DEFAULT_STALE_HOURS)) {
    return `older than ${options.staleHours ?? DEFAULT_STALE_HOURS} h (run ${label.docketTestRun})`;
  }
  if (label.host === options.host && !options.isAlive(label.pid)) return `owner pid ${label.pid} has exited (run ${label.docketTestRun})`;
  return null;
}

/** Every non-template database on the server with its connection count and run label. */
export async function listDatabases(admin: pg.Pool): Promise<DatabaseInfo[]> {
  const { rows } = await admin.query<{ name: string; connections: string; comment: string | null }>(
    `select d.datname as name,
            (select count(*) from pg_stat_activity a where a.datname = d.datname) as connections,
            shobj_description(d.oid, 'pg_database') as comment
       from pg_database d
      where not d.datistemplate
      order by d.datname`,
  );
  return rows.map((r) => ({ name: r.name, connections: Number(r.connections), label: parseLabel(r.comment) }));
}

/** Creates `name` (optionally from a template) and labels it as owned by `label`'s run. */
export async function createLabelledDatabase(admin: pg.Pool, name: string, label: RunLabel, template?: string): Promise<void> {
  await admin.query(`create database ${quote(name)}${template ? ` template ${quote(template)}` : ""}`);
  await admin.query(`comment on database ${quote(name)} is ${pg.escapeLiteral(JSON.stringify(label))}`);
}

export async function dropDatabase(admin: pg.Pool, name: string): Promise<void> {
  if (!name.endsWith("_test") || PROTECTED_DATABASES.has(name)) throw new Error(`Refusing to drop "${name}": not a test database.`);
  await admin.query(`drop database if exists ${quote(name)} with (force)`);
}

/** Drops every database labelled with `runId`. Used by global teardown. */
export async function dropRun(admin: pg.Pool, runId: string): Promise<string[]> {
  const mine = (await listDatabases(admin)).filter((d) => d.label?.docketTestRun === runId);
  for (const d of mine) await dropDatabase(admin, d.name);
  return mine.map((d) => d.name);
}

/** Drops stale databases (see `staleReason`); with `dryRun` only reports them. */
export async function sweep(
  admin: pg.Pool,
  options: Omit<StaleOptions, "now" | "host" | "isAlive"> & Partial<StaleOptions> & { dryRun?: boolean },
): Promise<{ name: string; reason: string }[]> {
  const opts: StaleOptions = { now: new Date(), host: hostname(), isAlive: processAlive, ...options };
  const stale = (await listDatabases(admin))
    .map((d) => ({ name: d.name, reason: staleReason(d, opts) }))
    .filter((d): d is { name: string; reason: string } => d.reason !== null);
  if (!options.dryRun) for (const d of stale) await dropDatabase(admin, d.name);
  return stale;
}
