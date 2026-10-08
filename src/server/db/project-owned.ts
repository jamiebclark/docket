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
  { table: "social_accounts", scopeColumn: "project_id" },
  { table: "posting_slots", scopeColumn: "project_id" },
  { table: "media_assets", scopeColumn: "project_id" },
  { table: "media_variants", scopeColumn: "project_id" },
  { table: "media_uploads", scopeColumn: "project_id" },
  { table: "posts", scopeColumn: "project_id" },
  { table: "post_media", scopeColumn: "project_id" },
  { table: "post_targets", scopeColumn: "project_id" },
  { table: "publish_attempts", scopeColumn: "project_id" },
  { table: "connect_attempts", scopeColumn: "project_id" },
  { table: "voice_profiles", scopeColumn: "project_id" },
  { table: "voice_profile_versions", scopeColumn: "project_id" },
  { table: "generation_series", scopeColumn: "project_id" },
  { table: "generation_failures", scopeColumn: "project_id" },
  { table: "generation_jobs", scopeColumn: "project_id" },
  { table: "generation_job_items", scopeColumn: "project_id" },
  { table: "api_keys", scopeColumn: "project_id" },
  { table: "api_idempotency_keys", scopeColumn: "project_id" },
  { table: "webhook_endpoints", scopeColumn: "project_id" },
  { table: "webhook_events", scopeColumn: "project_id" },
  { table: "webhook_deliveries", scopeColumn: "project_id" },
  { table: "webhook_delivery_attempts", scopeColumn: "project_id" },
  { table: "allowance_uses", scopeColumn: "project_id" },
] as const satisfies readonly ProjectOwnedTable[];

export const notProjectOwned = [
  "user",
  "session",
  "account",
  "verification",
  "install_state",
  "scheduler_heartbeats",
] as const;
