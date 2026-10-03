import { z } from "zod";

export const APPROVAL_POLICIES = ["review_required", "auto_approve"] as const;
export const SCHEDULING_POLICIES = ["leave_as_draft", "add_to_queue"] as const;

export const approvalPolicySchema = z.enum(APPROVAL_POLICIES, { error: "Choose an approval policy" });
export const schedulingPolicySchema = z.enum(SCHEDULING_POLICIES, {
  error: "Choose a scheduling policy",
});
