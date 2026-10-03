export interface ProjectOwnedTable {
  table: string;
  scopeColumn: string;
}

// Every table with a project scope column. A later feature adds one line per new table.
export const projectOwnedTables = [
  { table: "projects", scopeColumn: "id" },
  { table: "organization", scopeColumn: "id" },
  { table: "member", scopeColumn: "organization_id" },
  { table: "invitation", scopeColumn: "organization_id" },
  { table: "invitation_tokens", scopeColumn: "project_id" },
  { table: "membership_audit_log", scopeColumn: "project_id" },
] as const satisfies readonly ProjectOwnedTable[];

export const notProjectOwned = [
  "user",
  "session",
  "account",
  "verification",
  "install_state",
] as const;
