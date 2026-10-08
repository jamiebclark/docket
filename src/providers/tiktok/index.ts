import type { SocialProvider } from "../types";
import { validateAgainstCapabilities } from "../validation";
import { TIKTOK_DEFAULT_PUBLISH_LIMIT, tiktokCapabilities } from "./capabilities";
import { tiktokConnectGroup } from "./connect-group";
import { needsRefresh, refreshTikTok } from "./refresh";
import { tiktokAccountNotes, tiktokSettingsSchema, type TikTokSettings } from "./settings";

const NOT_BUILT = "TikTok publishing is not available yet; nothing was posted.";

export const tiktokProvider: SocialProvider<TikTokSettings, unknown> = {
  key: "tiktok",
  displayName: "TikTok",
  capabilities: tiktokCapabilities,
  defaultPublishLimit: TIKTOK_DEFAULT_PUBLISH_LIMIT,
  connect: { strategy: "oauth", group: tiktokConnectGroup },
  settingsSchema: tiktokSettingsSchema,
  needsRefresh,
  refreshCredentials: ({ credentials, now, signal }) => refreshTikTok({ credentials, now, signal }),
  validate: (content, capabilities) => validateAgainstCapabilities(content, capabilities),
  // Stub until the publishing steps land (US2+): fails before any TikTok call.
  stepFor: () => ({ name: "check_creator", mayPublish: false }),
  advance: async () => ({ kind: "fatal_error", error: NOT_BUILT }),
  accountNotes: (input) => tiktokAccountNotes(input),
};
