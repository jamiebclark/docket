import type { SocialProvider } from "../types";
import { THREADS_DEFAULT_PUBLISH_LIMIT, threadsCapabilities } from "./capabilities";
import { threadsConnectGroup } from "./connect-group";
import { advanceThreads } from "./publish";
import { refreshThreads } from "./refresh";
import { threadsAccountNotes, threadsSettingsSchema, type ThreadsSettings } from "./settings";
import type { ThreadsState } from "./state";
import { threadsStepFor } from "./steps";
import { validateThreads } from "./validate";

export { threadsCapabilities } from "./capabilities";

export const threadsProvider: SocialProvider<ThreadsSettings, ThreadsState> = {
  key: "threads",
  displayName: "Threads",
  capabilities: threadsCapabilities,
  defaultPublishLimit: THREADS_DEFAULT_PUBLISH_LIMIT,
  connect: { strategy: "oauth", group: threadsConnectGroup },
  settingsSchema: threadsSettingsSchema,
  validate: validateThreads,
  stepFor: (state, _settings, content) => threadsStepFor(state, content),
  advance: (ctx) => advanceThreads(ctx),
  refreshCredentials: (input) => refreshThreads(input),
  accountNotes: (input) => threadsAccountNotes(input),
};
