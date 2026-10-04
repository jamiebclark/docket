import type { OAuthConnectGroup } from "./types";

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Null when `redirectUri` meets the group's requirement; otherwise the reason to show. Pure. */
export function redirectUriProblem(group: OAuthConnectGroup, redirectUri: string): string | null {
  const req = group.redirectRequirement;
  if (!req) return null;
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return req.reason;
  }
  if (req.https && url.protocol !== "https:") return req.reason;
  if (req.publicHost) {
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || IPV4.test(host) || host.startsWith("[") || host.includes(":")) {
      return req.reason;
    }
  }
  return null;
}
