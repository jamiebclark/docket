import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);

import { GET as refresh } from "../../../src/app/api/me/notifications/route";
import { GET as recent } from "../../../src/app/api/me/notifications/recent/route";
import { actAs } from "../../helpers/actions";
import { closeDb } from "../../helpers/db";
import { addMember, createProject, createUser } from "../../helpers/factories";
import { recordEvent, startReading } from "../../helpers/notifications";

afterAll(async () => {
  actAs(null);
  await closeDb();
});

const HEADERS = { "cache-control": "private, no-store", vary: "Cookie", "content-type": "application/json" };

function expectHeaders(response: Response) {
  for (const [name, value] of Object.entries(HEADERS)) expect(response.headers.get(name)).toBe(value);
}

describe("GET /api/me/notifications and /recent", () => {
  it.each([
    ["refresh", refresh],
    ["recent", recent],
  ])("%s answers 401 without a session, including a request carrying only an API key", async (_name, handler) => {
    actAs(null); // an API key is never a session: getSession() finds nothing
    const response = await (handler as (r?: Request) => Promise<Response>)(
      new Request("http://docket.test/api/me/notifications", { headers: { authorization: "Bearer dk_live_example" } }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
    expectHeaders(response);
  });

  it("gives an empty summary and no_projects to someone in no project", async () => {
    const u = await createUser();
    actAs(u);
    const r1 = await refresh();
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ count: 0, display: "", label: "No unread problems" });
    expectHeaders(r1);
    const r2 = await recent();
    expect(await r2.json()).toEqual({ state: "no_projects", items: [], unread: { count: 0, display: "", label: "No unread problems" } });
    expectHeaders(r2);
  });

  it("returns at most 10 items newest first, with no details, and ignores crafted parameters", async () => {
    const p = await createProject({ name: "Alpha" });
    const stranger = await createProject({ name: "Hidden" });
    const u = await createUser();
    await addMember(p.id, u.id, "editor");
    await startReading(p.id, u.id);
    await startReading(stranger.id, u.id).catch(() => {});
    for (let i = 0; i < 12; i++) await recordEvent(p.id, "target_failed", { message: `Failure ${i}.` });
    await recordEvent(stranger.id, "target_failed", { message: "Not yours." });
    actAs(u);

    const summary = await (await refresh()).json();
    expect(summary).toEqual({ count: 12, display: "12", label: "12 unread problems" });

    // The handlers take no request, so a query naming another user or project cannot reach them.
    const response = await (recent as unknown as (r: Request) => Promise<Response>)(
      new Request(`http://docket.test/api/me/notifications/recent?userId=other&project=${stranger.slug}`),
    );
    const body = await response.json();
    expect(body.state).toBe("ok");
    expect(body.items).toHaveLength(10);
    expect(body.items.map((i: { message: string }) => i.message)).toEqual(Array.from({ length: 10 }, (_, i) => `Failure ${11 - i}.`));
    expect(body.items.every((i: { isNew: boolean }) => i.isNew)).toBe(true);
    expect(JSON.stringify(body)).not.toContain("Not yours.");
    for (const item of body.items) expect(Object.keys(item)).not.toContain("details");
    expect(body.unread.count).toBe(12);
  });

  it("never puts details, tokens or post text in the recent response", async () => {
    const p = await createProject({ name: "Quiet project" });
    const u = await createUser();
    await addMember(p.id, u.id, "editor");
    await startReading(p.id, u.id);
    // Event details are schema-validated, so a token cannot be stored there; the guard is on what the response may carry.
    await recordEvent(p.id, "target_failed", { message: "The platform refused it." });
    actAs(u);
    const body = await (await recent()).json();
    expect(body.items).toHaveLength(1);
    expect(Object.keys(body.items[0]).sort()).toEqual(
      ["accountName", "id", "isNew", "link", "message", "occurredAt", "outcome", "outcomeLabel", "platforms", "postDeleted", "project"].sort(),
    );
    const text = JSON.stringify(body).toLowerCase();
    for (const word of ["details", "token", "secret", "dk_live", "posttext", "attempt"]) expect(text).not.toContain(word);
  });
});
