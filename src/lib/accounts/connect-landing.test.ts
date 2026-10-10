import { describe, expect, it } from "vitest";
import { classifyConnect, landingHref, landingMessage, LANDING_MAX, parseLanding } from "./connect-landing";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("classifyConnect", () => {
  it("is null when nothing was saved", () => {
    expect(classifyConnect([], new Set())).toBeNull();
  });
  it("lands new accounts on the slots", () => {
    expect(classifyConnect([{ id: A }], new Set())).toEqual({ accountId: A, target: "slots", connected: 1, reconnected: 0 });
  });
  it("lands refreshed accounts on the card", () => {
    expect(classifyConnect([{ id: A }], new Set([A]))).toEqual({ accountId: A, target: "card", connected: 0, reconnected: 1 });
  });
  it("picks the first new account in a mix", () => {
    expect(classifyConnect([{ id: A }, { id: B }], new Set([A]))).toEqual({ accountId: B, target: "slots", connected: 1, reconnected: 1 });
  });
});

describe("landingHref / parseLanding", () => {
  it("builds slots and card hrefs and round-trips through parseLanding", () => {
    const slots = landingHref("acme", { accountId: A, target: "slots", connected: 2, reconnected: 1 });
    expect(slots).toBe(`/p/acme/accounts?landed=${A}&connected=2&reconnected=1#account-${A}-slots`);
    expect(landingHref("acme", { accountId: A, target: "card", connected: 0, reconnected: 1 })).toMatch(new RegExp(`#account-${A}$`));
    const q = Object.fromEntries(new URL(slots, "http://x").searchParams);
    expect(parseLanding(q)).toEqual({ accountId: A, connected: 2, reconnected: 1 });
  });
  it("encodes the slug", () => {
    expect(landingHref("a b/c", { accountId: A, target: "card", connected: 0, reconnected: 1 })).toMatch(/^\/p\/a%20b%2Fc\/accounts\?/);
  });
  it("rejects missing, repeated, malformed and out-of-range input", () => {
    const ok = { landed: A, connected: "1", reconnected: "0" };
    expect(parseLanding(ok)).not.toBeNull();
    expect(parseLanding(undefined)).toBeNull();
    expect(parseLanding({})).toBeNull();
    expect(parseLanding({ ...ok, landed: undefined })).toBeNull();
    expect(parseLanding({ ...ok, landed: [A, B] })).toBeNull();
    expect(parseLanding({ ...ok, connected: ["1", "2"] })).toBeNull();
    expect(parseLanding({ ...ok, landed: "not-a-uuid" })).toBeNull();
    expect(parseLanding({ ...ok, connected: "0", reconnected: "0" })).toBeNull();
    expect(parseLanding({ ...ok, connected: String(LANDING_MAX + 1) })).toBeNull();
    expect(parseLanding({ ...ok, connected: "-1" })).toBeNull();
    expect(parseLanding({ ...ok, connected: "1.5" })).toBeNull();
    expect(parseLanding({ ...ok, connected: "abc" })).toBeNull();
    expect(parseLanding({ ...ok, connected: String(LANDING_MAX) })).not.toBeNull();
  });
});

describe("landingMessage", () => {
  const cases: [number, number, string][] = [
    [1, 0, "Connected @a. Add posting slots so Add to queue can schedule it."],
    [3, 0, "Connected 3 accounts. Add posting slots for each."],
    [0, 1, "Reconnected @a."],
    [0, 4, "Reconnected 4 accounts."],
    [1, 1, "Connected @a and reconnected 1 account. Add posting slots so Add to queue can schedule it."],
    [1, 2, "Connected @a and reconnected 2 accounts. Add posting slots so Add to queue can schedule it."],
    [2, 3, "Connected 2 accounts and reconnected 3. Add posting slots for each new account."],
  ];
  it.each(cases)("connected %i reconnected %i", (connected, reconnected, text) => {
    expect(landingMessage({ connected, reconnected }, "@a")).toBe(text);
  });
});
