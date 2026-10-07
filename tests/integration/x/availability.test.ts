import { describe, expect, it } from "vitest";
import { docsUrl } from "../../../src/lib/docs";
import { redirectUriProblem } from "../../../src/providers/connect";
import { xConnectGroup } from "../../../src/providers/x/connect-group";

const env = xConnectGroup.environment;

describe("X availability", () => {
  it("is not configured, with no issue, when both variables are absent", () => {
    expect(env.configured({})).toBe(false);
    expect(env.issues({})).toEqual([]);
  });

  it("names the missing variable when only one is set", () => {
    expect(env.configured({ X_CLIENT_ID: "id" })).toBe(false);
    expect(env.issues({ X_CLIENT_ID: "id" }).map((i) => i.name)).toEqual(["X_CLIENT_SECRET"]);
    expect(env.issues({ X_CLIENT_SECRET: "secret" }).map((i) => i.name)).toEqual(["X_CLIENT_ID"]);
  });

  it("is configured with both variables", () => {
    expect(env.configured({ X_CLIENT_ID: "id", X_CLIENT_SECRET: "secret" })).toBe(true);
    expect(env.issues({ X_CLIENT_ID: "id", X_CLIENT_SECRET: "secret" })).toEqual([]);
  });

  it("is unavailable on http://localhost with the callback-address reason and link", () => {
    const problem = redirectUriProblem(xConnectGroup, "http://localhost:3000/connect/callback");
    expect(problem).toMatch(/HTTPS callback address on a public host/);
    expect(xConnectGroup.redirectRequirement?.doc).toBe(docsUrl("x-setup", "callback-address"));
    expect(xConnectGroup.redirectRequirement?.doc).toMatch(/x-setup\/?#callback-address/);
  });

  it("is available on a public https address", () => {
    expect(redirectUriProblem(xConnectGroup, "https://docket.example.com/connect/callback")).toBeNull();
  });
});
