import { UnknownProviderError } from "./errors";
import { blueskyProvider } from "./bluesky";
import { facebookProvider } from "./facebook";
import { instagramProvider } from "./instagram";
import { mockProvider } from "./mock";
import { threadsProvider } from "./threads";
import { tiktokProvider } from "./tiktok";
import { xProvider } from "./x";
import type { OAuthConnectGroup, SocialProvider } from "./types";

// Adding a provider = one line here (plus its folder under src/providers/<key>/).
export const providers: readonly SocialProvider[] = [mockProvider as SocialProvider, blueskyProvider as SocialProvider, facebookProvider as SocialProvider, instagramProvider as SocialProvider, threadsProvider as SocialProvider, xProvider as SocialProvider, tiktokProvider as SocialProvider];

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
