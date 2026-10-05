import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccountPicker, ACCOUNT_FILTER_THRESHOLD, filterAccounts, type PickableAccount } from "./AccountPicker";

const account = (over: Partial<PickableAccount> & { id: string }): PickableAccount => ({
  displayName: `Account ${over.id}`,
  providerKey: "bluesky",
  providerName: "Bluesky",
  status: "active",
  ...over,
});

const render = (props: Partial<Parameters<typeof AccountPicker>[0]> & { accounts: PickableAccount[] }) =>
  renderToStaticMarkup(createElement(AccountPicker, { legend: "Accounts", value: [], onChange: () => {}, idPrefix: "p", ...props }));

describe("AccountPicker", () => {
  it("renders each account as a labelled checkbox card with its platform", () => {
    const html = render({ accounts: [account({ id: "a", displayName: "Main Bluesky" }), account({ id: "b", providerKey: "threads", providerName: "Threads" })], value: ["a"] });
    expect(html).toContain("<legend");
    expect(html).toMatch(/<label[^>]*for="p-acct-a"/);
    expect(html).toMatch(/<input[^>]*id="p-acct-a"[^>]*type="checkbox"|<input[^>]*type="checkbox"[^>]*id="p-acct-a"/);
    expect(html).toMatch(/<input(?=[^>]*id="p-acct-a")(?=[^>]*checked)[^>]*>/);
    expect(html).toContain("Main Bluesky");
    expect(html).toContain("Threads");
    expect(html).toContain("1 of 2 selected");
    expect(html).toContain("Select all");
  });

  it("disables an unavailable account and links its reason", () => {
    const html = render({ accounts: [account({ id: "x", status: "needs_reauth", unavailableReason: "Needs reconnecting." })] });
    expect(html).toMatch(/type="checkbox"[^>]*disabled=""/);
    expect(html).toMatch(/aria-describedby="p-acct-x-why"/);
    expect(html).toContain('id="p-acct-x-why"');
    expect(html).toContain("Needs reconnecting.");
  });

  it("shows status only for problems by default, and always when asked", () => {
    const ok = [account({ id: "a" })];
    expect(render({ accounts: ok })).not.toContain("Connected");
    expect(render({ accounts: ok, showStatus: "always" })).toContain("Connected");
  });

  it("offers a filter box only past the threshold", () => {
    const many = Array.from({ length: ACCOUNT_FILTER_THRESHOLD + 1 }, (_, i) => account({ id: String(i) }));
    expect(render({ accounts: many })).toContain('type="search"');
    expect(render({ accounts: many.slice(0, ACCOUNT_FILTER_THRESHOLD) })).not.toContain('type="search"');
  });

  it("filters by every typed word across account and platform names", () => {
    const list = [
      account({ id: "1", displayName: "Acme News", providerName: "Bluesky" }),
      account({ id: "2", displayName: "Acme Shop", providerName: "Instagram", providerKey: "instagram" }),
      account({ id: "3", displayName: "Other", providerName: "Instagram", providerKey: "instagram" }),
    ];
    expect(filterAccounts(list, "acme").map((a) => a.id)).toEqual(["1", "2"]);
    expect(filterAccounts(list, "acme insta").map((a) => a.id)).toEqual(["2"]);
    expect(filterAccounts(list, "").length).toBe(3);
  });
});
