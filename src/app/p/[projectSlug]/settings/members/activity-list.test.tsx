import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActivityList, type ActivityItem } from "./activity-list";
// eslint-disable-next-line no-restricted-imports -- test-only: enumerates every membershipAction value
import { membershipAction } from "@/server/db/schema/audit";

const item = (over: Partial<ActivityItem> = {}): ActivityItem => ({
  id: "1",
  action: "project_brand_update",
  actor: "Alex",
  subject: "tagline",
  createdAt: new Date("2026-10-12T14:02:00Z").toISOString(),
  ...over,
});

describe("ActivityList", () => {
  it("has a LABEL entry for every membershipAction enum member (never renders a raw enum value)", () => {
    for (const action of membershipAction.enumValues) {
      const html = renderToStaticMarkup(createElement(ActivityList, { items: [item({ action })], timeZone: "UTC" }));
      expect(html).not.toMatch(/[a-z]+_[a-z_]+/);
    }
  });

  it("renders a project_brand_update row as 'changed the brand tagline'", () => {
    const html = renderToStaticMarkup(createElement(ActivityList, { items: [item()], timeZone: "UTC" }));
    expect(html).toContain("Alex changed the brand tagline");
  });
});
