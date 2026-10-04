import { describe, expect, it } from "vitest";
import { redirectUriProblem } from "./connect";
import type { OAuthConnectGroup } from "./types";

const group = { redirectRequirement: { https: true, publicHost: true, reason: "Needs public HTTPS." } } as OAuthConnectGroup;

describe("redirectUriProblem", () => {
  it("allows anything when the group has no requirement", () => {
    expect(redirectUriProblem({} as OAuthConnectGroup, "http://localhost:3000/x")).toBeNull();
  });
  it.each([
    "https://localhost:3000/connect/callback",
    "https://foo.localhost/connect/callback",
    "https://127.0.0.1/connect/callback",
    "https://[::1]:3000/connect/callback",
    "https://192.168.1.10/connect/callback",
    "http://example.com/connect/callback",
    "http://docket.local:3000/connect/callback",
    "not a url",
  ])("refuses %s", (uri) => {
    expect(redirectUriProblem(group, uri)).toBe("Needs public HTTPS.");
  });
  it.each(["https://docket.local:3000/connect/callback", "https://example.com/connect/callback"])("accepts %s", (uri) => {
    expect(redirectUriProblem(group, uri)).toBeNull();
  });
  it("applies https and publicHost independently", () => {
    const httpsOnly = { redirectRequirement: { https: true, publicHost: false, reason: "r" } } as OAuthConnectGroup;
    expect(redirectUriProblem(httpsOnly, "https://localhost/x")).toBeNull();
    expect(redirectUriProblem(httpsOnly, "http://example.com/x")).toBe("r");
  });
});
