import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => {}, refresh: () => {} }) }));
vi.mock("./actions", () => ({
  saveDraftAction: async () => ({ ok: false, error: "conflict", message: "n/a" }),
  previewQueueAction: async () => ({ ok: false, error: "conflict", message: "n/a" }),
  addToQueueAction: async () => ({ ok: false, error: "conflict", message: "n/a" }),
}));

import { UPLOAD_MIME_TYPES } from "@/lib/media/types";
import { findProvider } from "@/providers/registry";
import { requirementsOf } from "@/providers/requirements";
import { Composer, type AccountOption } from "./Composer";
import { fetchCheck, type CheckResult } from "./composer-logic";

const accounts: AccountOption[] = [
  { id: "a1", displayName: "Main", providerKey: "bluesky", providerName: "Bluesky", status: "active", providerAvailable: true },
  { id: "a2", displayName: "Old", providerKey: "bluesky", providerName: "Bluesky", status: "needs_reauth", providerAvailable: true },
];

const target = (over: Partial<CheckResult["targets"][number]> = {}): CheckResult["targets"][number] => ({
  accountId: "a1",
  displayName: "Main",
  providerName: "Bluesky",
  effectiveText: "hello",
  count: 5,
  limit: 300,
  countingRule: "graphemes",
  postType: "text",
  issues: [],
  canSchedule: true,
  requirements: requirementsOf(findProvider("bluesky")!.capabilities, { uploadTypes: UPLOAD_MIME_TYPES }),
  ...over,
});
const result = (targets: CheckResult["targets"], flags: Partial<CheckResult> = {}): CheckResult => ({
  targets,
  editable: true,
  reviewBlocked: false,
  ...flags,
});

/** The check comes through `fetchCheck` with a mocked `fetch`, exactly as the route would answer. */
async function checked(body: CheckResult): Promise<CheckResult> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: body }), { status: 200 }));
  const out = await fetchCheck("demo", { baseText: "hello", mediaIds: [], targets: [{ accountId: "a1" }] }, undefined, fetchMock as never);
  expect(fetchMock).toHaveBeenCalledWith(
    "/p/demo/compose/check",
    expect.objectContaining({ method: "POST", body: expect.stringContaining('"baseText":"hello"') }),
  );
  return out!;
}

function render(props: Partial<Parameters<typeof Composer>[0]> & { check?: CheckResult | null; selected?: string[] }) {
  const { check = null, selected = ["a1"], ...rest } = props;
  return renderToStaticMarkup(
    createElement(Composer, {
      slug: "demo",
      timeZone: "Europe/London",
      accounts,
      canManageAccounts: true,
      canEdit: true,
      canSchedule: true,
      mediaEnabled: true,
      initial: {
        postId: "p1",
        baseText: "hello",
        mediaIds: [],
        targets: selected.map((accountId) => ({ accountId, overrideText: null })),
        editable: true,
        reviewBlocked: false,
      },
      initialCheck: check,
      ...rest,
    }),
  );
}

describe("fetchCheck", () => {
  it("returns null for a non-OK answer or a network failure, so the last result stays", async () => {
    expect(await fetchCheck("demo", { baseText: "", mediaIds: [], targets: [] }, undefined, (async () => new Response("{}", { status: 404 })) as never)).toBeNull();
    expect(await fetchCheck("demo", { baseText: "", mediaIds: [], targets: [] }, undefined, (async () => { throw new Error("offline"); }) as never)).toBeNull();
  });
});

