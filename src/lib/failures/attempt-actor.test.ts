import { describe, expect, it } from "vitest";
import { attemptActorLabel } from "./attempt-actor";

describe("attemptActorLabel", () => {
  it("names an API key", () => {
    expect(attemptActorLabel({ kind: "api_key", name: "Zapier" })).toBe("API key Zapier");
  });
  it("labels a key that can no longer be found", () => {
    expect(attemptActorLabel({ kind: "api_key", name: null })).toBe("Removed API key");
  });
  it("uses the member's name", () => {
    expect(attemptActorLabel({ kind: "member", name: "Ada" })).toBe("Ada");
  });
  it("labels the system", () => {
    expect(attemptActorLabel({ kind: "system" })).toBe("System");
  });
});
