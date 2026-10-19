import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { engagementDrafts } from "../../../src/server/db/schema/engagement";
import { ForbiddenError } from "../../../src/server/dal/errors";
import { forApiKey, forJobRunner, requirePermission } from "../../../src/server/dal/scope";
import { ALL_PERMISSIONS, createKey } from "../../helpers/api";
import { closeDb, testDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});

async function seedItem(scope: Awaited<ReturnType<typeof postsEnv>>["scope"], accountId: string) {
  const { id } = await scope.engagementItems.insertIfAbsent({
    socialAccountId: accountId,
    providerKey: "mock",
    kind: "reply",
    externalId: `ext-${Math.random().toString(36).slice(2)}`,
    text: "Great post!",
    authorDisplayName: "Ada",
    authorHandle: "ada",
    authorExternalId: "ada-1",
    authorUrl: null,
    authorIdentityStable: true,
    saidAt: new Date("2026-01-01T00:00:00Z"),
    ingestedAt: new Date("2026-01-01T00:00:01Z"),
    parentExternalId: null,
  });
  return id;
}

describe("no path to an unreviewed send (SC-003)", () => {
  it("the database refuses a non-'none' send state on a draft that is not approved", async () => {
    const env = await postsEnv();
    const scope = await env.as(env.owner);
    const account = await env.account({});
    const itemId = await seedItem(scope, account.id);

    const attempt = testDb().insert(engagementDrafts).values({
      projectId: env.project.id,
      engagementItemId: itemId,
      socialAccountId: account.id,
      text: "Thanks!",
      origin: "person",
      reviewState: "needs_review",
      sendState: "waiting",
    });
    let caught: unknown;
    try {
      await attempt;
    } catch (error) {
      caught = error;
    }
    expect(caught, "expected the insert to be refused").toBeDefined();
    const cause = (caught as { cause?: { constraint?: string } } | undefined)?.cause;
    expect(cause?.constraint).toBe("engagement_drafts_send_requires_approved");
  });

  it("every ApiKeyPermission and the job-runner scope fail an engagement request", async () => {
    const env = await postsEnv();
    const ownerScope = await env.as(env.owner);
    for (const permission of ALL_PERMISSIONS) {
      const { secret } = await createKey(ownerScope, [permission]);
      const { scope: apiScope } = await forApiKey(secret);
      expect(() => requirePermission(apiScope, { engagement: ["view"] })).toThrow(ForbiddenError);
      expect(() => requirePermission(apiScope, { engagement: ["reply"] })).toThrow(ForbiddenError);
    }
    const jobRunnerScope = await forJobRunner(env.project.id, null);
    expect(() => requirePermission(jobRunnerScope, { engagement: ["view"] })).toThrow(ForbiddenError);
    expect(() => requirePermission(jobRunnerScope, { engagement: ["reply"] })).toThrow(ForbiddenError);
  });

  it("no exported service function approves more than one reply at a time", () => {
    const reviewSource = readFileSync("src/server/services/engagement/review.ts", "utf8");
    const exportedFunctionNames = [...reviewSource.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]!);
    for (const name of exportedFunctionNames) {
      expect(name.toLowerCase()).not.toContain("bulkapprove");
    }
    expect(exportedFunctionNames).toContain("approveReply");
    expect(exportedFunctionNames).toContain("dismissItems");
  });

  it("no API operation and no MCP tool exposes the engagement inbox", () => {
    // The operation registry must not mention engagement at all: `OPERATIONS` feeds the router, the
    // OpenAPI document and the MCP tool list together, so an entry here is a live surface.
    const operationsSource = readFileSync("src/server/api/operations/index.ts", "utf8");
    expect(operationsSource).not.toMatch(/engagement/i);

    // `schemas.ts` is checked for the inbox's own nouns rather than the word "engagement". 083's
    // time-to-first-engagement is a read-only figure about how quickly people replied, named for
    // engagement but reaching none of its write machinery; banning the substring outright flagged
    // it, which is a false positive on a guard that has to stay sharp.
    const schemasSource = readFileSync("src/lib/api/schemas.ts", "utf8");
    expect(schemasSource).not.toMatch(/engagement(item|draft|reply|send|claim)/i);
    expect(schemasSource).not.toMatch(/\b(sendReply|unreviewed|needs_review|approveDraft)\b/i);

    // And every remaining mention is the first-engagement read, not something new that slipped in.
    const mentions = schemasSource.split("\n").filter((line) => /engagement/i.test(line));
    for (const line of mentions) {
      expect(line, `unexpected engagement mention in schemas.ts: ${line.trim()}`).toMatch(/FirstEngagement/);
    }
  });
});
