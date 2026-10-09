import { describe, expect, it } from "vitest";
import { calendarState } from "./calendar";

const base = {
  slug: "p",
  hasContent: false,
  canManageAccounts: true,
  canManageSlots: true,
  managersToAsk: "Robin or Sam",
  todayHref: "/p/p/calendar?date=2026-10-09",
};
const acct = (active: number, providerAvailable = true) => ({ accountId: "a1", providerAvailable, active });

describe("calendarState", () => {
  it("no_accounts: manager gets the connect action, editor is told who to ask", () => {
    expect(calendarState({ ...base, accounts: [] })).toMatchObject({
      kind: "no_accounts",
      action: { label: "Connect an account", href: "/p/p/accounts#add-account" },
    });
    expect(calendarState({ ...base, accounts: [], canManageAccounts: false, canManageSlots: false })).toEqual({
      kind: "no_accounts",
      message: "No accounts yet. Ask Robin or Sam to connect one.",
      action: null,
    });
  });

  it("no_slots replaces the grid when empty, and is a line when there is content", () => {
    const m = calendarState({ ...base, accounts: [acct(0)] });
    expect(m).toMatchObject({ kind: "no_slots", action: { href: "/p/p/accounts#account-a1-slots" } });
    expect(calendarState({ ...base, accounts: [acct(0)], hasContent: true }).kind).toBe("no_slots_line");
    const e = calendarState({ ...base, accounts: [acct(0, false)], canManageSlots: false });
    expect(e).toEqual({ kind: "no_slots", message: "No posting slots yet. Ask Robin or Sam to add some.", action: null });
    expect(calendarState({ ...base, accounts: [acct(0)], canManageSlots: false, hasContent: true }).kind).toBe("no_slots_line");
  });

  it("empty_period offers Today to everyone", () => {
    for (const canManageSlots of [true, false]) {
      expect(calendarState({ ...base, accounts: [acct(2)], canManageSlots })).toEqual({
        kind: "empty_period",
        message: "No posts or open posting slots in this period.",
        action: { label: "Today", href: base.todayHref },
      });
    }
  });

  it("content otherwise", () => {
    expect(calendarState({ ...base, accounts: [acct(1)], hasContent: true })).toEqual({ kind: "content" });
    expect(calendarState({ ...base, accounts: [acct(1)], hasContent: true, canManageSlots: false })).toEqual({ kind: "content" });
  });
});
