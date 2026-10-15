import { describe, expect, it } from "vitest";
import { OPERATIONS } from "@/server/api/operations";
import { PUBLISHED_TOOL_NAMES, toolNameFor } from "@/server/mcp/naming";

describe("toolNameFor", () => {
  it("derives docket_ + snake_case for every operation id", () => {
    expect(toolNameFor("listAccounts")).toBe("docket_list_accounts");
    expect(toolNameFor("getPostTarget")).toBe("docket_get_post_target");
    expect(toolNameFor("setAccountPostingInstructions")).toBe("docket_set_account_posting_instructions");
    for (const op of OPERATIONS) {
      expect(toolNameFor(op.id)).toBe(`docket_${op.id.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`);
    }
  });
});

describe("PUBLISHED_TOOL_NAMES", () => {
  it("is the frozen twenty", () => {
    expect(PUBLISHED_TOOL_NAMES).toEqual([
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
      "docket_create_project",
      "docket_create_voice_profile",
      "docket_update_voice_profile",
    ]);
    expect(PUBLISHED_TOOL_NAMES).toHaveLength(20);
  });
});
