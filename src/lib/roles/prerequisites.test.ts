import { describe, expect, it } from "vitest";
import type { GenerationReadiness } from "@/server/services/generation/readiness";
import type { Manager } from "./names";
import { generationPrerequisites, PREREQUISITES_TITLE } from "./prerequisites";

const managers: Manager[] = [
  { name: "Robin", role: "owner" },
  { name: "Sam", role: "admin" },
];
const none: GenerationReadiness = { ai: { configured: false, missingSettings: null }, accounts: 0, voiceProfiles: 0 };
const ownerReadiness: GenerationReadiness = { ...none, ai: { configured: false, missingSettings: ["LLM_PROVIDER", "LLM_MODEL"] } };
const owner = { isOwner: true, canManageAccounts: true, canManageVoice: true };
const admin = { isOwner: false, canManageAccounts: true, canManageVoice: true };
const editor = { isOwner: false, canManageAccounts: false, canManageVoice: false };
const run = (viewer: typeof owner, readiness = none, images?: { message: string } | null) =>
  generationPrerequisites({ slug: "p", readiness, viewer, managers, images }) ?? [];
const status = (items: ReturnType<typeof run>, key: string) => items.find((i) => i.key === key)?.status;

describe("generationPrerequisites", () => {
  it("has a title", () => expect(PREREQUISITES_TITLE).toBe("Before you can generate"));

  it("owner: everything To do, with names and one action each", () => {
    const items = run(owner, ownerReadiness);
    expect(items.map((i) => i.key)).toEqual(["ai", "account", "voice"]);
    expect(items.every((i) => i.status.kind === "todo" && i.action)).toBe(true);
    expect(items[0]?.description).toBe("Set LLM_PROVIDER, LLM_MODEL on the server, then reload this page.");
    expect(JSON.stringify(items)).not.toContain("Waiting on");
  });

  it("admin: waits on the owner for AI, acts on account and voice", () => {
    const items = run(admin);
    expect(status(items, "ai")).toEqual({ kind: "waiting", on: "Robin" });
    expect(items[0]?.action).toBeNull();
    expect(status(items, "account")).toEqual({ kind: "todo" });
    expect(status(items, "voice")).toEqual({ kind: "todo" });
  });

  it("editor: waits on the managers for all", () => {
    const items = run(editor);
    expect(status(items, "ai")).toEqual({ kind: "waiting", on: "Robin" });
    expect(status(items, "account")).toEqual({ kind: "waiting", on: "Robin and Sam" });
    expect(status(items, "voice")).toEqual({ kind: "waiting", on: "Robin and Sam" });
    expect(items.every((i) => !i.action)).toBe(true);
  });

  it("never shows a setting name to a non-owner", () => {
    for (const v of [admin, editor]) expect(JSON.stringify(run(v))).not.toMatch(/[A-Z][A-Z0-9]*_[A-Z0-9_]+/);
  });

  it("marks done items done and keeps the rest", () => {
    const items = run(owner, { ai: { configured: true, missingSettings: null }, accounts: 1, voiceProfiles: 0 });
    expect(status(items, "ai")).toEqual({ kind: "done" });
    expect(status(items, "voice")).toEqual({ kind: "todo" });
    expect(items.find((i) => i.key === "ai")?.action).toBeNull();
  });

  it("is null when everything is done", () => {
    expect(
      generationPrerequisites({
        slug: "p",
        readiness: { ai: { configured: true, missingSettings: null }, accounts: 1, voiceProfiles: 1 },
        viewer: owner,
        managers,
      }),
    ).toBeNull();
  });

  it("adds the images item, which keeps the list even when all else is done", () => {
    const items = run(owner, { ai: { configured: true, missingSettings: null }, accounts: 1, voiceProfiles: 1 }, { message: "No images to generate for." });
    expect(items.map((i) => i.key)).toEqual(["ai", "account", "voice", "images"]);
    expect(items[3]).toMatchObject({ description: "No images to generate for.", action: { label: "Back to Media", href: "/p/p/media" } });
  });
});
