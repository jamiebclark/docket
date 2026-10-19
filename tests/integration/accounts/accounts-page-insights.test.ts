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

/**
 * The shape that broke on a live install (G39): the surface needs a BASE scope — one the dialog
 * always carries, never an opt-in — and the account's grant was never recorded. Judging that on
 * the opt-ins alone called it "not requested" and showed no reconnect at all.
 */
const BASE_REQUIRED = ["base_scope_always_asked"];
const baseScopeGroup: OAuthConnectGroup = {
  ...throwawayGroup,
  key: "throwaway-base",
  baseScopes: BASE_REQUIRED,
  optionalScopes: { declared: [{ scope: "an_opt_in", purpose: "test" }], requested: () => [] },
};

function providerWith(key: string, group: OAuthConnectGroup): SocialProvider {
  return {
    ...mockProvider,
    key,
    displayName: `${key} (test)`,
    connect: { strategy: "oauth", group },
    insights: {
      ...mockProvider.insights!,
      declaration: { ...mockProvider.insights!.declaration, postScopes: REQUIRED, missingPostScopes: MISSING_SCOPES },
    },
  } as SocialProvider;
}

/** Missing both surfaces, so a single account can show two reconnect lines. */
function providerWithBothSurfaces(key: string, group: OAuthConnectGroup): SocialProvider {
  return {
    ...mockProvider,
    key,
    displayName: `${key} (test)`,
    connect: { strategy: "oauth", group },
    insights: {
      ...mockProvider.insights!,
      declaration: {
        ...mockProvider.insights!.declaration,
        postScopes: REQUIRED,
        missingPostScopes: MISSING_SCOPES,
        accountScopes: ["needs_account_insight_scope"],
        missingAccountScopes: { reason: "Reconnect to grant account insights access.", docsPath: "meta-setup" },
      },
    },
  } as SocialProvider;
}

const askingBothGroup: OAuthConnectGroup = {
  ...throwawayGroup,
  key: "throwaway-asking-both",
  optionalScopes: {
    declared: [...REQUIRED, "needs_account_insight_scope"].map((scope) => ({ scope, purpose: "test" })),
    requested: () => [...REQUIRED, "needs_account_insight_scope"],
  },
};

const askedProvider = providerWith("insights-asked", askingGroup);
const notAskedProvider = providerWith("insights-not-asked", throwawayGroup);
// Its surface needs a BASE scope, and the group declares that scope in `baseScopes`.
const baseScopeProvider = {
  ...providerWith("insights-base-scope", baseScopeGroup),
  insights: {
    ...mockProvider.insights!,
    declaration: { ...mockProvider.insights!.declaration, postScopes: BASE_REQUIRED, missingPostScopes: MISSING_SCOPES },
  },
} as SocialProvider;
const askedBothProvider = providerWithBothSurfaces("insights-asked-both", askingBothGroup);

registerTestProvider(askedProvider);
registerTestProvider(notAskedProvider);
registerTestProvider(baseScopeProvider);
registerTestProvider(askedBothProvider);

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

  // Regression (G39). On a live install every account connected before the grant was stored has
  // `granted_scopes` NULL, so even the base scopes the dialog always carries count as missing. The
  // service judged that on the opt-ins alone, called the surface "not requested", and the page
  // rendered no reconnect line — with the opt-in correctly switched on and nothing to click.
  it("shown when only a base scope is unaccounted for and the grant was never recorded", async () => {
    const { env } = await connectWith("insights-base-scope", undefined);
    const html = await renderedHtml(env);
    expect(html).toContain("Insights need a reconnect");
    const [view] = await accounts.listAccounts(env.scope);
    expect(view!.insightsPostPermission?.kind).toBe("not_granted");
  });

  it("an ineligible account's status stays active (FR-027)", async () => {
    const { env } = await connectWith("insights-not-asked", undefined);
    const [view] = await accounts.listAccounts(env.scope);
    expect(view!.status).toBe("active");
    expect(view!.insightsPostPermission?.kind).toBe("not_requested");
  });

  it("a pre-081 account (granted_scopes NULL, never asked): badge unchanged, no reconnect line, still publishes (US1-AS4)", async () => {
    const { env, account } = await connectWith("insights-not-asked", undefined);
    const html = await renderedHtml(env);
    expect(html).not.toContain("Insights need a reconnect");
    const [view] = await accounts.listAccounts(env.scope);
    expect(view!.status).toBe("active");
    expect(view!.notes).toEqual([]);
    expect(view!.publishLimit).toBeNull();
    expect(view!.insightsPostPermission?.kind).toBe("not_requested");
    expect(account.grantedScopes ?? null).toBeNull();
  });
});

