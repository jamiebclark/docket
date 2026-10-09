import { isValidElement, type ReactElement } from "react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);

// Lets one case make the slot-count read fail; every other case reads the real service.
const slotRead = vi.hoisted(() => ({ fail: false }));
vi.mock("@/server/services/slots", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/services/slots")>();
  return {
    ...real,
    listSlotCounts: (...args: Parameters<typeof real.listSlotCounts>) =>
      slotRead.fail ? Promise.reject(new Error("slot read failed")) : real.listSlotCounts(...args),
  };
});

import ComposePage from "../../../src/app/p/[projectSlug]/compose/page";
import EditPostPage from "../../../src/app/p/[projectSlug]/compose/[postId]/page";
import * as posts from "../../../src/server/services/posts";
import * as slots from "../../../src/server/services/slots";
import { actAs } from "../../helpers/actions";
import { closeDb } from "../../helpers/db";
import { addMember, createUser } from "../../helpers/factories";
import { postsEnv } from "../../helpers/posts-env";

beforeEach(() => {
  slotRead.fail = false;
});
afterAll(async () => {
  await closeDb();
});

type ComposerProps = {
  accounts: { id: string; hasActiveSlot: boolean | null }[];
  canManageSlots: boolean;
  managersToAsk?: string;
};

type Env = Awaited<ReturnType<typeof postsEnv>>;

/** Renders the page without a DOM and reads the props it hands to `Composer`. */
async function composerProps(env: Env, page: "new" | "edit", userId: string): Promise<ComposerProps> {
  actAs({ id: userId });
  const slug = env.project.slug;
  let element: unknown;
  if (page === "new") {
    element = await ComposePage({ params: Promise.resolve({ projectSlug: slug }) });
  } else {
    const account = await env.account({}, false);
    const draft = await posts.createDraft(env.scope, { baseText: "Hello", targets: [{ accountId: account.id }] });
    element = await EditPostPage({ params: Promise.resolve({ projectSlug: slug, postId: draft.post.id }) } as never);
  }
  if (!isValidElement(element)) throw new Error("page did not return an element");
  return (element as ReactElement<ComposerProps>).props;
}

for (const page of ["new", "edit"] as const) {
  describe(`compose ${page} page: slot wiring`, () => {
    it("flags an account whose only slot is paused as having no active slot", async () => {
      const env = await postsEnv();
      const account = await env.account({}, false);
      const slot = await slots.addSlot(env.scope, { accountId: account.id, weekday: 1, localTime: "09:00" });
      await slots.setSlotPaused(env.scope, slot.id, true);
      const props = await composerProps(env, page, env.owner.id);
      expect(props.accounts.find((a) => a.id === account.id)?.hasActiveSlot).toBe(false);
    });

    it("flags an account with an active slot", async () => {
      const env = await postsEnv();
      const account = await env.account({}, true);
      const props = await composerProps(env, page, env.owner.id);
      expect(props.accounts.find((a) => a.id === account.id)?.hasActiveSlot).toBe(true);
    });

    it("passes null when the slot read fails, so Add to queue is never disabled by it", async () => {
      const env = await postsEnv();
      const account = await env.account({}, false);
      slotRead.fail = true;
      const props = await composerProps(env, page, env.owner.id);
      expect(props.accounts.find((a) => a.id === account.id)?.hasActiveSlot).toBeNull();
    });

    it("names the managers for an editor, and nothing for an owner", async () => {
      const env = await postsEnv();
      const editor = await createUser();
      await addMember(env.project.id, editor.id, "editor");
      const asEditor = await composerProps(env, page, editor.id);
      expect(asEditor.canManageSlots).toBe(false);
      expect(asEditor.managersToAsk).toBe(`${env.owner.name} or ${env.admin.name}`);
      const asOwner = await composerProps(env, page, env.owner.id);
      expect(asOwner.canManageSlots).toBe(true);
      expect(asOwner.managersToAsk).toBeUndefined();
    });
  });
}
