import type { SocialProvider } from "../types";
import { X_DEFAULT_PUBLISH_LIMIT, xCapabilities } from "./capabilities";
import { xConnectGroup } from "./connect-group";
import { advanceX } from "./publish";
import { needsRefresh, refreshX } from "./refresh";
import { xAccountNotes, xSettingsSchema, type XSettings } from "./settings";
import type { XState } from "./state";
import { xStepFor } from "./steps";
import { validateX } from "./validate";

export const xProvider: SocialProvider<XSettings, XState> = {
  key: "x",
  displayName: "X",
  capabilities: xCapabilities,
  defaultPublishLimit: X_DEFAULT_PUBLISH_LIMIT,
  connect: { strategy: "oauth", group: xConnectGroup },
  settingsSchema: xSettingsSchema,
  needsRefresh,
  refreshCredentials: ({ credentials, now, signal }) => refreshX({ credentials, now, signal }),
  validate: validateX,
  stepFor: xStepFor,
  advance: advanceX,
  accountNotes: (input) => xAccountNotes(input),
};
