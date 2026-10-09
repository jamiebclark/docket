import { describe, expect, it } from "vitest";
import {
  deriveAccounts,
  deriveChecklist,
  deriveComingUp,
  deriveNeedsAttention,
  deriveOverview,
  derivePostsByStatus, joinNames, names, serverSetupItems, type OverviewAccount, type OverviewFacts } from "./derive";

const account = (over: Partial<OverviewAccount> = {}): OverviewAccount => ({
  id: "a1",
  providerKey: "mastodon",
  providerName: "Mastodon",
  displayName: "@acme",
  status: "active",
  providerAvailable: true,
  credentialsExpireAt: null,
  slots: { active: 0, paused: 0 },
  ...over,
});

const facts = (over: Partial<OverviewFacts> = {}, role: "owner" | "admin" | "editor" = "owner"): OverviewFacts => {
  const manager = role !== "editor";
  return {
    project: { slug: "acme", name: "Acme", timezone: "Europe/London" },
    viewer: {
      role,
      can: {
        manageAccounts: manager,
        manageSlots: manager,
        manageVoice: manager,
        invite: manager,
        writePosts: true,
        editMedia: true,
      },
    },
    managers: [{ name: "Ana", role: "owner" }],
    memberCount: 2,
    pendingInvitations: null,
    accounts: [],
    postCounts: {},
    upcoming: [],
    reviewCount: 0,
    needsDecisionCount: 0,
    ai: { configured: true, voiceProfiles: null },
    storage: { configured: true, libraryItems: null },
    scheduler: "ok",
    unconfiguredPlatforms: null,
    now: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
};

const kinds = (f: OverviewFacts) => deriveChecklist(f)?.steps.filter((s) => !s.optional).map((s) => s.status.kind);

describe("deriveChecklist", () => {
  it("shows the three required steps in order for an empty project, 2 and 3 blocked", () => {
    const v = deriveChecklist(facts());
    expect(v?.mode).toBe("full");
    expect(v?.steps.map((s) => s.key)).toEqual(["account", "slots", "first_post", "invite"]);
    expect(v?.steps.map((s) => s.status.kind)).toEqual(["todo", "todo", "todo", "done"]);
    expect(v?.steps[0]?.action?.href).toBe("/p/acme/accounts#add-account");
    expect(v?.steps[1]?.blocked).toBe("Needs an account first");
    expect(v?.steps[2]?.blocked).toBe("Needs an account first");
    expect(v?.steps[1]?.action).toBeNull();
  });
  it("moves each step to done and back (SC-005)", () => {
    const withAccount = facts({ accounts: [account()] });
    expect(kinds(withAccount)).toEqual(["done", "todo", "todo"]);
    expect(deriveChecklist(withAccount)?.steps[1]?.action?.href).toBe("/p/acme/accounts#account-a1-slots");
    const withSlot = facts({ accounts: [account({ slots: { active: 1, paused: 0 } })] });
    expect(kinds(withSlot)).toEqual(["done", "done", "todo"]);
    const all = facts({ accounts: [account({ slots: { active: 1, paused: 0 } })], postCounts: { scheduled: 1 } });
    expect(deriveChecklist(all)).toBeNull();
    // slots paused
    expect(kinds({ ...all, accounts: [account({ slots: { active: 0, paused: 1 } })] })).toEqual(["done", "todo", "done"]);
    // scheduled post cancelled
    expect(kinds({ ...all, postCounts: { scheduled: 0, draft: 2 } })).toEqual(["done", "done", "todo"]);
    // account removed
    expect(deriveChecklist({ ...all, accounts: [] })?.mode).toBe("full");
  });
  it("counts publishing, published and partially failed as a first post", () => {
    for (const k of ["publishing", "published", "partially_failed"] as const) {
      expect(kinds(facts({ accounts: [account()], postCounts: { [k]: 1 } }))?.[2]).toBe("done");
    }
    expect(kinds(facts({ accounts: [account()], postCounts: { failed: 1, draft: 3 } }))?.[2]).toBe("todo");
  });
  it("does not count an unavailable provider's slots", () => {
    const f = facts({ accounts: [account({ providerAvailable: false, slots: { active: 1, paused: 0 } })] });
    expect(kinds(f)?.[1]).toBe("todo");
  });
  it("makes editors wait on the managers for steps 1 and 2 but write posts themselves", () => {
    const f = facts({ accounts: [], managers: [{ name: "Ana", role: "owner" }, { name: "Sam", role: "admin" }] }, "editor");
    const v = deriveChecklist(f);
    expect(v?.steps[0]?.status).toEqual({ kind: "waiting", on: "Ana and Sam" });
    expect(v?.steps[0]?.action).toBeNull();
    expect(v?.steps[1]?.status).toEqual({ kind: "waiting", on: "Ana and Sam" });
    expect(v?.steps[2]?.status.kind).toBe("todo");
    expect(v?.steps[2]?.blocked).toBe("Needs an account first");
  });
});

describe("editor variants (US2)", () => {
  const robinSam = [
    { name: "Robin", role: "owner" as const },
    { name: "Sam", role: "admin" as const },
  ];
  it("says 'Waiting on Robin and Sam' with no action for steps 1 and 2", () => {
    const v = deriveChecklist(facts({ managers: robinSam }, "editor"));
    expect(v?.steps.slice(0, 2).map((s) => s.status)).toEqual([
      { kind: "waiting", on: "Robin and Sam" },
      { kind: "waiting", on: "Robin and Sam" },
    ]);
    expect(v?.steps.slice(0, 2).every((s) => s.action === null)).toBe(true);
    expect(v?.steps.some((s) => s.key === "invite")).toBe(false);
  });
  it("keeps the first-post step actionable once an account exists", () => {
    const v = deriveChecklist(facts({ managers: robinSam, accounts: [account()] }, "editor"));
    expect(v?.steps[2]?.action?.href).toBe("/p/acme/compose");
  });
  it("differs from admin and owner, who get actions", () => {
    for (const role of ["owner", "admin"] as const) {
      const v = deriveChecklist(facts({ managers: robinSam }, role));
      expect(v?.steps[0]?.status.kind).toBe("todo");
      expect(v?.steps[0]?.action).not.toBeNull();
    }
  });
  it("falls back when there are no managers", () => {
    const v = deriveChecklist(facts({ managers: [] }, "editor"));
    expect(v?.steps[0]?.status).toEqual({ kind: "waiting", on: "an owner or admin" });
  });
  it("names helper joins with and / or", () => {
    expect(names({ managers: robinSam }, "and")).toBe("Robin and Sam");
    expect(names({ managers: robinSam }, "or")).toBe("Robin or Sam");
  });
});

describe("deriveOverview", () => {
  it("titles with the project name and describes the timezone and role", () => {
    expect(deriveOverview(facts()).title).toBe("Acme");
    expect(deriveOverview(facts()).description).toBe("Times in Europe/London. You're an Owner.");
    expect(deriveOverview(facts({}, "admin")).description).toContain("You're an Admin.");
    expect(deriveOverview(facts({}, "editor")).description).toContain("You're an Editor.");
  });
  it("offers Connect an account with none, otherwise Write a post", () => {
    expect(deriveOverview(facts()).primaryAction).toEqual({
      label: "Connect an account",
      href: "/p/acme/accounts#add-account",
    });
    expect(deriveOverview(facts({ accounts: [account()] })).primaryAction).toEqual({
      label: "Write a post",
      href: "/p/acme/compose",
    });
    expect(deriveOverview(facts({}, "editor")).primaryAction?.label).toBe("Write a post");
  });
  it("offers no action to a viewer who can't write", () => {
    const f = facts({}, "editor");
    f.viewer.can.writePosts = false;
    expect(deriveOverview(f).primaryAction).toBeNull();
  });
});

describe("joinNames", () => {
  it("falls back when there are no names", () => {
    expect(joinNames([], "and")).toBe("an owner or admin");
    expect(joinNames(["", "  "], "or")).toBe("an owner or admin");
  });
  it("names one, two and three people", () => {
    expect(joinNames(["Ana"], "and")).toBe("Ana");
    expect(joinNames(["Ana", "Sam"], "and")).toBe("Ana and Sam");
    expect(joinNames(["Ana", "Sam"], "or")).toBe("Ana or Sam");
    expect(joinNames(["Ana", "Sam", "Robin"], "or")).toBe("Ana, Sam or Robin");
  });
  it("summarises four or more", () => {
    expect(joinNames(["A", "B", "C", "D"], "and")).toBe("A, B, C and 1 other");
    expect(joinNames(["A", "B", "C", "D", "E"], "or")).toBe("A, B, C or 2 others");
  });
  it("drops blank names before counting", () => {
    expect(joinNames(["Ana", " ", "Sam"], "and")).toBe("Ana and Sam");
  });
});

describe("deriveNeedsAttention", () => {
  const day = 86_400_000;
  const now = new Date("2026-01-01T00:00:00Z");
  const exp = (days: number) => new Date(now.getTime() + days * day);

  it("is null when nothing needs attention", () => {
    expect(deriveNeedsAttention(facts({ accounts: [account()] }))).toBeNull();
  });

  it("lists review, decision and failed (failed + partially_failed, D4) with formatted counts", () => {
    const v = deriveNeedsAttention(facts({ reviewCount: 1204, needsDecisionCount: 2, postCounts: { failed: 1, partially_failed: 2 } }));
    expect(v?.map((i) => [i.kind, i.label, i.badge.text, i.href])).toEqual([
      ["review", "Awaiting review", "1,204", "/p/acme/review"],
      ["decision", "Needs your decision", "2", "/p/acme/failures"],
      ["failed", "Failed", "3", "/p/acme/failures"],
    ]);
    expect(v?.[2]?.badge.tone).toBe("danger");
  });

  it("lists reconnect with a link for managers and a hint for editors", () => {
    const a = account({ status: "needs_reauth" });
    const owner = deriveNeedsAttention(facts({ accounts: [a] }));
    expect(owner?.[0]).toMatchObject({ kind: "reconnect", label: "@acme (Mastodon) needs reconnecting", href: "/p/acme/accounts#account-a1", hint: null });
    const editor = deriveNeedsAttention(facts({ accounts: [a], managers: [{ name: "Ana", role: "owner" }, { name: "Sam", role: "admin" }] }, "editor"));
    expect(editor?.[0]).toMatchObject({ href: null, hint: "Ask Ana or Sam to reconnect it." });
  });

  it("flags expiry within 14 days inclusive, expired, and skips null and later", () => {
    const at = (d: number | null) => facts({ accounts: [account({ credentialsExpireAt: d === null ? null : exp(d) })] });
    expect(deriveNeedsAttention(at(14))?.[0]).toMatchObject({ kind: "expiry", badge: { text: "Expires soon", tone: "warning" } });
    expect(deriveNeedsAttention(at(14.01))).toBeNull();
    expect(deriveNeedsAttention(at(null))).toBeNull();
    const past = deriveNeedsAttention(at(-1));
    expect(past?.[0]).toMatchObject({ badge: { text: "Expired", tone: "danger" } });
    expect(past?.[0]?.label).toContain("credentials expired");
    expect(past?.[0]?.at).toEqual(exp(-1));
  });

  it("lists an account once when it needs reconnecting and has expired credentials (D5)", () => {
    const v = deriveNeedsAttention(facts({ accounts: [account({ status: "needs_reauth", credentialsExpireAt: exp(-3) })] }));
    expect(v?.map((i) => i.kind)).toEqual(["reconnect"]);
  });
});

describe("deriveComingUp", () => {
  const post = (id: string, d: number) => ({ id, excerpt: id, scheduledAt: new Date(Date.UTC(2026, 0, d)), accountNames: ["@acme"] });

  it("shows the 5 soonest of 7", () => {
    const v = deriveComingUp(facts({ upcoming: [7, 3, 5, 1, 6, 2, 4].map((d) => post(`p${d}`, d)) }));
    expect(v.kind === "list" && v.items.map((i) => i.id)).toEqual(["p1", "p2", "p3", "p4", "p5"]);
  });

  it("has an empty state per account and role", () => {
    expect(deriveComingUp(facts({ accounts: [account()] }))).toEqual({
      kind: "empty",
      message: "No scheduled posts yet. Write one and schedule it.",
      action: { label: "Write a post", href: "/p/acme/compose" },
    });
    expect(deriveComingUp(facts())).toMatchObject({ message: "No scheduled posts yet. Connect an account first.", action: { label: "Connect an account" } });
    expect(deriveComingUp(facts({}, "editor"))).toEqual({
      kind: "empty",
      message: "No scheduled posts yet. Connect an account first. Ask Ana to connect one.",
      action: null,
    });
  });
});

describe("deriveAccounts", () => {
  it("has role-specific empty states", () => {
    expect(deriveAccounts(facts())).toEqual({ kind: "empty", message: "You don't have any accounts yet.", action: { label: "Add an account", href: "/p/acme/accounts#add-account" } });
    expect(deriveAccounts(facts({}, "editor"))).toEqual({ kind: "empty", message: "No accounts yet. Ask Ana to connect one.", action: null });
  });

  it("builds badge, slots text and expiry per row", () => {
    const rows = (a: OverviewAccount[], role: "owner" | "editor" = "owner") => {
      const v = deriveAccounts(facts({ accounts: a }, role));
      return v.kind === "list" ? v.rows : [];
    };
    const [unavailable, reauth, active, paused, none] = rows([
      account({ id: "u", providerAvailable: false }),
      account({ id: "r", status: "needs_reauth" }),
      account({ id: "a", slots: { active: 3, paused: 1 }, credentialsExpireAt: new Date("2025-12-31T00:00:00Z") }),
      account({ id: "p", slots: { active: 0, paused: 2 } }),
      account({ id: "n" }),
    ]);
    expect(unavailable?.badge).toEqual({ tone: "neutral", text: "Unavailable" });
    expect(reauth?.badge).toEqual({ tone: "danger", text: "Needs reconnecting" });
    expect(active?.badge).toEqual({ tone: "success", text: "Connected" });
    expect(active?.slotsText).toBe("3 posting slots a week");
    expect(active?.slotsHref).toBe("/p/acme/accounts#account-a-slots");
    expect(active?.expiry?.expired).toBe(true);
    expect(paused?.slotsText).toBe("All posting slots paused");
    expect(none?.slotsText).toBe("No posting slots — add some");
    expect(rows([account()], "editor")[0]).toMatchObject({ slotsText: "No posting slots", slotsHref: null });
    expect(rows([account({ slots: { active: 1, paused: 0 } })])[0]?.slotsText).toBe("1 posting slot a week");
  });
});

describe("derivePostsByStatus", () => {
  it("is empty with a Write a post action when there are no posts", () => {
    expect(derivePostsByStatus(facts())).toEqual({ kind: "empty", action: { label: "Write a post", href: "/p/acme/compose" } });
    expect(derivePostsByStatus(facts({ postCounts: { draft: 0 } })).kind).toBe("empty");
  });

  it("counts the four statuses with links", () => {
    const v = derivePostsByStatus(facts({ postCounts: { draft: 2, needs_review: 1, scheduled: 1204, published: 9 } }));
    expect(v).toEqual({
      kind: "counts",
      items: [
        { label: "Drafts", count: 2, href: "/p/acme/posts?status=draft" },
        { label: "Needs review", count: 1, href: "/p/acme/posts?status=needs_review" },
        { label: "Approved but not scheduled", count: 0, href: "/p/acme/posts?status=approved" },
        { label: "Scheduled", count: 1204, href: "/p/acme/posts?status=scheduled" },
      ],
    });
  });
});

describe("serverSetupItems (US4)", () => {
  const platform = { key: "meta", displayName: "Meta", setupDoc: "https://example.test/meta-setup/" };

  it("lists each of the four missing pieces in order, each with a docs link", () => {
    const items = serverSetupItems(
      facts({ scheduler: "stale", ai: { configured: false, voiceProfiles: null }, storage: { configured: false, libraryItems: null }, unconfiguredPlatforms: [platform] }),
    );
    expect(items.map((i) => i.key)).toEqual(["scheduler", "ai", "storage", "platform:meta"]);
    expect(items.map((i) => i.label)).toEqual([
      "The scheduler isn't running",
      "AI generation isn't set up",
      "Media storage isn't set up",
      "Meta isn't set up",
    ]);
    expect(items[0]?.href).toContain("deployment/#9-is-the-scheduler-running");
    expect(items[1]?.href).toContain("generator/#configuring-a-provider");
    expect(items[2]?.href).toContain("storage/");
    expect(items[3]?.href).toBe(platform.setupDoc);
  });

  it("treats a scheduler that never ran like a stale one", () => {
    expect(serverSetupItems(facts({ scheduler: "never" })).map((i) => i.key)).toEqual(["scheduler"]);
  });

  it("falls back to the accounts guide when a platform has no setup doc", () => {
    const [item] = serverSetupItems(facts({ unconfiguredPlatforms: [{ ...platform, setupDoc: null }] }));
    expect(item?.href).toContain("accounts/");
  });

  it("is empty for admins and editors, whatever is missing", () => {
    const missing = { scheduler: "never" as const, ai: { configured: false, voiceProfiles: null }, unconfiguredPlatforms: [platform] };
    expect(serverSetupItems(facts(missing, "admin"))).toEqual([]);
    expect(serverSetupItems(facts(missing, "editor"))).toEqual([]);
    expect(deriveChecklist(facts(missing, "admin"))?.serverSetup).toBeNull();
  });

  it("hides the row when nothing is missing", () => {
    expect(serverSetupItems(facts())).toEqual([]);
    expect(deriveChecklist(facts())?.serverSetup).toBeNull();
  });

  it("attaches the row to the checklist without blocking collapse", () => {
    const done = { accounts: [account({ slots: { active: 1, paused: 0 } })], postCounts: { scheduled: 1 } };
    expect(deriveChecklist(facts(done))).toBeNull();
    const v = deriveChecklist(facts({ ...done, scheduler: "stale" }));
    expect(v?.mode).toBe("collapsed");
    expect(v?.steps).toEqual([]);
    expect(v?.serverSetup?.map((i) => i.key)).toEqual(["scheduler"]);
    expect(deriveChecklist(facts({ scheduler: "stale" }))?.serverSetup?.map((i) => i.key)).toEqual(["scheduler"]);
  });
});

describe("optional steps and content tools (US5)", () => {
  const done = { postCounts: { published: 1 }, accounts: [account({ slots: { active: 1, paused: 0 } })] };

  it("hides optional steps and tools for unconfigured features", () => {
    expect(deriveOverview(facts()).contentTools).toBeNull();
    expect(deriveChecklist(facts({ ...done, memberCount: 1 }))?.steps.map((s) => s.key)).toEqual(["invite"]);
  });

  it("describes voice and media status", () => {
    const f = facts({ ai: { configured: true, voiceProfiles: 0 }, storage: { configured: true, libraryItems: 4 } });
    const tools = deriveOverview(f).contentTools;
    expect(tools?.voice?.text).toBe("No voice profile yet. Generated posts need one.");
    expect(tools?.voice?.action?.href).toBe("/p/acme/voice/new");
    expect(tools?.media?.text).toBe("4 images and videos");
  });

  it("tells editors who to ask and gives no action", () => {
    const f = facts({ ai: { configured: true, voiceProfiles: 0 } }, "editor");
    const voice = deriveOverview(f).contentTools?.voice;
    expect(voice?.text).toBe("No voice profile yet. Generated posts need one. Ask Ana to create one.");
    expect(voice?.action).toBeNull();
  });

  it("marks invite done via a member or a pending invitation", () => {
    const step = (over: Partial<OverviewFacts>) => deriveChecklist(facts({ ...done, ...over }))?.steps.find((s) => s.key === "invite");
    expect(step({ memberCount: 1 })?.status.kind).toBe("todo");
    expect(step({ memberCount: 2 })).toBeUndefined();
    expect(step({ memberCount: 1, pendingInvitations: 1 })).toBeUndefined();
  });

  it("keeps unfinished optional steps after collapse", () => {
    const f = facts({ ...done, memberCount: 1, ai: { configured: true, voiceProfiles: 0 } });
    const view = deriveChecklist(f);
    expect(view?.mode).toBe("collapsed");
    expect(view?.steps.map((s) => s.key)).toEqual(["voice", "invite"]);
  });
});

describe("step status transitions and tool lines (SC-004, SC-005)", () => {
  const done = { postCounts: { published: 1 }, accounts: [account({ slots: { active: 1, paused: 0 } })] };
  const step = (key: string, over: Partial<OverviewFacts>) => deriveChecklist(facts({ ...done, memberCount: 2, ...over }))?.steps.find((s) => s.key === key);

  it("flips the voice step todo to done with the profile count", () => {
    expect(step("voice", { ai: { configured: true, voiceProfiles: 0 } })?.status.kind).toBe("todo");
    expect(step("voice", { ai: { configured: true, voiceProfiles: 1 } })).toBeUndefined();
  });

  it("flips the media step todo, done, todo with the library count", () => {
    const at = (libraryItems: number) => step("media", { storage: { configured: true, libraryItems } });
    expect(at(0)?.status.kind).toBe("todo");
    expect(at(1)).toBeUndefined();
    expect(at(0)?.status.kind).toBe("todo");
  });

  it("describes populated voice and empty media for an owner", () => {
    const tools = deriveOverview(facts({ ai: { configured: true, voiceProfiles: 2 }, storage: { configured: true, libraryItems: 0 } })).contentTools;
    expect(tools?.voice).toEqual({ text: "2 voice profiles", action: { label: "Open voice profiles", href: "/p/acme/voice" } });
    expect(tools?.media).toEqual({ text: "No images or videos yet.", action: { label: "Upload images or videos", href: "/p/acme/media" } });
  });

  it("gives editors the same counts and a populated Coming up, with no attention section", () => {
    const upcoming = [{ id: "p1", excerpt: "p1", scheduledAt: new Date("2026-01-02T00:00:00Z"), accountNames: ["@acme"] }];
    expect(deriveComingUp(facts({ upcoming }, "editor")).kind).toBe("list");
    expect(deriveNeedsAttention(facts({}, "editor"))).toBeNull();
    expect(derivePostsByStatus(facts({}, "editor"))).toEqual({ kind: "empty", action: { label: "Write a post", href: "/p/acme/compose" } });
    const v = derivePostsByStatus(facts({ postCounts: { draft: 3 } }, "editor"));
    expect(v.kind).toBe("counts");
  });
});
