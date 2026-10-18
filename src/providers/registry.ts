import { GRANTED_SCOPE_PATTERN } from "../lib/granted-scopes";
import { UnknownProviderError } from "./errors";
import { blueskyProvider } from "./bluesky";
import { facebookProvider } from "./facebook";
import { instagramProvider } from "./instagram";
import { mockProvider } from "./mock";
import { pinterestProvider } from "./pinterest";
import { threadsProvider } from "./threads";
import { tiktokProvider } from "./tiktok";
import { xProvider } from "./x";
import type { MetricKeyDeclaration, OAuthConnectGroup, SocialProvider } from "./types";

// Adding a provider = one line here (plus its folder under src/providers/<key>/).
export const providers: readonly SocialProvider[] = [mockProvider as SocialProvider, blueskyProvider as SocialProvider, facebookProvider as SocialProvider, instagramProvider as SocialProvider, threadsProvider as SocialProvider, xProvider as SocialProvider, tiktokProvider as SocialProvider, pinterestProvider as SocialProvider];

/** Throws on a malformed `creationAllowance`, so a bad provider fails at registry load. */
export function assertCreationAllowance(provider: Pick<SocialProvider, "key" | "creationAllowance">): void {
  const a = provider.creationAllowance;
  if (a === undefined) return;
  const bad = (why: string) => {
    throw new Error(`Inconsistent creation allowance for ${provider.key}: ${why}.`);
  };
  if (!Number.isInteger(a.count) || a.count < 11) bad(`count (${a.count}) must be an integer of at least 11`);
  if (!Number.isInteger(a.windowSeconds) || a.windowSeconds <= 0 || a.windowSeconds > 604_800) {
    bad(`windowSeconds (${a.windowSeconds}) must be between 1 and 604800`);
  }
  if (a.name.trim() === "") bad("name must not be empty");
}
for (const p of providers) assertCreationAllowance(p);

function assertValidMetricKeys(providerKey: string, surface: "post" | "account", keys: readonly MetricKeyDeclaration[]): void {
  const bad = (why: string) => {
    throw new Error(`Inconsistent insights declaration for ${providerKey} (${surface}): ${why}.`);
  };
  const seen = new Set<string>();
  for (const k of keys) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,50}$/.test(k.key)) bad(`key "${k.key}" is malformed`);
    if (seen.has(k.key)) bad(`duplicate key "${k.key}"`);
    seen.add(k.key);
    const label = k.label.trim();
    if (label === "" || k.label.length > 40 || k.label !== label) bad(`label for "${k.key}" must be 1-40 trimmed characters`);
  }
}

