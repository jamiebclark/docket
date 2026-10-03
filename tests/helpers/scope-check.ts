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
  // Further items of a comma-separated `from a, b` / `using a, b` list.
  const listRe = /\b(?:from|using)\s+([^()]*?)(?=\b(?:where|inner|left|right|full|cross|natural|join|on|group|order|limit|offset|returning|union|having|set|for)\b|\)|$)/gi;
  const itemRe = new RegExp(
    String.raw`^\s*(?:${IDENT}\s*\.\s*)?${IDENT}(?:\s+(?:as\s+)?${IDENT})?\s*$`,
    "i",
  );
  for (const seg of sql.matchAll(listRe)) {
    for (const item of seg[1]!.split(",").slice(1)) {
      const m = item.match(itemRe);
      if (!m) continue;
      const table = unquote(m[3], m[4]);
      const entry = owned.find((o) => o.table === table);
      if (!entry) continue;
      const alias = unquote(m[5], m[6]);
      refs.push({ table, alias: alias || table, scopeColumn: entry.scopeColumn });
    }
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
  // `or` or `not` anywhere in the predicate means equality may not pin the project.
  // (`is not null` is a null test, not a negated predicate.)
  const disjunctive = /\bor\b|\bnot\b(?!\s+null\b)/i.test(where);
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

/**
 * Splits a statement into its query scopes: the outer query plus each `(select ...)`
 * subquery. Each returned string keeps every character index but blanks anything that
 * belongs to another scope, so a pin inside a subquery never pins an outer reference.
 */
function splitScopes(sql: string): string[] {
  const owner: number[] = [];
  const stack: number[] = [0];
  let count = 1;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "(") {
      const sub = /^\(\s*select\b/i.test(sql.slice(i, i + 40));
      const id = sub ? count++ : stack[stack.length - 1]!;
      // The opening paren of a subquery belongs to the subquery, not to the outer scope.
      stack.push(id);
      owner.push(id);
    } else if (ch === ")") {
      owner.push(stack[stack.length - 1]!);
      if (stack.length > 1) stack.pop();
    } else {
      owner.push(stack[stack.length - 1]!);
    }
  }
  return Array.from({ length: count }, (_, id) =>
    [...sql].map((c, i) => (owner[i] === id ? c : " ")).join(""),
  );
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
    if (findTables(sql, owned).length === 0) continue;
    result.checked++;
    const statementKind = sql.match(/^\s*(\w+)/)?.[1]?.toLowerCase();

    // Each query scope (outer query, every subquery) is checked on its own.
    splitScopes(sql).forEach((scopeSql, scopeId) => {
      const refs = findTables(scopeSql, owned);
      if (refs.length === 0) return;
      const kind = scopeId === 0 ? statementKind : "select";

      if (kind === "insert") {
        // `insert ... select`: the select part is a query in its own right.
        const selAt = scopeSql.search(/\bselect\b/i);
        const insertSql = selAt === -1 ? scopeSql : scopeSql.slice(0, selAt);
        if (selAt !== -1) {
          const selSql = scopeSql.slice(selAt);
          const selRefs = findTables(selSql, owned);
          const selPinned = pinnedAliases(selSql, selRefs);
          for (const r of selRefs) {
            if (selPinned.has(r.alias)) continue;
            result.violations.push(
              `Unscoped query on project-owned table "${r.table}" (needs "${r.table}"."${r.scopeColumn}" = $n):\n  ${sql}`,
            );
          }
        }
        const cols = insertColumns(insertSql);
        const target = findTables(insertSql, owned)[0];
        if (!target) return;
        if (!cols.has(target.scopeColumn)) {
          result.violations.push(
            `Unscoped query on project-owned table "${target.table}" (insert needs "${target.scopeColumn}" in its column list):\n  ${sql}`,
          );
        }
        return;
      }

      const pinned = pinnedAliases(scopeSql, refs);
      const seen = new Set<string>();
      for (const r of refs) {
        if (pinned.has(r.alias) || seen.has(r.alias)) continue;
        seen.add(r.alias);
        result.violations.push(
          `Unscoped query on project-owned table "${r.table}" (needs "${r.table}"."${r.scopeColumn}" = $n):\n  ${sql}`,
        );
      }
    });
  }
  return result;
}
