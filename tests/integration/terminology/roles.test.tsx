import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ resolved: null as unknown, mine: [] as unknown[] }));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  redirect: () => {
    throw new Error("redirect");
  },
}));
vi.mock("@/server/auth/session", () => ({
  getSession: async () => ({ user: { id: "u1", email: "a@example.com", name: "A" } }),
}));
vi.mock("@/server/services/invitations", () => ({
  resolveToken: async () => state.resolved,
  listMine: async () => state.mine,
}));
vi.mock("@/components/shell/SignedInHeader", () => ({ SignedInHeader: () => null }));
vi.mock("@/components/shell/actions", () => ({ signOut: async () => {} }));
vi.mock("../../../src/app/signup/actions", () => ({
  acceptInvitationByToken: async () => null,
  declineInvitationByToken: async () => null,
  signUpWithInvitation: async () => null,
}));
vi.mock("../../../src/app/invitations/actions", () => ({
  acceptInvitation: async () => null,
  declineInvitation: async () => null,
}));
vi.mock("../../../src/app/p/[projectSlug]/settings/members/actions", () => ({
  inviteMember: async () => null,
  regenerateInvitation: async () => null,
  revokeInvitation: async () => null,
}));

import InvitationsPage from "../../../src/app/invitations/page";
import SignupPage from "../../../src/app/signup/page";
import { InvitationsPanel } from "../../../src/app/p/[projectSlug]/settings/members/invitations-panel";
import { ROLE_OPTIONS, roleDescription, roleLabel } from "../../../src/lib/roles/roles";

const invite = (role: string) => ({
  id: "i1",
  email: "a@example.com",
  role,
  projectName: "Acme",
  inviterName: "Robin",
  expiresAt: new Date("2030-01-01T00:00:00Z"),
});

const panel = (canInviteOwner: boolean) =>
  renderToStaticMarkup(<InvitationsPanel slug="acme" invitations={[]} canInvite canInviteOwner={canInviteOwner} />);

describe("invite form", () => {
  it("owner sees three role cards with Editor checked", () => {
    const html = panel(true);
    for (const o of ROLE_OPTIONS) {
      expect(html).toContain(o.label);
      expect(html).toContain(o.description.replace(/'/g, "&#x27;"));
    }
    expect(html).toMatch(/value="editor"[^>]*checked|checked[^>]*value="editor"/);
  });

  it("admin sees only Editor and Admin", () => {
    const html = panel(false);
    expect(html).not.toContain('value="owner"');
    expect(html).toContain('value="admin"');
    expect(html).toContain('value="editor"');
  });
});

describe("signup page", () => {
  for (const state_ of ["signup", "login_required", "accept"]) {
    for (const role of ["editor", "admin", "owner"]) {
      it(`${state_} / ${role} names the role and describes it`, async () => {
        state.resolved = { state: state_, invitation: invite(role) };
        const html = renderToStaticMarkup(await SignupPage({ searchParams: Promise.resolve({ token: "t" }) }));
        expect(html).toContain(`<strong>${roleLabel(role)}</strong>`);
        expect(html).toContain((roleDescription(role) ?? "").replace(/'/g, "&#x27;"));
      });
    }
  }
});

describe("invitations page", () => {
  it("names an admin invitation and describes it", async () => {
    state.mine = [invite("admin")];
    const html = renderToStaticMarkup(await InvitationsPage());
    expect(html).toContain("<strong>Admin</strong>");
    expect(html).toContain(roleDescription("admin")!.replace(/'/g, "&#x27;"));
  });
});
