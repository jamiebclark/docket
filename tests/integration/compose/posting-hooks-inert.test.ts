import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PostingFieldsPanel } from "../../../src/components/compose/PostingFieldsPanel";
import { providers } from "../../../src/providers/registry";
import { tiktokPosting } from "../../../src/providers/tiktok/posting";
import type { PostingFieldView, PublishContext, SocialProvider } from "../../../src/providers/types";
import { runTick } from "../../../src/server/scheduler";
import * as posts from "../../../src/server/services/posts";
import * as accounts from "../../../src/server/services/accounts";
import { closeDb } from "../../helpers/db";
import { createProject } from "../../helpers/factories";
import { postsEnv } from "../../helpers/posts-env";
import { blueskyLikeProvider, registerTestProvider } from "../../helpers/provider-fixtures";
import { createDueTarget, createMockAccount } from "../../helpers/scheduling";
import { tickConfig } from "../../helpers/tick";

/** Finds every React element of a given host type (e.g. "select") in a tree of plain-function components, calling each composite along the way. */
function findHostElements(node: unknown, type: string, out: { props: Record<string, unknown> }[] = []): { props: Record<string, unknown> }[] {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) findHostElements(n, type, out);
    return out;
  }
  const el = node as { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };
  if (typeof el.type === "string") {
    if (el.type === type) out.push(el as never);
    if (el.props && "children" in el.props) findHostElements(el.props.children, type, out);
  } else if (typeof el.type === "function") {
    findHostElements((el.type as (p: unknown) => unknown)(el.props ?? {}), type, out);
  }
  return out;
}

const contexts: PublishContext[] = [];
const seenNow: unknown[] = [];

// A provider with no `posting`, `consent` or `accountDetails`, recording what the engine hands it.
registerTestProvider({
  ...blueskyLikeProvider,
  key: "inert-hooks",
  displayName: "Inert hooks",
  accountNotes: (input) => {
    seenNow.push(input.now);
    return [];
  },
  advance: async (ctx) => {
    contexts.push(ctx);
    return { kind: "done", externalId: "x" };
  },
} as SocialProvider);

beforeEach(async () => {
  contexts.length = 0;
  seenNow.length = 0;
});
afterAll(closeDb);

describe("G25–G28 hooks are inert for providers that do not use them", () => {
  it("declares none of the hooks on any registered provider except those that opt in", () => {
    for (const p of providers) {
      if (p.consent || p.accountDetails) expect(p.posting, p.key).toBeDefined();
    }
  });

  it("the composer check has null posting, null note and no summary notes", async () => {
    const env = await postsEnv();
    const account = await env.account();
    const check = await posts.checkComposition(env.scope, { baseText: "hello", targets: [{ accountId: account.id }] });
    const t = check.targets[0]!;
    expect(t.posting).toBeNull();
    expect(t.note).toBeNull();
    expect(t.requirements?.notes ?? []).toEqual([]);
    expect(t.issues.some((i) => i.field === "consent" || i.field.startsWith("posting"))).toBe(false);
  });

  it("saving posting values and consent for such a provider stores nothing", async () => {
    const env = await postsEnv();
    const account = await env.account();
    const draft = await posts.createDraft(env.scope, {
      baseText: "hello",
      targets: [{ accountId: account.id, posting: { v: 1, privacy: "SELF_ONLY" }, consent: { fingerprint: "v1:" + "a".repeat(64) } }],
    });
    const [target] = await env.scope.targets.listForPost(draft.post.id);
    expect(target!.postingFields).toBeNull();
    expect(target!.consentFingerprint).toBeNull();
    expect(target!.consentAt).toBeNull();
    const view = await posts.getPostView(env.scope, draft.post.id);
    expect(view.targets[0]!.note).toBeNull();
    const list = await posts.listPosts(env.scope);
    expect(list.items[0]!.targets[0]!.note).toBeNull();
  });

  it("the gate and the engine pass PostContent without `posting`", async () => {
    const project = await createProject();
    const account = await createMockAccount(project.id, {}, { providerKey: "inert-hooks" });
    await createDueTarget(project.id, account.id, { baseText: "plain" });
    const tick = await runTick(tickConfig({}));
    expect(tick.publishing.counts).toMatchObject({ claimed: 1, done: 1 });
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.content.posting).toBeUndefined();
  });

  it("accountNotes receives `now`, which providers may ignore", async () => {
    const env = await postsEnv();
    await accounts.saveConnectedAccount(env.scope, {
      providerKey: "inert-hooks",
      externalAccountId: "inert-1",
      displayName: "Inert",
      settings: {},
    });
    await accounts.listAccounts(env.scope);
    expect(seenNow.length).toBeGreaterThan(0);
    expect(seenNow.every((n) => n instanceof Date)).toBe(true);
  });
});

describe("G29: a choice field's labelKey (and its absence) in PostingFieldsPanel", () => {
  const calls: [string, unknown][] = [];
  const onChange = (key: string, value: unknown) => calls.push([key, value]);
  const options = [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }];

  function panel(field: PostingFieldView) {
    return createElement(PostingFieldsPanel, {
      idPrefix: "t",
      images: [],
      disabled: false,
      onChange,
      onAgree: () => {},
      onRetry: () => {},
      panel: { heading: null, notice: null, details: "ready", detailsError: null, fields: [field], afterPreview: null, consent: null },
    } as never);
  }

  beforeEach(() => {
    calls.length = 0;
  });

  it("a choice field without labelKey produces exactly one onChange per selection", () => {
    const field: PostingFieldView = { key: "board", label: "Board", kind: "choice", value: null, options, required: true, placeholder: "Choose…" };
    const [select] = findHostElements(panel(field), "select");
    (select!.props.onChange as (e: unknown) => void)({ target: { value: "a" } });
    expect(calls).toEqual([["board", "a"]]);
  });

  it("a choice field declaring labelKey stores the chosen option's label under it, and clearing stores \"\"", () => {
    const field: PostingFieldView = {
      key: "board", label: "Board", kind: "choice", value: null, options, required: true, placeholder: "Choose…", labelKey: "boardName",
    };
    const [select] = findHostElements(panel(field), "select");
    (select!.props.onChange as (e: unknown) => void)({ target: { value: "b" } });
    expect(calls).toEqual([["board", "b"], ["boardName", "Beta"]]);
    calls.length = 0;
    (select!.props.onChange as (e: unknown) => void)({ target: { value: "" } });
    expect(calls).toEqual([["board", null], ["boardName", ""]]);
  });

  it("TikTok's panel markup, counts and notice link text are byte-identical to before T002–T006", () => {
    const details = {
      username: "ada", nickname: "Ada", privacyOptions: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
      commentDisabled: false, duetDisabled: false, stitchDisabled: false,
    } as never;
    const values = {
      v: 1 as const, privacy: null, allowComments: false, allowDuets: false, allowStitches: false,
      disclosure: false, yourBrand: false, brandedContent: false, photoTitle: "hi",
    };
    const fields = tiktokPosting.view({ values, details, postType: "image" });
    const html = renderToStaticMarkup(
      createElement(PostingFieldsPanel, {
        idPrefix: "t",
        images: [],
        disabled: false,
        onChange: () => {},
        onAgree: () => {},
        onRetry: () => {},
        panel: { heading: null, notice: tiktokPosting.notice!(), details: "ready", detailsError: null, fields, afterPreview: null, consent: null },
      } as never),
    );
    expect(html).toContain(">Read how TikTok&#x27;s audit works<");
    expect(html).toContain("2 / 90");
    expect(html).toContain("Only me (private)");
  });
});
