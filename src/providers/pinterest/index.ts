import type { SocialProvider } from "../types";
import { pinterestAccountDetails } from "./boards";
import { PINTEREST_DEFAULT_PUBLISH_LIMIT, pinterestCapabilities } from "./capabilities";
import { pinterestConnectGroup } from "./connect-group";
import { pinterestInsights } from "./insights";
import { pinterestPosting } from "./posting";
import { advancePinterest } from "./publish";
import { refreshPinterest, needsRefresh } from "./refresh";
import { pinterestAccountNotes, pinterestSettingsSchema, type PinterestSettings } from "./settings";
import { pinterestStepFor } from "./steps";
import { validatePinterest } from "./validate";

export const pinterestProvider: SocialProvider<PinterestSettings, unknown> = {
  key: "pinterest",
  displayName: "Pinterest",
  capabilities: pinterestCapabilities,
  defaultPublishLimit: PINTEREST_DEFAULT_PUBLISH_LIMIT,
  connect: { strategy: "oauth", group: pinterestConnectGroup },
  settingsSchema: pinterestSettingsSchema,
  needsRefresh,
  refreshCredentials: ({ credentials, now, signal }) => refreshPinterest({ credentials, now, signal }),
  validate: (content, capabilities) => validatePinterest(content, capabilities),
  stepFor: (state) => pinterestStepFor(state),
  advance: advancePinterest,
  accountNotes: (input) => pinterestAccountNotes(input),
  posting: pinterestPosting,
  accountDetails: pinterestAccountDetails,
  insights: pinterestInsights,
};