describe("Composer requirements summary", () => {
  const two: AccountOption[] = [...accounts, { id: "a3", displayName: "Third", providerKey: "bluesky", providerName: "Bluesky", status: "active", providerAvailable: true }];

  it("shows each selected account's summary with every field, open when one account is selected", async () => {
    const html = render({ check: await checked(result([target()])) });
    expect(html).toContain("300 graphemes · up to 4 images · JPEG, PNG");
    expect(html).toContain("What Bluesky accepts");
    expect(html).toContain("300 graphemes</dd>");
    for (const term of ["Text", "Images", "Formats", "Maximum file size", "Width", "Height", "Aspect ratio", "Alt text", "Image required", "Text-only posts"]) {
      expect(html).toContain(`<dt class="font-medium">${term}</dt>`);
    }
    expect(html).toContain("<details open");
  });

  it("starts closed with several accounts selected, and shows one summary per account", async () => {
    const html = render({
      accounts: two,
      selected: ["a1", "a3"],
      check: await checked(result([target(), target({ accountId: "a3", displayName: "Third" })])),
    });
    expect(html.match(/data-testid="requirements-summary"/g)).toHaveLength(2);
    expect(html).not.toContain("<details open");
  });

  it("shows no summary while checking or when requirements is null, and keeps the counter and issues", async () => {
    expect(render({ check: null })).not.toContain("requirements-summary");
    const html = render({
      check: await checked(
        result([target({ requirements: null, count: 301, issues: [{ severity: "error", code: "text_too_long", message: "Too long.", field: "text" }] })]),
      ),
    });
    expect(html).not.toContain("requirements-summary");
    expect(html).toContain("301 / 300");
    expect(html).toContain("Too long.");
  });

  it("drops the summary when the account is deselected (AS3)", async () => {
    const html = render({ accounts: two, selected: ["a3"], check: await checked(result([target()])) });
    expect(html).not.toContain("requirements-summary");
  });
});

describe("Composer", () => {
  it("shows used / limit from the check, without an error state under the limit", async () => {
    const html = render({ check: await checked(result([target()])) });
    expect(html).toContain("5 / 300");
    expect(html).not.toContain("over the limit");
  });

  it("shows adaptation notes and per-image alt indicators in the preview", async () => {
    const t = target({
      issues: [{ severity: "info", code: "media_will_convert", message: "Image 1 will be converted to JPEG.", field: "media" }],
    });
    const mv = (id: string, altText: string) =>
      ({ id, thumbnailUrl: "/t.png", publicUrl: "/o.png", mimeType: "image/png", width: 1, height: 1, byteSize: 1, altText, missingAlt: !altText, tags: [], inUse: false, originalFilename: null }) as never;
    const html = render({ check: await checked(result([t])), initialMedia: [mv("m1", "a cat"), mv("m2", "")] });
    expect(html).toContain("Image 1 will be converted to JPEG.");
    expect(html).toContain("Image 1: has alt text");
    expect(html).toContain("no alt text");
  });

  it("flips to the error state when count exceeds the limit, and disables scheduling with the reason", async () => {
    const over = target({
      count: 301,
      effectiveText: "x".repeat(301),
      canSchedule: false,
      issues: [{ severity: "error", code: "text_too_long", message: "Too long for Bluesky.", field: "text" }],
    });
    const html = render({ check: await checked(result([over])) });
    expect(html).toContain("301 / 300");
    expect(html).toContain("over the limit");
    expect(html).toContain("Errors");
    expect(html).toContain("Too long for Bluesky.");
    expect(html).toContain("Fix the errors above for at least one account.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-describedby="[^"]*-blocked"[^>]*>Add to queue…/);
  });

  it("disables scheduling when no account is chosen, when review is pending, and when publishing started", () => {
    expect(render({ selected: [] })).toContain("Choose at least one account.");
    expect(render({ check: result([target()], { reviewBlocked: true }) })).toContain("waiting for review before it can be scheduled");
    const started = render({ check: result([target()], { editable: false }) });
    expect(started).toContain("Publishing has started");
    expect(started).toMatch(/<button[^>]*type="submit"[^>]*disabled=""|<button[^>]*disabled=""[^>]*type="submit"/);
  });

  it("disables accounts that need reconnecting, with the reason shown", () => {
    const html = render({});
    expect(html).toContain("Needs reconnecting.");
    expect(html).toMatch(/type="checkbox"[^>]*disabled=""/);
  });

  it("allows scheduling when a target can be scheduled", async () => {
    const html = render({ check: await checked(result([target()])) });
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Add to queue…/);
  });

  it("shows the empty-accounts state per role", () => {
    const owner = render({ accounts: [], canManageAccounts: true });
    expect(owner).toContain('href="/p/demo/accounts"');
    const editor = render({ accounts: [], canManageAccounts: false });
    expect(editor).toContain("Ask an owner or admin");
    expect(editor).not.toContain('href="/p/demo/accounts"');
  });
});
