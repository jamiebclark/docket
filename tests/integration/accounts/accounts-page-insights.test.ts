import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);

import AccountsPage from "../../../src/app/p/[projectSlug]/accounts/page";
import { mockProvider } from "../../../src/providers/mock";
import type { OAuthConnectGroup, SocialProvider } from "../../../src/providers/types";
import * as accounts from "../../../src/server/services/accounts";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { closeDb } from "../../helpers/db";
import { throwawayGroup, sessionFor } from "../../helpers/connect-group";
import { registerTestProvider } from "../../helpers/provider-fixtures";
import { postsEnv } from "../../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});

const REQUIRED = ["needs_insight_scope"];
const MISSING_SCOPES = { reason: "Reconnect to grant insights access.", docsPath: "meta-setup" };

/** A group that always requests the required scope — so a hold short of it reads as `not_granted`. */
const askingGroup: OAuthConnectGroup = {
  ...throwawayGroup,
  key: "throwaway-asking",
  optionalScopes: { declared: REQUIRED.map((scope) => ({ scope, purpose: "test" })), requested: () => REQUIRED },
};

function providerWith(key: string, group: OAuthConnectGroup): SocialProvider {
  return {
    ...mockProvider,
    key,
    displayName: `${key} (test)`,
    connect: { strategy: "oauth", group },
    insights: {
      ...mockProvider.insights!,
      declaration: { ...mockProvider.insights!.declaration, requiredScopes: REQUIRED, missingScopes: MISSING_SCOPES },
    },
  } as SocialProvider;
}

const askedProvider = providerWith("insights-asked", askingGroup);
const notAskedProvider = providerWith("insights-not-asked", throwawayGroup);

registerTestProvider(askedProvider);
registerTestProvider(notAskedProvider);

async function connectWith(providerKey: string, grantedScopes: readonly string[] | undefined) {
  const env = await postsEnv();
  const repos = forSchedulerProject(env.project.id);
  const account = await repos.accounts.upsertConnected({
    providerKey,
    displayName: "Gate account",
    externalAccountId: `ext-${Math.random().toString(36).slice(2)}`,
    settings: {},
    credentialsEncrypted: null,
    credentialsExpiresAt: null,
    connectedByUserId: null,
    grantedScopes,
  });
  return { env, account };
}

async function renderedHtml(env: Awaited<ReturnType<typeof postsEnv>>) {
  const { sessionModule } = await import("../../helpers/actions");
  const session = await sessionFor(env.owner.id);
  const original = sessionModule.getSession;
  sessionModule.getSession = (async () => ({ user: { id: env.owner.id }, session: { id: session.sessionId } })) as never;
  try {
    return renderToStaticMarkup(await AccountsPage({ params: Promise.resolve({ projectSlug: env.project.slug }) }));
  } finally {
    sessionModule.getSession = original;
  }
}

describe("accounts page: the insights-need-a-reconnect line (FR-027, US1-AS4, US3-AS2)", () => {
  it("shown with a reconnect button for not_granted", async () => {
    const { env } = await connectWith("insights-asked", []);
    const html = await renderedHtml(env);
    expect(html).toContain("Insights need a reconnect");
    expect(html).toContain("Reconnect to grant insights access.");
  });

  it("not shown for not_requested", async () => {
    const { env } = await connectWith("insights-not-asked", []);
    const html = await renderedHtml(env);
    expect(html).not.toContain("Insights need a reconnect");
  });

  it("not shown for ok (every required scope held)", async () => {
    const { env } = await connectWith("insights-asked", REQUIRED);
    const html = await renderedHtml(env);
    expect(html).not.toContain("Insights need a reconnect");
  });

  it("an ineligible account's status stays active (FR-027)", async () => {
    const { env } = await connectWith("insights-not-asked", undefined);
    const [view] = await accounts.listAccounts(env.scope);
    expect(view!.status).toBe("active");
    expect(view!.insightsPermission?.kind).toBe("not_requested");
  });
});
