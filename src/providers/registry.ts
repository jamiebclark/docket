import { UnknownProviderError } from "./errors";
import { blueskyProvider } from "./bluesky";
import { facebookProvider } from "./facebook";
import { instagramProvider } from "./instagram";
import { mockProvider } from "./mock";
import { threadsProvider } from "./threads";
import { xProvider } from "./x";
import type { OAuthConnectGroup, SocialProvider } from "./types";

// Adding a provider = one line here (plus its folder under src/providers/<key>/).
export const providers: readonly SocialProvider[] = [mockProvider as SocialProvider, blueskyProvider as SocialProvider, facebookProvider as SocialProvider, instagramProvider as SocialProvider, threadsProvider as SocialProvider, xProvider as SocialProvider];

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
