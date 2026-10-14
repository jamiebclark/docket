import type { SocialProvider, StepInfo, StepResult } from "../types";
import { validateAgainstCapabilities } from "../validation";
import { PINTEREST_DEFAULT_PUBLISH_LIMIT, pinterestCapabilities } from "./capabilities";
import { pinterestConnectGroup } from "./connect-group";
import { refreshPinterest, needsRefresh } from "./refresh";
import { pinterestAccountNotes, pinterestSettingsSchema, type PinterestSettings } from "./settings";

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
  validate: (content, capabilities) => validateAgainstCapabilities(content, capabilities),
  stepFor: stubStepFor,
  advance: stubAdvance,
  accountNotes: (input) => pinterestAccountNotes(input),
};
