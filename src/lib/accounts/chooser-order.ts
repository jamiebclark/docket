/** Roots in input order, each followed by its children in input order. Keeps every element exactly once. */
export function listedOrder<T extends { key: string; parentKey: string | null }>(candidates: readonly T[]): T[] {
  const keys = new Set(candidates.map((c) => c.key));
  const isRoot = (c: T) => c.parentKey === null || !keys.has(c.parentKey);
  const out: T[] = [];
  for (const root of candidates.filter(isRoot)) {
    out.push(root);
    for (const child of candidates) {
      if (child !== root && !isRoot(child) && child.parentKey === root.key) out.push(child);
    }
  }
  return out;
}
