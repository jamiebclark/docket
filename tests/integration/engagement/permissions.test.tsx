import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import { AccountSchema } from "../../../src/lib/api/schemas";
import { ForbiddenError } from "../../../src/server/dal/errors";
import { forApiKey, forJobRunner } from "../../../src/server/dal/scope";
import { countInboxWaiting, getInboxItem, listEngagementAccounts, listInbox } from "../../../src/server/services/engagement/inbox";
import { ALL_PERMISSIONS, createKey } from "../../helpers/api";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

vi.mock("next/navigation", () => ({ usePathname: () => "/p/x" }));

import { LeftNav, NAV_SECTIONS } from "../../../src/components/shell/LeftNav";

afterAll(async () => {
  await closeDb();
});

describe("engagement permissions (FR-036, FR-037)", () => {
  it("the Inbox entry is absent from navigation without engagement view, and present with it", () => {
    expect(NAV_SECTIONS.some((s) => s.slug === "inbox")).toBe(true);
    const without = renderToStaticMarkup(<LeftNav projectSlug="x" canViewInbox={false} />);
    expect(without).not.toMatch(/\/p\/x\/inbox/);
    const withIt = renderToStaticMarkup(<LeftNav projectSlug="x" canViewInbox={true} inboxCount={3} />);
    expect(withIt).toMatch(/\/p\/x\/inbox/);
  });

  it("a scope with no engagement permission never has its inbox count computed, and sees 0", async () => {
    const env = await postsEnv();
    const ownerScope = await env.as(env.owner);
    const { secret } = await createKey(ownerScope, [ALL_PERMISSIONS[0]!]);
    const { scope: apiScope } = await forApiKey(secret);
    expect(apiScope.can({ engagement: ["view"] })).toBe(false);
    expect(await countInboxWaiting(apiScope)).toBe(0);

    const jobRunnerScope = await forJobRunner(env.project.id, null);
    expect(jobRunnerScope.can({ engagement: ["view"] })).toBe(false);
    expect(await countInboxWaiting(jobRunnerScope)).toBe(0);
  });

  it("a direct link's underlying read is refused with no count disclosed, for every scope lacking engagement permission", async () => {
    const env = await postsEnv();
    const ownerScope = await env.as(env.owner);
    for (const permission of ALL_PERMISSIONS) {
      const { secret } = await createKey(ownerScope, [permission]);
      const { scope: apiScope } = await forApiKey(secret);
      await expect(listInbox(apiScope)).rejects.toThrow(ForbiddenError);
      await expect(getInboxItem(apiScope, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(ForbiddenError);
      await expect(listEngagementAccounts(apiScope)).rejects.toThrow(ForbiddenError);
    }
    const jobRunnerScope = await forJobRunner(env.project.id, null);
    await expect(listInbox(jobRunnerScope)).rejects.toThrow(ForbiddenError);
    await expect(getInboxItem(jobRunnerScope, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(ForbiddenError);
    await expect(listEngagementAccounts(jobRunnerScope)).rejects.toThrow(ForbiddenError);
  });

  it("the public API account schema carries no engagement read permission, reason or docs path (FR-037)", () => {
    expect(Object.keys(AccountSchema.shape)).not.toContain("engagementReadPermission");
  });
});
