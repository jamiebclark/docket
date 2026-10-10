import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => ({
  ...(await import("../../helpers/actions")).navigationModule,
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/components/shell/SignedInHeader", () => ({ SignedInHeader: () => null }));

import NewProjectPage from "../../../src/app/p/new/page";

describe("/p/new copy", () => {
  it("names the next step and gives the time zone its own hint", async () => {
    const { actAs } = await import("../../helpers/actions");
    actAs({ id: "00000000-0000-4000-8000-000000000001", email: "a@example.com", name: "A" });
    const html = renderToStaticMarkup(await NewProjectPage());
    const lede = html.match(/<h1[^>]*>Create a project<\/h1><p[^>]*>([^<]*)<\/p>/)?.[1];
    expect(lede).toBe("Next you&#x27;ll connect a social account and choose when it posts.");
    const hint = "Posting times and the calendar use this zone.";
    expect(html).toContain(hint);
    const id = html.match(new RegExp(`id="([^"]+)"[^>]*>${hint}`))?.[1];
    expect(id).toBeTruthy();
    const combo = html.match(/<input[^>]*id="timezone"[^>]*>/)?.[0] ?? "";
    expect(combo).toContain("aria-describedby");
    expect(combo).toContain(id!);
  });
});
