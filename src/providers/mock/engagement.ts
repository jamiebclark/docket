import { z } from "zod";
import type { EngagementReadContext, EngagementSendContext, EngagementSendResult, EngagementSupport } from "../types";
import { mockSettingsSchema, type MockSettings } from "./settings";

/** Lets a test hold `send()` open long enough for two overlapping ticks to race (FR-039, SC-004). */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    }, { once: true });
  });
}

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
    const offset = ctx.cursor ? Number(ctx.cursor) : 0;
    const pagesServed = ctx.limit > 0 ? offset / ctx.limit : 0;
    const shouldFailNow = settings.engagementReadFailAfterPages === undefined || pagesServed >= settings.engagementReadFailAfterPages;
    if (shouldFailNow) {
      switch (settings.engagementReadBehaviour) {
        case "retryable_error":
          return { kind: "retryable_error", error: "Mock retryable read failure." };
        case "rate_limited":
          return { kind: "rate_limited", error: "Mock read rate limited." };
        case "credentials_invalid":
          return { kind: "credentials_invalid", error: "Mock read credentials invalid." };
        case "cursor_lost":
          return { kind: "cursor_lost", error: "Mock cursor lost." };
        case "fatal_error":
          return { kind: "fatal_error", error: "Mock fatal read failure." };
        case "page":
          break;
      }
    }
    const allItems = settings.engagementItems.map((item) => ({
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
      upstream: item.upstream,
    }));
    // Paged `ctx.limit` at a time, in fixture order, so a multi-page backlog and the cursor and
    // backfill machinery are exercisable with no platform credentials.
    const page = allItems.slice(offset, offset + ctx.limit);
    const nextOffset = offset + page.length;
    const exhausted = nextOffset >= allItems.length;
    return { kind: "page" as const, items: page, cursor: exhausted ? null : String(nextOffset), exhausted };
  },

  async send(ctx: EngagementSendContext<MockSettings>): Promise<EngagementSendResult> {
    const settings = mockSettingsSchema.parse(ctx.account.settings ?? {});
    if (settings.delayMs > 0) await sleep(settings.delayMs, ctx.signal);
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

/**
 * Test-only convenience: builds the `EngagementProviderRule` shape (contracts/engagement-read-scopes.md
 * §4) a test can pass to `src/server/dal/engagement-read-claims.ts` from a mock account's own
 * scripted settings, so the scope gate is exercisable with no real provider.
 */
export function mockEngagementRuleFor(settings: MockSettings): { providerKey: "mock"; readScopes: readonly string[] } {
  return { providerKey: "mock", readScopes: settings.engagementReadScopes };
}