describe("accounts page: one reconnect line per waiting surface (G37, FR-017)", () => {
  it("missing only the post scope: one line naming post", async () => {
    const { env } = await connectWith("insights-asked", []);
    const html = await renderedHtml(env);
    expect(html).toContain("Insights need a reconnect (post)");
    expect(html).not.toContain("Insights need a reconnect (account)");
  });

  it("missing only the account scope: one line naming account", async () => {
    const { env } = await connectWith("insights-asked-both", [...REQUIRED]);
    const html = await renderedHtml(env);
    expect(html).not.toContain("Insights need a reconnect (post)");
    expect(html).toContain("Insights need a reconnect (account)");
  });

  it("missing both: two lines, one per surface", async () => {
    const { env } = await connectWith("insights-asked-both", []);
    const html = await renderedHtml(env);
    expect(html).toContain("Insights need a reconnect (post)");
    expect(html).toContain("Insights need a reconnect (account)");
  });

  it("missing neither: no lines", async () => {
    const { env } = await connectWith("insights-asked-both", [...REQUIRED, "needs_account_insight_scope"]);
    const html = await renderedHtml(env);
    expect(html).not.toContain("Insights need a reconnect");
  });
});

describe("accounts page: Instagram's own Meta connect group, flag on (US3-AS2, US3-AS3)", () => {
  const ENV_KEYS = ["META_APP_ID", "META_APP_SECRET", "META_INSIGHTS_SCOPES", "META_LOGIN_CONFIG_ID"] as const;
  const ORIGINAL: Record<string, string | undefined> = {};
  function setEnv(patch: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
    for (const k of ENV_KEYS) ORIGINAL[k] = process.env[k];
    process.env.META_APP_ID = "12345";
    process.env.META_APP_SECRET = "a".repeat(32);
    for (const [k, v] of Object.entries(patch)) process.env[k] = v;
  }
  function restoreEnv() {
    for (const k of ENV_KEYS) {
      if (ORIGINAL[k] === undefined) delete process.env[k];
      else process.env[k] = ORIGINAL[k];
    }
  }

  it("flag on, not yet granted: the reconnect line, reason, docs link, reconnect button, unchanged status badge", async () => {
    setEnv({ META_INSIGHTS_SCOPES: "true" });
    try {
      // Already connected before this entry's flag existed: holds every baseline scope, but not
      // instagram_manage_insights — the real shape of "not yet granted" (US3-AS2).
      const { env } = await connectWith("instagram", [
        "pages_show_list",
        "pages_manage_posts",
        "pages_read_engagement",
        "instagram_basic",
        "instagram_content_publish",
      ]);
      const html = await renderedHtml(env);
      expect(html).toContain("Insights need a reconnect");
      expect(html).toContain("instagram_manage_insights");
      const [view] = await accounts.listAccounts(env.scope);
      expect(view!.status).toBe("active");
      expect(view!.insightsPostPermission?.kind).toBe("not_granted");
      expect(view!.insightsPostPermission?.kind === "not_granted" && view!.insightsPostPermission.canReconnect).toBe(true);
    } finally {
      restoreEnv();
    }
  });

  it("flag on, config id set: the Login-for-Business reason, no reconnect button (FR-019)", async () => {
    setEnv({ META_INSIGHTS_SCOPES: "true", META_LOGIN_CONFIG_ID: "777" });
    try {
      const { env } = await connectWith("instagram", [
        "pages_show_list",
        "pages_manage_posts",
        "pages_read_engagement",
        "instagram_basic",
        "instagram_content_publish",
      ]);
      const html = await renderedHtml(env);
      expect(html).toContain("Login for Business");
      expect(html).not.toContain("Reconnect ");
      const [view] = await accounts.listAccounts(env.scope);
      expect(view!.insightsPostPermission?.kind).toBe("not_granted");
      expect(view!.insightsPostPermission?.kind === "not_granted" && view!.insightsPostPermission.canReconnect).toBe(false);
    } finally {
      restoreEnv();
    }
  });
});
