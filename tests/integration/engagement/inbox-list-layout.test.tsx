import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { InboxList } from "../../../src/components/engagement/InboxList";
import type { InboxItemView } from "../../../src/server/services/engagement/inbox";

/**
 * The list/detail archetype, pinned (design-system.md §19).
 *
 * The inbox was a four-column `Table`: the column headed "Said" held a timestamp, the message was a
 * muted sub-line under the author, the account repeated on every row, and a `waiting` badge sat on
 * every row of a list where every row was waiting. Nothing was broken, so nothing failed — which is
 * why it shipped. These assertions are the parts a future change would otherwise quietly undo.
 */

const TZ = "America/New_York";
const NOW = new Date("2026-10-20T15:00:00Z");

function item(over: Partial<InboxItemView> = {}): InboxItemView {
  return {
    id: over.id ?? "11111111-1111-4111-8111-111111111111",
    providerKey: "instagram",
    socialAccount: { id: "acc-1", displayName: "Stencilvania · Instagram" },
    kind: "comment",
    state: "waiting",
    externalId: "ext-1",
    text: "Can you send it?",
    textTruncated: false,
    author: { displayName: null, handle: "american_fams_", externalId: "a1", url: null, identityStable: false, reachable: true },
    saidAt: new Date("2026-10-20T13:05:00Z"),
    parent: { kind: "docket_post", text: "Dark porch. Candle going in.", externalId: null },
    newerOnSameParent: 0,
    withdrawnAt: null,
    editedUpstreamAt: null,
    drafts: [],
    replyable: { ok: false, reason: "Instagram comments cannot be answered from Docket." },
    ...over,
  };
}

const render = (items: InboxItemView[]) =>
  renderToStaticMarkup(
    createElement(InboxList, { items, hrefForItem: (id: string) => `/p/x/inbox?item=${id}`, timeZone: TZ, now: NOW }),
  );

describe("the inbox list is an inbox, not a table", () => {
  it("renders no table", () => {
    const html = render([item()]);
    expect(html).not.toContain("<table");
  });

  it("leads with what they said, not with a timestamp column", () => {
    const html = render([item()]);
    // The message must appear before the author in the row, because it is the row.
    expect(html.indexOf("Can you send it?")).toBeLessThan(html.indexOf("american_fams_"));
  });

  it("says what the comment is about", () => {
    expect(render([item()])).toContain("Dark porch. Candle going in.");
  });

  it("caps the quoted post so it cannot out-weigh the message", () => {
    // Rendered unbounded on the live install, the quote ran the full row and became the longest
    // thing in it — the opposite of the weight order §19 sets out.
    const html = render([item({ parent: { kind: "docket_post", text: "x".repeat(400), externalId: null } })]);
    expect(html).toMatch(/max-w-\[\d+ch\][^"]*truncate|truncate[^"]*max-w-\[\d+ch\]/);
  });

  it("does not repeat the account on every row when there is only one", () => {
    const html = render([item({ id: "a" }), item({ id: "b" })]);
    expect(html.split("Stencilvania · Instagram").length - 1).toBe(0);
  });

  it("names the account once per row when more than one is in the list", () => {
    const other = item({ id: "b", socialAccount: { id: "acc-2", displayName: "Stencilvania" } });
    const html = render([item({ id: "a" }), other]);
    expect(html).toContain("Stencilvania · Instagram");
    expect(html).toContain(">· Stencilvania<");
  });

  it("badges the exception, never the resting state", () => {
    const html = render([item({ state: "waiting" })]);
    expect(html.toLowerCase()).not.toContain(">waiting<");

    const answered = render([item({ state: "answered" })]);
    expect(answered).toContain("Answered");
  });

  it("groups by day, in the project's zone", () => {
    const html = render([
      item({ id: "a", saidAt: new Date("2026-10-20T13:05:00Z") }),
      item({ id: "b", saidAt: new Date("2026-10-19T13:05:00Z") }),
    ]);
    expect(html).toContain("Today");
    expect(html).toContain("Yesterday");
  });

  it("marks the open item so the reader can see where they are", () => {
    const html = renderToStaticMarkup(
      createElement(InboxList, {
        items: [item({ id: "open-1" })],
        hrefForItem: (id: string) => `/p/x/inbox?item=${id}`,
        timeZone: TZ,
        now: NOW,
        selectedId: "open-1",
      }),
    );
    expect(html).toContain('aria-current="true"');
  });
});
