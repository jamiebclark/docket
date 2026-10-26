import type { SocialProvider, StepResult } from "../types";
import { BLUESKY_VIDEO_ALLOWANCE, blueskyCapabilities } from "./capabilities";
import { blueskyEngagement } from "./engagement";
import { blueskyInsights } from "./insights";
import { advance } from "./publish";
import { connectAccount, needsRefresh, refreshCredentials } from "./session";
import { BLUESKY_DEFAULT_PUBLISH_LIMITS, DEFAULT_PDS_URL, blueskySettingsSchema, type BlueskySettings, type BlueskyState } from "./settings";
import { stepForContent } from "./steps";
import { validateBluesky } from "./validate";

export const blueskyProvider: SocialProvider<BlueskySettings, BlueskyState> = {
  key: "bluesky",
  displayName: "Bluesky",
  capabilities: blueskyCapabilities,
  creationAllowance: BLUESKY_VIDEO_ALLOWANCE,
  connect: {
    strategy: "credentials",
    fields: [
      {
        name: "handle",
        label: "Handle",
        secret: false,
        placeholder: "you.bsky.social",
        help: "Your Bluesky handle, without the @.",
        // A Bluesky account's display name is its handle (connectAccount and refreshCredentials
        // both return `res.data.handle` as the display name), so a reconnect can fill this in.
        prefillOnReconnect: "displayName",
      },
      {
        name: "appPassword",
        label: "App password",
        secret: true,
        help: "Create an app password in your Bluesky account settings. Do not use your main password.",
      },
      {
        name: "pdsUrl",
        label: "Server (PDS) address",
        secret: false,
        optional: true,
        defaultValue: DEFAULT_PDS_URL,
        help: "Leave as https://bsky.social unless you host your own server.",
      },
    ],
  },
  defaultPublishLimit: BLUESKY_DEFAULT_PUBLISH_LIMITS,
  settingsSchema: blueskySettingsSchema,
  connectAccount,
  needsRefresh,
  refreshCredentials,
  // `reauthenticate()` in ./session opens a fresh session from the stored app password, so a
  // flagged account is worth retrying without a human. Accounts connected before the password
  // was stored have none; their retry is refused and they keep the manual-reconnect path.
  canReauthenticate: true,
  validate: validateBluesky,
  stepFor: (state, _settings, content) => stepForContent(state, content),
  advance: (ctx) => advance(ctx) as Promise<StepResult>,
  engagement: blueskyEngagement,
  insights: blueskyInsights,
};
