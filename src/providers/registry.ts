import { UnknownProviderError } from "./errors";
import { mockProvider } from "./mock";
import type { SocialProvider } from "./types";

// Adding a provider = one line here (plus its folder under src/providers/<key>/).
export const providers: readonly SocialProvider[] = [mockProvider as SocialProvider];

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
