/** `docket_` + the operation id in snake_case (research D13). */
export function toolNameFor(operationId: string): string {
  return `docket_${operationId.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`;
}

/** The frozen twenty-one (FR-004): renaming an operation id breaks this list, not a client. */
export const PUBLISHED_TOOL_NAMES: readonly string[] = [
  "docket_list_accounts",
  "docket_set_account_posting_instructions",
  "docket_list_media",
  "docket_get_media",
  "docket_create_post",
  "docket_update_post",
  "docket_get_post",
  "docket_get_post_target",
  "docket_queue_post",
  "docket_schedule_post",
  "docket_generate_post",
  "docket_list_upcoming_slots",
  "docket_add_slot",
  "docket_add_week_slots",
  "docket_update_slot",
  "docket_delete_slot",
  "docket_list_activity",
  "docket_get_insights",
  "docket_create_project",
  "docket_create_voice_profile",
  "docket_update_voice_profile",
];
