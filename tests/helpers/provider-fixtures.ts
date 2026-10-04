import { providers } from "../../src/providers/registry";
import { mockProvider } from "../../src/providers/mock";
import type { SocialProvider } from "../../src/providers/types";

/** Test-only providers carrying the real platforms' media rules (docs/research/meta.md, bluesky.md). */
function withMedia(key: string, displayName: string, media: Partial<SocialProvider["capabilities"]["media"]>): SocialProvider {
  return {
    ...mockProvider,
    key,
    displayName,
    capabilities: {
      ...mockProvider.capabilities,
      media: { ...mockProvider.capabilities.media, ...media },
    },
  } as SocialProvider;
}

export const instagramLikeProvider = withMedia("instagram-like", "Instagram (test)", {
  allowedMimeTypes: ["image/jpeg"],
  outputMimeType: "image/jpeg",
  maxBytesPerFile: 8_000_000,
  minWidth: 320,
  maxWidth: 1440,
  minAspectRatio: 0.8,
  maxAspectRatio: 1.91,
  maxAltTextLength: 1000,
});

export const blueskyLikeProvider = withMedia("bluesky-like", "Bluesky (test)", {
  allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
  outputMimeType: "image/jpeg",
  maxBytesPerFile: 2_000_000,
});

/** Adds a test-only provider to the registry for the lifetime of the test file (each file has its own module graph). */
export function registerTestProvider(provider: SocialProvider): SocialProvider {
  (providers as SocialProvider[]).push(provider);
  return provider;
}
