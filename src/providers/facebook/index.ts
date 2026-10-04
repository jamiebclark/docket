import { metaConnectGroup } from "../meta/connect-group";
import type { SocialProvider } from "../types";
import { facebookCapabilities } from "./capabilities";
import { advanceFacebook } from "./publish";
import { facebookSettingsSchema, type FacebookSettings, type FacebookState } from "./settings";
import { facebookStepFor } from "./steps";
import { validateFacebook } from "./validate";

export const facebookProvider: SocialProvider<FacebookSettings, FacebookState> = {
  key: "facebook",
  displayName: "Facebook",
  capabilities: facebookCapabilities,
  connect: { strategy: "oauth", group: metaConnectGroup },
  settingsSchema: facebookSettingsSchema,
  validate: validateFacebook,
  stepFor: (state, _settings, content) => facebookStepFor(state, content),
  advance: (ctx) => advanceFacebook(ctx),
};
