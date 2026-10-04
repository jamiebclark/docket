import type { PublishLimit, SocialProvider } from "./types";

/** Every default publish limit a provider declares, as a list (empty when it declares none). */
export function providerPublishLimits(provider: Pick<SocialProvider, "defaultPublishLimit"> | undefined): PublishLimit[] {
  const declared = provider?.defaultPublishLimit;
  if (!declared) return [];
  return Array.isArray(declared) ? [...(declared as readonly PublishLimit[])] : [declared as PublishLimit];
}
