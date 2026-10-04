import { pgEnum } from "drizzle-orm/pg-core";

// Kept apart from projects.ts so posts.ts can use them without an import cycle through generation.ts.
export const approvalPolicy = pgEnum("approval_policy", ["review_required", "auto_approve"]);
export const schedulingPolicy = pgEnum("scheduling_policy", ["leave_as_draft", "add_to_queue"]);
