import { describe, expect, it } from "vitest";
import { explainTikTok } from "./errors";

describe("explainTikTok (contract §8)", () => {
  it.each([
    ["spam_risk_too_many_posts", "TikTok's daily posting limit has been reached for this account. (TikTok: spam_risk_too_many_posts)"],
    ["auth_removed", "Docket's access was removed in TikTok. Reconnect the account. (TikTok: auth_removed)"],
    ["photo_pull_failed", "TikTok could not fetch the photos from your media storage. (TikTok: photo_pull_failed)"],
    ["something_new", "TikTok refused the post. (TikTok: something_new)"],
  ])("%s", (code, text) => {
    expect(explainTikTok(code, null)).toBe(text);
  });

  it("points at the domain doc for url_ownership_unverified", () => {
    expect(explainTikTok("url_ownership_unverified", null)).toMatch(/Verify your media domain.*photo-posts-and-domain-verification/);
  });

  it("matches codes exactly", () => {
    expect(explainTikTok("INTERNAL", null)).toMatch(/^TikTok refused the post\./);
  });

  it("adds a scrubbed, cut message", () => {
    const out = explainTikTok("invalid_param", `bad\nvalue TOKEN-SECRET https://u.test/p?sig=1 ${"x".repeat(400)}`, ["TOKEN-SECRET", "https://u.test/p?sig=1"]);
    expect(out).not.toContain("TOKEN-SECRET");
    expect(out).not.toContain("sig=1");
    expect(out).not.toContain("\n");
    expect(out.length).toBeLessThan(400);
  });

  it("works without a code", () => {
    expect(explainTikTok(null, null)).toBe("TikTok refused the post.");
  });
});
