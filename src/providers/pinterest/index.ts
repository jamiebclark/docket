import type { SocialProvider, StepInfo, StepResult } from "../types";
import { pinterestAccountDetails } from "./boards";
import { PINTEREST_DEFAULT_PUBLISH_LIMIT, pinterestCapabilities } from "./capabilities";
import { pinterestConnectGroup } from "./connect-group";
import { pinterestPosting } from "./posting";
import { refreshPinterest, needsRefresh } from "./refresh";
import { pinterestAccountNotes, pinterestSettingsSchema, type PinterestSettings } from "./settings";
import { validatePinterest } from "./validate";

/** Pinterest never uses step state: one request either publishes the pin or it doesn't (data-model §1). */
function stubStepFor(): StepInfo {
  return { name: "create_pin", mayPublish: true };
}

/** Replaced by `steps.ts` + `publish.ts` in Phase 5 (T053); this stub never calls the network. */
async function stubAdvance(): Promise<StepResult> {
  return { kind: "fatal_error", error: "Pinterest publishing is not implemented yet." };
}

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
  stepFor: stubStepFor,
  advance: stubAdvance,
  accountNotes: (input) => pinterestAccountNotes(input),
  posting: pinterestPosting,
  accountDetails: pinterestAccountDetails,
};
