import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReauthBanner } from "./ReauthBanner";

const accounts = [
  { id: "a1", displayName: "Studio", providerName: "Bluesky" },
  { id: "a2", displayName: "Shop", providerName: "Mastodon" },
];
const html = (props: Parameters<typeof ReauthBanner>[0]) => renderToStaticMarkup(createElement(ReauthBanner, props));

describe("ReauthBanner", () => {
  it("renders nothing when no account needs reconnecting", () => {
    expect(html({ accounts: [], projectSlug: "p", canManage: true })).toBe("");
  });

  it("names the accounts and links owners and admins to them", () => {
    const out = html({ accounts, projectSlug: "p", canManage: true });
    expect(out).toContain('role="alert"');
    expect(out).toContain("2 accounts need reconnecting");
    expect(out).toContain("Studio (Bluesky)");
    expect(out).toContain('href="/p/p/accounts#account-a2"');
    expect(out).not.toContain("Ask an owner or admin");
  });

  it("tells editors to ask an owner or admin, with no link", () => {
    const out = html({ accounts: accounts.slice(0, 1), projectSlug: "p", canManage: false });
    expect(out).toContain("An account needs reconnecting");
    expect(out).toContain("Studio (Bluesky)");
    expect(out).toContain("Ask an owner or admin to reconnect it.");
    expect(out).not.toContain("href=");
  });
});
