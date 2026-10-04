import { metaConnectGroup } from "../meta/connect-group";
import type { SocialProvider } from "../types";
import { INSTAGRAM_DEFAULT_PUBLISH_LIMIT, instagramCapabilities } from "./capabilities";
import { advanceInstagram } from "./publish";
import { instagramSettingsSchema, type InstagramSettings } from "./settings";
import type { InstagramState } from "./state";
import { instagramStepFor } from "./steps";
import { validateInstagram } from "./validate";

export const instagramProvider: SocialProvider<InstagramSettings, InstagramState> = {
  key: "instagram",
  displayName: "Instagram",
  capabilities: instagramCapabilities,
  defaultPublishLimit: INSTAGRAM_DEFAULT_PUBLISH_LIMIT,
  connect: { strategy: "oauth", group: metaConnectGroup },
  settingsSchema: instagramSettingsSchema,
  validate: validateInstagram,
  stepFor: (state, _settings, content) => instagramStepFor(state, content),
  advance: (ctx) => advanceInstagram(ctx),
};
