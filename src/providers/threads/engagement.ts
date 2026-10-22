import { z } from "zod";
import type { EngagementReadContext, EngagementReadResult, EngagementSendContext, EngagementSendResult, EngagementSupport } from "../types";
import type { ThreadsSettings } from "./settings";

const REASON =
  "Docket cannot read Threads replies or mentions yet: Threads does not publish a confirmed "
  + "read endpoint for either surface, so there is nothing to call. This is not a setting you "
  + "can change or a step that would fix it.";
const DOCS_PATH = "meta-setup#engagement";

const threadsEngagementItemDataSchema = z.object({}).strict();
const threadsEngagementStateSchema = z.object({}).strict();

async function read(_ctx: EngagementReadContext<ThreadsSettings>): Promise<EngagementReadResult> {
  return { kind: "unavailable", reason: REASON, docsPath: DOCS_PATH };
}

async function send(_ctx: EngagementSendContext<ThreadsSettings>): Promise<EngagementSendResult> {
  return { kind: "fatal_error", error: "Threads replies cannot be sent through Docket." };
}

export const threadsEngagement: EngagementSupport<ThreadsSettings> = {
  declaration: {
    reads: ["reply", "mention"],
    canReply: false,
    unavailable: { reason: REASON, docsPath: DOCS_PATH },
  },
  itemDataSchema: threadsEngagementItemDataSchema,
  stateSchema: threadsEngagementStateSchema,
  read,
  send,
};
