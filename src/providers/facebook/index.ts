import { metaConnectGroup } from "../meta/connect-group";
import type { SocialProvider } from "../types";
import { FACEBOOK_REELS_PER_DAY, facebookCapabilities } from "./capabilities";
import { advanceFacebook } from "./publish";
import { facebookSettingsSchema, type FacebookSettings, type FacebookState } from "./settings";
import { facebookStepFor } from "./steps";
import { validateFacebook } from "./validate";

export const facebookProvider: SocialProvider<FacebookSettings, FacebookState> = {
  key: "facebook",
  displayName: "Facebook",
  capabilities: facebookCapabilities,
  creationAllowance: { count: FACEBOOK_REELS_PER_DAY, windowSeconds: 86_400, name: "Facebook's daily Reels allowance" },
  connect: { strategy: "oauth", group: metaConnectGroup },
  settingsSchema: facebookSettingsSchema,
  validate: validateFacebook,
  stepFor: (state, _settings, content) => facebookStepFor(state, content),
  advance: (ctx) => advanceFacebook(ctx),
};
