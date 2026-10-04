import { z } from "zod";
import { providers } from "../../src/providers/registry";
import type { CandidatesResult, ConnectCandidate, OAuthConnectGroup, SocialProvider } from "../../src/providers/types";
import { hashInvitationToken } from "../../src/server/crypto/tokens";
import { encryptCandidates } from "../../src/server/services/connect";
import type { ProjectScope } from "../../src/server/dal/scope";
import { createSession } from "./factories";

/** A two-provider OAuth group with no platform code, to prove the generic connect flow. */
export const throwawayGroup: OAuthConnectGroup = {
  key: "throwaway",
  displayName: "Throwaway Pages and Photos",
  environment: { variables: [], issues: () => [], configured: () => true },
  authorizationUrl: ({ state, redirectUri }) =>
    `https://login.example.test/dialog?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
  exchangeCode: async (): Promise<CandidatesResult> => ({ ok: true, candidates: [] }),
};

/** A group whose callback address must be public HTTPS (G10); unavailable under the test env's http://localhost. */
export const strictGroup: OAuthConnectGroup = {
  ...throwawayGroup,
  key: "throwaway-strict",
  displayName: "Throwaway Strict",
  callbackHint: "Check that the tester invite was accepted.",
  redirectRequirement: { https: true, publicHost: true, reason: "Strict needs an HTTPS address that is not localhost.", doc: "docs/strict.md#https" },
  pasteToken: {
    field: { name: "token", label: "Strict token", secret: true },
    help: "Paste a token.",
    exchange: async () => ({ ok: true, candidates: [] }),
  },
};

function throwawayProvider(key: string, displayName: string, group: OAuthConnectGroup = throwawayGroup): SocialProvider {
  return {
    key,
    displayName,
    capabilities: {
      text: { maxLength: 100, countingRule: "graphemes" },
      media: { maxImages: 0, allowedMimeTypes: [], maxBytesPerFile: 0, required: false },
      textOnlyAllowed: true,
      postTypes: ["text"],
    },
    connect: { strategy: "oauth", group },
    settingsSchema: z.object({}).passthrough(),
    validate: () => [],
    stepFor: () => ({ name: "publish", mayPublish: true }),
    advance: async () => ({ kind: "fatal_error", error: "not used" }),
  };
}

const added = [throwawayProvider("tw-page", "Throwaway Page"), throwawayProvider("tw-photo", "Throwaway Photo"), throwawayProvider("tw-strict", "Throwaway Strict", strictGroup)];

/** Registers the throwaway providers (idempotent). Call `unregisterThrowaway` in `afterAll`. */
export function registerThrowaway(): void {
  for (const p of added) if (!providers.some((x) => x.key === p.key)) (providers as SocialProvider[]).push(p);
}

export function unregisterThrowaway(): void {
  for (const p of added) {
    const i = providers.indexOf(p);
    if (i >= 0) (providers as SocialProvider[]).splice(i, 1);
  }
}

export function pageCandidate(id: string, name: string, withPhoto = true): ConnectCandidate[] {
  const page: ConnectCandidate = {
    providerKey: "tw-page",
    externalId: id,
    displayName: name,
    settings: {},
    credentials: { pageToken: `PAGE-TOKEN-${id}` },
    expiresAt: null,
    ...(withPhoto ? {} : { notes: ["No photo account is linked."] }),
  };
  if (!withPhoto) return [page];
  return [
    page,
    {
      providerKey: "tw-photo",
      externalId: `${id}9`,
      displayName: `${name} · Photos`,
      settings: { pageId: id },
      credentials: { pageToken: `PAGE-TOKEN-${id}` },
      expiresAt: null,
      parent: { providerKey: "tw-page", externalId: id },
    },
  ];
}

/** A session row for the scope's user, so connect attempts can bind to it. */
export async function sessionFor(userId: string): Promise<{ sessionId: string }> {
  return { sessionId: (await createSession(userId)).id };
}

/** Starts an attempt through the service and simulates the callback landing with these candidates. */
export async function readyAttempt(
  scope: ProjectScope,
  session: { sessionId: string },
  candidates: readonly ConnectCandidate[],
  groupKey = "throwaway",
): Promise<string> {
  const { startOAuthConnect } = await import("../../src/server/services/connect");
  const { url } = await startOAuthConnect(scope, { groupKey }, session);
  const state = new URL(url).searchParams.get("state")!;
  const { lookupByStateHash } = await import("../../src/server/dal/connect-attempts");
  const found = await lookupByStateHash(hashInvitationToken(state));
  if (!found) throw new Error("attempt not found");
  const now = new Date();
  const bind = { userId: scope.membership.userId, sessionId: session.sessionId, now };
  if (!(await scope.connectAttempts.consumeState(found.id, bind))) throw new Error("consume failed");
  const ciphertext = encryptCandidates(found.id, candidates);
  if (!ciphertext) throw new Error("too many candidates");
  await scope.connectAttempts.storeCandidates(found.id, ciphertext);
  return found.id;
}
