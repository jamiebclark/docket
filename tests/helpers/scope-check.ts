export interface ProjectOwnedTable {
  table: string;
  scopeColumn: string;
}

export interface QueryRecord {
  sql: string;
  params?: readonly unknown[];
  crossProjectReason?: string;
}

export interface ScopeCheckResult {
  violations: string[];
  checked: number;
  crossProject: { reason: string; sql: string }[];
}

interface TableRef {
  table: string;
  alias: string;
  scopeColumn: string;
}

const NOT_ALIASES = new Set([
  "where", "on", "set", "inner", "left", "right", "full", "cross", "join",
  "using", "group", "order", "limit", "offset", "returning", "values",
  "select", "union", "as", "natural", "outer", "for", "having",
]);

const IDENT = String.raw`(?:"([^"]+)"|([A-Za-z_]\w*))`;

function unquote(a: string | undefined, b: string | undefined): string {
  return (a ?? b ?? "").toLowerCase();
}

function findTables(sql: string, owned: readonly ProjectOwnedTable[]): TableRef[] {
  const refs: TableRef[] = [];
  const re = new RegExp(
    String.raw`\b(?:from|join|update|into)\s+(?:${IDENT}\s*\.\s*)?${IDENT}(?:\s+(?:as\s+)?${IDENT})?`,
    "gi",
  );
  for (const m of sql.matchAll(re)) {
    // Groups: 1,2 = optional schema; 3,4 = table; 5,6 = alias
    const table = unquote(m[3], m[4]);
    const entry = owned.find((o) => o.table === table);
    if (!entry) continue;
    let alias = unquote(m[5], m[6]);
    if (!m[5] && NOT_ALIASES.has(alias)) alias = "";
    refs.push({ table, alias: alias || table, scopeColumn: entry.scopeColumn });
  }
  return refs;
}

const COL = String.raw`(?:${IDENT}\s*\.\s*)?${IDENT}`; // optional qualifier + column

/** Returns the alias-or-table qualifier ("" if unqualified) and column. */
function parseCol(a?: string, b?: string, c?: string, d?: string): { q: string; col: string } {
  return { q: unquote(a, b), col: unquote(c, d) };
}

function whereClause(sql: string): string {
  const i = sql.search(/\bwhere\b/i);
  return i === -1 ? "" : sql.slice(i + 5);
}

function pinnedAliases(sql: string, refs: TableRef[]): Set<string> {
  const pinned = new Set<string>();
  const where = whereClause(sql);
  // `or` anywhere in the predicate means equality may not pin the project.
  const disjunctive = /\bor\b/i.test(where);
  const resolve = (q: string, col: string): TableRef | undefined => {
    const cands = q
      ? refs.filter((r) => r.alias === q || r.table === q)
      : refs.length === 1
        ? refs
        : [];
    return cands.find((r) => r.scopeColumn === col);
  };

  if (!disjunctive) {
    const eq = new RegExp(`${COL}\\s*=\\s*\\$\\d+`, "gi");
    for (const m of where.matchAll(eq)) {
      const { q, col } = parseCol(m[1], m[2], m[3], m[4]);
      const r = resolve(q, col);
      if (r) pinned.add(r.alias);
    }
    const rev = new RegExp(`\\$\\d+\\s*=\\s*${COL}`, "gi");
    for (const m of where.matchAll(rev)) {
      const { q, col } = parseCol(m[1], m[2], m[3], m[4]);
      const r = resolve(q, col);
      if (r) pinned.add(r.alias);
    }
  }

  // Column-to-column equality between two scope columns (join or where).
  const links: [string, string][] = [];
  const colEq = new RegExp(`${COL}\\s*=\\s*${COL}`, "gi");
  const joinPart = disjunctive ? sql.slice(0, Math.max(0, sql.search(/\bwhere\b/i))) : sql;
  for (const m of joinPart.matchAll(colEq)) {
    const l = parseCol(m[1], m[2], m[3], m[4]);
    const r = parseCol(m[5], m[6], m[7], m[8]);
    const lr = resolve(l.q, l.col);
    const rr = resolve(r.q, r.col);
    if (lr && rr && lr.alias !== rr.alias) links.push([lr.alias, rr.alias]);
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const [a, b] of links) {
      if (pinned.has(a) !== pinned.has(b)) {
        pinned.add(a);
        pinned.add(b);
        changed = true;
      }
    }
  }
  return pinned;
}

function insertColumns(sql: string): Set<string> {
  const m = sql.match(new RegExp(String.raw`\binsert\s+into\s+(?:${IDENT}\s*\.\s*)?${IDENT}\s*\(([^)]*)\)`, "i"));
  const cols = new Set<string>();
  if (!m) return cols;
  for (const part of (m[5] ?? "").split(",")) {
    cols.add(part.trim().replace(/^"|"$/g, "").toLowerCase());
  }
  return cols;
}

export function checkScope(
  records: readonly QueryRecord[],
  projectOwnedTables: readonly ProjectOwnedTable[],
): ScopeCheckResult {
  const owned = projectOwnedTables.map((o) => ({
    table: o.table.toLowerCase(),
    scopeColumn: o.scopeColumn.toLowerCase(),
  }));
  const result: ScopeCheckResult = { violations: [], checked: 0, crossProject: [] };

  for (const record of records) {
    const sql = record.sql.replace(/\s+/g, " ").trim();
    if (record.crossProjectReason) {
      result.crossProject.push({ reason: record.crossProjectReason, sql });
      continue;
    }
    const refs = findTables(sql, owned);
    if (refs.length === 0) continue;
    result.checked++;
    const kind = sql.match(/^\s*(\w+)/)?.[1]?.toLowerCase();

    if (kind === "insert") {
      const cols = insertColumns(sql);
      const target = refs[0]!;
      if (!cols.has(target.scopeColumn)) {
        result.violations.push(
          `Unscoped query on project-owned table "${target.table}" (insert needs "${target.scopeColumn}" in its column list):\n  ${sql}`,
        );
      }
      continue;
    }

    const pinned = pinnedAliases(sql, refs);
    const seen = new Set<string>();
    for (const r of refs) {
      if (pinned.has(r.alias) || seen.has(r.alias)) continue;
      seen.add(r.alias);
      result.violations.push(
        `Unscoped query on project-owned table "${r.table}" (needs "${r.table}"."${r.scopeColumn}" = $n):\n  ${sql}`,
      );
    }
  }
  return result;
}
