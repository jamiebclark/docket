import { and, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { socialAccounts } from "../db/schema";

/** Holds every scope. `NULL` = not recorded, so it holds nothing. */
export function accountHoldsScopes(scopes: readonly string[]): SQL | undefined {
  if (scopes.length === 0) return undefined;
  return and(
    isNotNull(socialAccounts.grantedScopes),
    sql`${socialAccounts.grantedScopes} @> ${sql.param([...scopes])}::text[]`,
  );
}

/** Missing at least one scope — the negation, with `NULL` on the missing side. */
export function accountMissingScopes(scopes: readonly string[]): SQL {
  return or(
    isNull(socialAccounts.grantedScopes),
    sql`NOT (${socialAccounts.grantedScopes} @> ${sql.param([...scopes])}::text[])`,
  )!;
}
