import { z } from "zod";
import type { EngagementReadContext, EngagementSendContext, EngagementSendResult, EngagementSupport } from "../types";
import { mockSettingsSchema, type MockSettings } from "./settings";

/**
 * Declares all four inbound kinds plus the `unavailable` variant, backed by scripted fixtures
 * (`settings.engagementItems`), so the generic layer and the Meta/DM seam are testable with no
 * platform credentials (contracts/provider-engagement.md's closing note).
 */
export const mockEngagement: EngagementSupport<MockSettings> = {
  declaration: {
    reads: ["reply", "comment", "mention", "direct_message"],
    canReply: true,
    writeBudget: { count: 1000, windowSeconds: 3600 },
  },
  itemDataSchema: z.object({}).passthrough(),
  stateSchema: z.object({}).passthrough(),

  async read(ctx: EngagementReadContext<MockSettings>) {
    const settings = mockSettingsSchema.parse(ctx.account.settings ?? {});
    if (settings.engagementUnavailable) {
      return { kind: "unavailable", reason: "Mock engagement is set to unavailable for this account." };
    }
    if (ctx.cursor) return { kind: "page", items: [], cursor: null, exhausted: true };
    const items = settings.engagementItems.map((item) => ({
      kind: item.kind,
      externalId: item.externalId,
      text: item.text,
      author: {
        displayName: item.authorDisplayName,
        handle: item.authorHandle,
        externalId: item.authorExternalId,
        url: null,
        identityStable: item.identityStable,
      },
      saidAt: new Date(item.saidAt),
      parentExternalId: item.parentExternalId,
    }));
    return { kind: "page" as const, items, cursor: null, exhausted: true };
  },

  async send(ctx: EngagementSendContext<MockSettings>): Promise<EngagementSendResult> {
    const settings = mockSettingsSchema.parse(ctx.account.settings ?? {});
    switch (settings.engagementSendBehaviour) {
      case "sent":
        return { kind: "sent", externalId: `mock-reply-${ctx.item.externalId}`, url: "https://mock.invalid/reply" };
      case "duplicate":
        return { kind: "duplicate" };
      case "ambiguous":
        return { kind: "ambiguous", error: "Mock could not confirm the reply." };
      case "fatal_error":
        return { kind: "fatal_error", error: "Mock rejected the reply." };
      case "credentials_invalid":
        return { kind: "credentials_invalid", error: "Mock rejected the session." };
    }
  },
};
