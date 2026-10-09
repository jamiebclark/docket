import type { SocialProvider } from "../types";
import { TIKTOK_DEFAULT_PUBLISH_LIMIT, tiktokCapabilities } from "./capabilities";
import { tiktokConnectGroup } from "./connect-group";
import { tiktokAccountDetails } from "./creator";
import { tiktokConsent, tiktokPosting } from "./posting";
import { advanceTikTok } from "./publish";
import { needsRefresh, refreshTikTok } from "./refresh";
import { tiktokStepFor } from "./steps";
import { validateTikTok } from "./validate";
import { tiktokAccountNotes, tiktokSettingsSchema, type TikTokSettings } from "./settings";

export const tiktokProvider: SocialProvider<TikTokSettings, unknown> = {
  key: "tiktok",
  displayName: "TikTok",
  capabilities: tiktokCapabilities,
  defaultPublishLimit: TIKTOK_DEFAULT_PUBLISH_LIMIT,
  connect: { strategy: "oauth", group: tiktokConnectGroup },
  settingsSchema: tiktokSettingsSchema,
  needsRefresh,
  refreshCredentials: ({ credentials, now, signal }) => refreshTikTok({ credentials, now, signal }),
  validate: (content, capabilities) => validateTikTok(content, capabilities),
  stepFor: tiktokStepFor,
  advance: advanceTikTok,
  accountNotes: (input) => tiktokAccountNotes(input),
  posting: tiktokPosting,
  accountDetails: tiktokAccountDetails,
  consent: tiktokConsent,
};
