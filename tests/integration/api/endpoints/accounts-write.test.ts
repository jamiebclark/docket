import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { runCrossProject } from "../../../../src/server/db/cross-project";
import { membershipAuditLog } from "../../../../src/server/db/schema";
import * as accountsService from "../../../../src/server/services/accounts";
import { api, world } from "../../../helpers/api";
import { closeDb, testDb } from "../../../helpers/db";

afterAll(closeDb);

const ACTION = "account_posting_instructions_update";
const auditRows = (projectId: string) =>
  runCrossProject("test", async () =>
    (await testDb().select().from(membershipAuditLog).where(eq(membershipAuditLog.projectId, projectId))).filter(
      (r) => r.action === ACTION,
    ),
  );

describe("PATCH /accounts/{accountId}", () => {
  it("sets posting instructions, audits them, and leaves an unchanged repeat with no second row", async () => {
    const w = await world();
    const r = await api("PATCH", `/accounts/${w.a.account.id}`, {
      key: w.a.keys.manageSetup.secret,
      body: { instructions: "Two hashtags max." },
    });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ accountId: w.a.account.id, postingInstructions: "Two hashtags max.", changed: true });

    const rows = await auditRows(w.a.project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toEqual({
      accountId: w.a.account.id,
      displayName: w.a.account.displayName,
      previous: null,
      next: "Two hashtags max.",
    });

    const list = await api("GET", "/accounts", { key: w.a.keys.read.secret });
    expect(list.json.data.find((a: { id: string }) => a.id === w.a.account.id).postingInstructions).toBe("Two hashtags max.");

    const repeat = await api("PATCH", `/accounts/${w.a.account.id}`, {
      key: w.a.keys.manageSetup.secret,
      body: { instructions: "Two hashtags max." },
    });
    expect(repeat.status).toBe(200);
    expect(repeat.json.changed).toBe(false);
    expect(await auditRows(w.a.project.id)).toHaveLength(1);
  });

  it("rejects over-length instructions quoting the 2,000 limit", async () => {
    const w = await world();
    const r = await api("PATCH", `/accounts/${w.a.account.id}`, {
      key: w.a.keys.manageSetup.secret,
      body: { instructions: "x".repeat(2001) },
    });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("validation_failed");
    expect(JSON.stringify(r.json.error.details)).toContain("2,000");
  });

  it("clears with an explicit empty string, and audits it", async () => {
    const w = await world();
    await api("PATCH", `/accounts/${w.a.account.id}`, { key: w.a.keys.manageSetup.secret, body: { instructions: "Set" } });
    const cleared = await api("PATCH", `/accounts/${w.a.account.id}`, { key: w.a.keys.manageSetup.secret, body: { instructions: "" } });
    expect(cleared.status).toBe(200);
    expect(cleared.json).toEqual({ accountId: w.a.account.id, postingInstructions: null, changed: true });
    expect(await auditRows(w.a.project.id)).toHaveLength(2);
  });

  it("rejects an unknown field", async () => {
    const w = await world();
    const r = await api("PATCH", `/accounts/${w.a.account.id}`, {
      key: w.a.keys.manageSetup.secret,
      body: { instructions: "ok", extra: true },
    });
    expect(r.status).toBe(400);
  });

  it("answers byte-identical 404s for another project's account id, a removed account and a random UUID", async () => {
    const w = await world();
    const random = "00000000-0000-4000-8000-0000000000ab";
    const removed = await accountsService.connectMock(w.a.scope, { displayName: `A ${Math.random().toString(36).slice(2, 7)}` });
    await accountsService.removeAccount(w.a.scope, removed.id);
    const other = await api("PATCH", `/accounts/${w.b.account.id}`, { key: w.a.keys.manageSetup.secret, body: { instructions: "ok" } });
    const unknown = await api("PATCH", `/accounts/${random}`, { key: w.a.keys.manageSetup.secret, body: { instructions: "ok" } });
    const removedResult = await api("PATCH", `/accounts/${removed.id}`, { key: w.a.keys.manageSetup.secret, body: { instructions: "ok" } });
    expect(other.status).toBe(404);
    expect(removedResult.status).toBe(404);
    const strip = (r: typeof other) => ({ code: r.json.error.code, message: r.json.error.message, details: r.json.error.details });
    expect(strip(other)).toEqual(strip(unknown));
    expect(strip(removedResult)).toEqual(strip(unknown));
  });

  it("answers 403 for a key lacking manage_setup", async () => {
    const w = await world();
    const r = await api("PATCH", `/accounts/${w.a.account.id}`, { key: w.a.keys.read.secret, body: { instructions: "ok" } });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("missing_permission");
  });

  it("replays the stored response for a repeated Idempotency-Key", async () => {
    const w = await world();
    const body = { instructions: "Replay me" };
    const first = await api("PATCH", `/accounts/${w.a.account.id}`, { key: w.a.keys.manageSetup.secret, idem: "pi-1", body });
    expect(first.status).toBe(200);
    const replayed = await api("PATCH", `/accounts/${w.a.account.id}`, { key: w.a.keys.manageSetup.secret, idem: "pi-1", body });
    expect(replayed.status).toBe(200);
    expect(replayed.headers.get("idempotent-replayed")).toBe("true");
    expect(replayed.json).toEqual(first.json);
  });
});
