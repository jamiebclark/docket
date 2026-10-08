import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { createActivityRepo } from "../../../src/server/dal/activity";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { eventsFor } from "../../helpers/activity";
import { closeDb, testDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
import { createDueTarget, createMockAccount, parkAllDueTargets } from "../../helpers/scheduling";

beforeEach(parkAllDueTargets);
afterAll(closeDb);

const statements = readFileSync(resolve(__dirname, "../../../drizzle/0014_backfill_activity_events.sql"), "utf8")
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean);

// The migration spans every project, so it runs as a declared cross-project statement.
const runBackfill = () =>
  runCrossProject("test: run the 0013 backfill", async () => {
    for (const s of statements) await testDb().execute(sql.raw(s));
  });

const T = (n: number) => new Date(Date.UTC(2026, 8, 1, 10, n, 0, 123));

describe("backfill migration 0013", () => {
  it("writes one event per terminal target and needs-reauth account, once", async () => {
    const { project, owner } = await createProjectWithMembers();
    const repos = forSchedulerProject(project.id);
    const account = await createMockAccount(project.id, {});
    const seed = async (patch: Parameters<typeof repos.targets.update>[1], attempt?: { outcome: "fatal_error" | "account_unavailable" | "ambiguous" | "resolved_failed"; at: Date; error?: string }) => {
      const { target } = await createDueTarget(project.id, account.id);
      await repos.targets.update(target.id, { leaseOwner: null, leaseUntil: null, inFlightStep: null, inFlightMayPublish: null, nextAttemptAt: null, ...patch });
      if (attempt) await repos.attempts.insert({ postTargetId: target.id, step: "x", outcome: attempt.outcome, error: attempt.error ?? null, at: attempt.at });
      return target;
    };

    const published = await seed({ status: "published", externalId: "e1", publishedAt: T(1), externalUrl: "https://example.test/p/1" });
    const failed = await seed({ status: "failed", lastError: "Provider said no" }, { outcome: "fatal_error", at: T(2) });
    const engine = await seed({ status: "failed", lastError: "The account is no longer available for publishing." }, { outcome: "account_unavailable", at: T(3) });
    const resolved = await seed(
      { status: "failed", lastError: "Marked not published by a team member. Retry or schedule it.", resolvedAt: T(4), resolvedByUserId: owner.id },
      { outcome: "resolved_failed", at: T(4) },
    );
    const ambiguous = await seed({ status: "ambiguous", lastError: "x".repeat(600) }, { outcome: "ambiguous", at: T(5) });
    const live = await seed({ status: "published", externalId: "e6", publishedAt: T(6) });
    await createActivityRepo(testDb(), project.id).insert({
      kind: "target_published",
      occurredAt: T(7),
      postId: live.postId,
      postTargetId: live.id,
      socialAccountId: account.id,
      providerKey: "mock",
      message: "Published.",
      details: {},
    });
    const reauthAccount = await createMockAccount(project.id, {});
    await repos.accounts.markCredentialsInvalid(reauthAccount.id, { expectedCiphertext: null, reason: "Token expired" });

    await runBackfill();
    const first = await eventsFor(project.id);
    await runBackfill();
    expect(await eventsFor(project.id)).toHaveLength(first.length);

    const byTarget = new Map(first.filter((e) => e.postTargetId).map((e) => [e.postTargetId, e]));
    expect(first).toHaveLength(7); // 5 backfilled targets + 1 live + 1 account
    expect(byTarget.get(published.id)).toMatchObject({ kind: "target_published", message: "Published.", actorUserId: null, details: { backfilled: true, url: "https://example.test/p/1" } });
    expect(byTarget.get(published.id)!.occurredAt.toISOString()).toBe(T(1).toISOString());
    expect(byTarget.get(failed.id)).toMatchObject({ kind: "target_failed", message: "Provider said no", actorUserId: null });
    expect(byTarget.get(failed.id)!.occurredAt.toISOString()).toBe(T(2).toISOString());
    expect(byTarget.get(engine.id)!.occurredAt.toISOString()).toBe(T(3).toISOString());
    expect(byTarget.get(resolved.id)).toMatchObject({ kind: "target_failed", actorUserId: owner.id });
    expect(byTarget.get(resolved.id)!.occurredAt.toISOString()).toBe(T(4).toISOString());
    expect(byTarget.get(ambiguous.id)).toMatchObject({ kind: "target_ambiguous", outcome: "ambiguous" });
    expect(byTarget.get(ambiguous.id)!.message).toHaveLength(500);
    expect(byTarget.get(ambiguous.id)!.message.endsWith("…")).toBe(true);
    // A target that already has a live event gets no backfill row.
    expect(first.filter((e) => e.postTargetId === live.id)).toHaveLength(1);
    expect(byTarget.get(live.id)!.details).toEqual({});
    const reauth = first.find((e) => e.kind === "account_needs_reauth")!;
    expect(reauth).toMatchObject({ socialAccountId: reauthAccount.id, message: "Token expired", details: { backfilled: true } });
    for (const e of first) expect(e.occurredAt.getTime() % 1).toBe(0);
  });

  it("completes over a target whose link is too long to keep, dropping only the link", async () => {
    const { project } = await createProjectWithMembers();
    const repos = forSchedulerProject(project.id);
    const account = await createMockAccount(project.id, {});
    const { target } = await createDueTarget(project.id, account.id);
    await repos.targets.update(target.id, {
      leaseOwner: null, leaseUntil: null, inFlightStep: null, inFlightMayPublish: null, nextAttemptAt: null,
      status: "published", externalId: "e1", publishedAt: T(1), externalUrl: `https://example.test/${"a".repeat(2048 - 21)}`,
    });
    await runBackfill();
    const [event] = await eventsFor(project.id);
    expect(event).toMatchObject({ kind: "target_published", details: { backfilled: true } });
    expect(event!.details).not.toHaveProperty("url");
  });
});
