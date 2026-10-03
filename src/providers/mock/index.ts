import { randomUUID } from "node:crypto";
import { validateAgainstCapabilities } from "../validation";
import type { PublishContext, SocialProvider, StepResult } from "../types";
import { mockSettingsSchema, type MockSettings, type MockState } from "./settings";

const SIXTY_DAYS_MS = 60 * 86_400_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function settingsOf(ctx: PublishContext): MockSettings {
  return mockSettingsSchema.parse(ctx.account.settings ?? {});
}

export const mockProvider: SocialProvider<MockSettings, MockState> = {
  key: "mock",
  displayName: "Mock (offline)",
  capabilities: {
    text: { maxLength: 500, countingRule: "graphemes" },
    media: {
      maxImages: 4,
      allowedMimeTypes: ["image/jpeg", "image/png"],
      maxBytesPerFile: 5_000_000,
      required: false,
    },
    textOnlyAllowed: true,
    postTypes: ["text", "image", "carousel"],
  },
  connect: { strategy: "credentials", fields: [] },
  settingsSchema: mockSettingsSchema,

  async refreshCredentials({ account, now }) {
    if (account.settings.refresh === "succeed") {
      return {
        ok: true,
        credentials: { token: `mock-${randomUUID()}` },
        expiresAt: new Date(now.getTime() + SIXTY_DAYS_MS),
      };
    }
    return { ok: false, reason: "Mock refresh failure" };
  },

  validate: (content, capabilities) => validateAgainstCapabilities(content, capabilities),

  stepFor: (state, settings) => stepForSettings(settings, state),

  async advance(ctx) {
    const s = settingsOf(ctx);
    if (s.delayMs > 0) await sleep(s.delayMs, ctx.signal);
    const state = (ctx.state as MockState | null) ?? null;
    const step = stepForSettings(s, state);
    const summary = {
      request: { step: step.name, attempt: ctx.target.attempt, textLength: ctx.content.text.length },
      response: { behaviour: s.behaviour },
    };
    const result = ((): StepResult => {
      switch (s.behaviour) {
        case "succeed":
          return done();
        case "multi_step": {
          const n = state?.done ?? 0;
          return n < s.steps ? { kind: "continue", state: { done: n + 1 } } : done();
        }
        case "retryable":
          return s.failTimes === undefined || ctx.target.attempt <= s.failTimes
            ? { kind: "retryable_error", error: "Mock transient failure" }
            : done();
        case "fatal":
          return { kind: "fatal_error", error: "Mock rejected the post" };
        case "ambiguous":
          return { kind: "ambiguous", error: "Mock could not confirm the post" };
        case "rate_limited":
          return {
            kind: "retryable_error",
            error: "Mock rate limited",
            notBefore: new Date(ctx.now.getTime() + s.retryAfterSeconds * 1000),
          };
        case "throw":
          throw new Error("mock provider threw");
      }
    })();
    return { ...result, summary };
  },
};

function done(): StepResult {
  const externalId = `mock-${randomUUID()}`;
  return { kind: "done", externalId, url: `https://mock.invalid/${externalId}` };
}

/** `stepFor` as the contract defines it, given the account's settings. */
export function stepForSettings(settings: MockSettings, state: MockState | null) {
  if (settings.behaviour !== "multi_step") return { name: "publish", mayPublish: true };
  const n = state?.done ?? 0;
  return n < settings.steps
    ? { name: "create_container", mayPublish: false }
    : { name: "publish", mayPublish: true };
}