/** Throws on a malformed `insights` declaration, so a bad provider fails at registry load (G30, D1-D6). */
export function assertInsightsDeclaration(provider: Pick<SocialProvider, "key" | "insights" | "capabilities">): void {
  const support = provider.insights;
  if (support === undefined) return;
  const d = support.declaration;
  const bad = (why: string) => {
    throw new Error(`Inconsistent insights declaration for ${provider.key}: ${why}.`);
  };
  if (d.post.length === 0 && d.account.length === 0 && !d.unavailable) {
    bad("post and account are both empty with no unavailable reason; omit insights instead");
  }
  assertValidMetricKeys(provider.key, "post", d.post);
  assertValidMetricKeys(provider.key, "account", d.account);
  if (!Number.isInteger(d.maxPostsPerRead) || d.maxPostsPerRead < 1 || d.maxPostsPerRead > 200) {
    bad(`maxPostsPerRead (${d.maxPostsPerRead}) must be an integer between 1 and 200`);
  }
  if (!Number.isInteger(d.readBudget.count) || d.readBudget.count < 1) bad(`readBudget.count (${d.readBudget.count}) must be an integer of at least 1`);
  // 2,592,000 s (30 days) is X's billing cycle (contracts/x-metered-reads.md §2); every other
  // provider's window is far shorter, so the bound only needs to admit that one case.
  if (!Number.isInteger(d.readBudget.windowSeconds) || d.readBudget.windowSeconds < 1 || d.readBudget.windowSeconds > 2_592_000) {
    bad(`readBudget.windowSeconds (${d.readBudget.windowSeconds}) must be between 1 and 2592000`);
  }
  if (d.unavailable) {
    const reason = d.unavailable.reason;
    if (reason.length < 1 || reason.length > 300) bad("unavailable.reason must be 1-300 characters");
  }
  if (d.unavailable && ((d.postScopes && d.postScopes.length > 0) || (d.accountScopes && d.accountScopes.length > 0))) {
    bad("unavailable and postScopes/accountScopes must never both be set");
  }
  for (const [surface, scopes, missing] of [
    ["postScopes", d.postScopes, d.missingPostScopes],
    ["accountScopes", d.accountScopes, d.missingAccountScopes],
  ] as const) {
    if (!scopes || scopes.length === 0) continue;
    const reason = missing?.reason;
    if (reason === undefined || reason.length < 1 || reason.length > 300) {
      bad(`${surface} is non-empty but ${surface === "postScopes" ? "missingPostScopes" : "missingAccountScopes"}.reason is missing or not 1-300 characters`);
    }
    for (const scope of scopes) {
      if (!GRANTED_SCOPE_PATTERN.test(scope)) bad(`${surface} entry "${scope}" does not match GRANTED_SCOPE_PATTERN`);
    }
  }
  if (d.postIdSource === "publicPostId") {
    const reason = d.missingPostId?.reason;
    if (reason === undefined || reason.length < 1 || reason.length > 300) {
      bad("postIdSource is publicPostId but missingPostId.reason is missing or not 1-300 characters");
    }
  }
  if (d.ephemeralPostTypes) {
    const seen = new Set<string>();
    for (const e of d.ephemeralPostTypes) {
      if (!provider.capabilities.postTypes.includes(e.postType)) {
        bad(`ephemeralPostTypes.postType "${e.postType}" is not one of this provider's own capabilities.postTypes`);
      }
      if (seen.has(e.postType)) bad(`ephemeralPostTypes.postType "${e.postType}" is duplicated`);
      seen.add(e.postType);
      if (!Number.isInteger(e.lifetimeMs) || e.lifetimeMs < 60_000 || e.lifetimeMs > 30 * 86_400_000) {
        bad(`ephemeralPostTypes.lifetimeMs (${e.lifetimeMs}) must be an integer between 60000 and ${30 * 86_400_000}`);
      }
    }
  }
  for (const [surface, schema] of [
    ["post", support.postMetricsSchema],
    ["account", support.accountMetricsSchema],
  ] as const) {
    const def = (schema as unknown as { def: { type: string; catchall?: { def: { type: string } }; shape?: Record<string, { def: { type: string; innerType?: { def: { type: string } } } }> } }).def;
    if (def.type !== "object" || def.catchall?.def.type !== "never") bad(`${surface}MetricsSchema must be a closed (strict) z.object`);
    for (const [key, field] of Object.entries(def.shape ?? {})) {
      if (field.def.type !== "optional" || field.def.innerType?.def.type !== "number") {
        bad(`${surface}MetricsSchema field "${key}" must be an optional number`);
      }
    }
  }
}
for (const p of providers) assertInsightsDeclaration(p);

export function findProvider(key: string): SocialProvider | undefined {
  return providers.find((p) => p.key === key);
}

export function getProvider(key: string): SocialProvider {
  const found = findProvider(key);
  if (!found) throw new UnknownProviderError(key);
  return found;
}

export function listProviders(): readonly SocialProvider[] {
  return providers;
}

export interface ConnectGroupEntry {
  group: OAuthConnectGroup;
  providers: readonly SocialProvider[];
}

export function listConnectGroups(): readonly ConnectGroupEntry[] {
  const byKey = new Map<string, { group: OAuthConnectGroup; providers: SocialProvider[] }>();
  for (const p of providers) {
    if (p.connect.strategy !== "oauth") continue;
    const entry = byKey.get(p.connect.group.key);
    if (entry) entry.providers.push(p);
    else byKey.set(p.connect.group.key, { group: p.connect.group, providers: [p] });
  }
  return [...byKey.values()];
}

export function findConnectGroup(key: string): ConnectGroupEntry | undefined {
  return listConnectGroups().find((e) => e.group.key === key);
}
