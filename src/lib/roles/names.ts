export type Manager = { name: string; role: "owner" | "admin" };

/** "A", "A or B", "A, B or C", "A, B, C or n others"; blank names dropped; `fallback` when none remain. */
export function joinNames(
  names: readonly string[],
  conjunction: "and" | "or",
  fallback = "an owner or admin",
): string {
  const kept = names.map((n) => n.trim()).filter((n) => n.length > 0);
  const [a, b, c] = kept;
  if (a === undefined) return fallback;
  if (b === undefined) return a;
  if (c === undefined) return `${a} ${conjunction} ${b}`;
  if (kept.length === 3) return `${a}, ${b} ${conjunction} ${c}`;
  const others = kept.length - 3;
  return `${a}, ${b}, ${c} ${conjunction} ${others} ${others === 1 ? "other" : "others"}`;
}

/** Owners and admins only, owners first, otherwise input order; returns only name and role. */
export function managersOf(rows: readonly { name: string; role: string }[]): Manager[] {
  const pick = (role: Manager["role"]) =>
    rows.filter((r) => r.role === role).map((r) => ({ name: r.name, role }));
  return [...pick("owner"), ...pick("admin")];
}

export function askManagers(managers: readonly Manager[], conjunction: "and" | "or"): string {
  return joinNames(
    managers.map((m) => m.name),
    conjunction,
  );
}

export function askOwners(managers: readonly Manager[], conjunction: "and" | "or"): string {
  return joinNames(
    managers.filter((m) => m.role === "owner").map((m) => m.name),
    conjunction,
    "an owner",
  );
}
